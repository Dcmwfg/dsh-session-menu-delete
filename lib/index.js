/**
 * dsh-session-menu-delete — host half.
 *
 * 一个只监听回环地址的 HTTP 路由，给浏览器半用：
 *
 *   POST /api/dsh-session-menu-delete/delete   { sessionId }
 *   GET  /api/dsh-session-menu-delete/health
 *
 * 为什么要有宿主半：会话日志在磁盘上（$DSH_HOME/sessions/<workspaceKey>/<id>/
 * session[.vN].jsonl[.zstd]），浏览器拿不到文件系统。持久化 seam 又没有删除接口
 * （dsh-session-persistence-jsonl 的 README 明确写「不删除会话文件」），所以
 * 只能由宿主进程自己动磁盘。
 *
 * 删除分三步：
 *   1. 会话还活在内存里（ctx.sessions / ctx.agents 有它）就先摘掉：sessions.liveEntryFor()
 *      拿到 entry 再 detachEntered()，会发 session/disposed → api-session/removed；
 *   2. 删会话目录 + 投影缓存 <DSH_HOME>/storages/session_projcache/sessions/<id>.json；
 *   3. ctx.emit('api-session/removed', id) 让每个已连接的客户端把那一行从列表快照里摘掉。
 *
 * 第 3 步不是可选项：宿主不会因为文件没了就推事件，客户端只会在重连时重拉列表。
 * 发射源在 dsh-api-session-controller/lib/index.js:2983（session/disposed → api-session/removed），
 * 插件自己 emit 同一个事件即可，客户端 handleSessionRemoved 走 recordMutation({kind:'remove'})。
 *
 * 第 2 步有个坑：投影缓存服务监听 session/disposed，会 fire-and-forget 补写一次
 * checkpoint（flushSoft(session,'detach')），它的写入走 storage-domain 异步写链，
 * 可能晚于我们的 unlink 落地，于是文件又冒出来。所以删完要等一下再补删，
 * 并把缓存服务里那条记录一并 delete 掉（连带清内存副本）。
 */
import { existsSync, readdirSync, rmdirSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-session-menu-delete'
export const inject = ['webServer']

const VERSION = '0.1.1'
const BASE = '/api/dsh-session-menu-delete'
// 会话日志的文件名跟着 Session 格式版本走：v0 是 session.jsonl，vN 是 session.vN.jsonl，
// 压缩（默认 zstd）再加 .zstd 后缀。宿主自己也是「扫目录、取版本号最大的那个」
// （dsh-session-persistence-jsonl 的 resolveGenerationInDirectory），所以我们照做，
// 不写死 v4 —— 否则老会话（v3）删不掉，将来框架升到 v5 也立刻失效。
const SESSION_LOG_RE = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$/u
// 会话目录名有两种形态：裸 UUID，以及「新会话」未命名时落盘的 session-<uuid>。
const SESSION_ID_RE = /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

function json(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

/** 整个 127.0.0.0/8 都是回环，不只 127.0.0.1；IPv6 是 ::1，IPv4-mapped 形式也行。 */
function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  if (address === '::1') return true
  const mapped = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(mapped)) return true
  return false
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost') return true
  // URL 的 hostname 对 IPv6 保留方括号（'[::1]'），剥掉再判。
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  return isLoopbackAddress(bare)
}

/**
 * Loopback-only fence, same shape DSH uses for its own API: loopback socket,
 * loopback Host header, no cross-site fetch, and an Origin that (when present)
 * equals this server.
 *
 * DSH 自己也允许 trustedHosts（自定义域名映射到本机）——那种情况下浏览器发来的
 * Host 不是回环字面量，只认字面量会让「删除会话」永远 403。所以额外放行
 * 「Host 等于本服务自己的 origin」这一种，socket 仍必须是回环：
 *   - 自定义域名指向 127.0.0.1 的用户能正常用；
 *   - 绑定到非回环地址 / 从别的机器访问的，仍然一律拒绝。
 * 这里只做浏览器侧护栏，真正的鉴权由 DSH 的 cookie 层负责，本路由不额外开口子。
 */
export function trusted(req, allowedHosts) {
  const address = req.socket?.remoteAddress
  if (!isLoopbackAddress(address)) return false
  const { host, origin, 'sec-fetch-site': secFetchSite } = req.headers
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  const hostname = hostUrl.hostname
  let hostOk = isLoopbackHostname(hostname)
  if (!hostOk && allowedHosts instanceof Set) {
    hostOk = allowedHosts.has(hostname) || allowedHosts.has(hostUrl.host)
  }
  if (!hostOk) return false
  if (secFetchSite === 'cross-site') return false
  if (origin === undefined) return true
  if (typeof origin !== 'string' || origin === 'null') return false
  try {
    const originUrl = new URL(origin)
    return originUrl.host === hostUrl.host && originUrl.protocol === hostUrl.protocol
  } catch {
    return false
  }
}

/**
 * 本服务自己的 host 名集合，用来放行 trustedHosts 场景。
 * getOrigin() 拿不到时退回空集合 —— 行为等价于只认回环字面量。
 */
function serverHostNames(webServer) {
  const hosts = new Set()
  try {
    const raw = typeof webServer?.getOrigin === 'function' ? webServer.getOrigin() : undefined
    if (typeof raw === 'string' && raw !== '') {
      const url = new URL(raw)
      hosts.add(url.hostname)
      hosts.add(url.host)
      if (url.port !== '') hosts.add(url.hostname + ':' + url.port)
    }
  } catch {
    /* 拿不到就只认回环 */
  }
  return hosts
}

/**
 * 桌面主进程里 process.env.DSH_HOME 是空的（Electron 主进程没有把这个变量传下来），
 * 所以按候选顺序逐个探测，用「目录里含 sessions / storages / profiles 之一」做校验。
 * 这段逻辑与 dsh-conversation-manager/lib/cleanup.js:32 一致，纯本地判定。
 */
export function resolveDshHome(injected) {
  const candidates = []
  if (typeof injected === 'string' && injected !== '') candidates.push(injected)
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '') candidates.push(process.env.DSH_HOME)
  if (typeof process.env.DSH_HOME_DIR === 'string' && process.env.DSH_HOME_DIR !== '') candidates.push(process.env.DSH_HOME_DIR)
  try {
    candidates.push(join(homedir(), '.dsh'))
  } catch {
    /* homedir 不可用时只剩前几个候选 */
  }
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue
      if (!statSync(candidate).isDirectory()) continue
      if (existsSync(join(candidate, 'sessions')) || existsSync(join(candidate, 'storages')) || existsSync(join(candidate, 'profiles'))) {
        return candidate
      }
    } catch {
      /* 下一个候选 */
    }
  }
  return null
}

/**
 * 递归删除目录。
 *
 * 不用 rmSync：在这台机器的 Node 24 / Windows 组合下，rmSync(dir, {recursive:true})
 * 会返回成功但目录原地不动（实测 existsSync 仍为 true、readdirSync 仍列得出来）。
 * 显式走 readdir → unlink → rmdir 是同一份 Node API 里可靠的那条路。
 */
function removeTree(dirPath) {
  let entries
  try {
    entries = readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const child = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      removeTree(child)
      continue
    }
    try {
      unlinkSync(child)
    } catch {
      /* 只读属性之类的极端情况：再试一次去掉只读 */
      try {
        statSync(child)
        unlinkSync(child)
      } catch {
        /* 放弃这一项，让上层看到目录还在 */
      }
    }
  }
  try {
    rmdirSync(dirPath)
  } catch {
    /* 上层会据 existsSync 报告真实结果 */
  }
}

function sessionsRoot(dshHome) {
  return join(dshHome, 'sessions')
}

function projCacheRoot(dshHome) {
  return join(dshHome, 'storages', 'session_projcache', 'sessions')
}

/**
 * 投影缓存文件的候选路径：<id>.json 与 session-<id>.json。
 * 实测本机 297 个会话里有 50 个缓存名带 session- 前缀，所以不能只认一种。
 */
export function cacheVariants(dshHome, sessionId) {
  const root = projCacheRoot(dshHome)
  const ids = sessionId.startsWith('session-')
    ? [sessionId, sessionId.slice('session-'.length)]
    : [sessionId, 'session-' + sessionId]
  return ids.map((id) => join(root, id + '.json'))
}

/**
 * 判断一个目录里有没有会话日志。宿主的规则是「同一目录里取版本号最大的 canonical
 * generation」（dsh-session-persistence-jsonl 的 resolveGenerationInDirectory），
 * 这里只要判断存在，不参与版本选择——反正整个目录都要删掉。
 */
export function hasSessionLog(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return false
  }
  return names.some((name) => SESSION_LOG_RE.test(name))
}

/**
 * 会话目录按 workspaceKey 分桶：sessions/<workspaceKey>/<sessionId>/。逐个桶找。
 *
 * 目录名有两种形态：裸 UUID 与 session-<uuid>。宿主侧的 sessionId 一般与目录名
 * 完全一致（实测 297 个目录里 49 个带前缀，projcache 同名命中 48 个，剥前缀命中 0），
 * 所以先按精确名找。但不同 DSH 版本的 id 归一化策略未必一样，精确找不到时
 * 再试一次「带/不带前缀」的另一种形态——同一个 uuid 的两种写法，指向同一个
 * 会话，不会误删别的。
 */
export function locateSessionDir(dshHome, sessionId) {
  const root = sessionsRoot(dshHome)
  let keys
  try {
    keys = readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  const forms = [sessionId]
  if (sessionId.startsWith('session-')) forms.push(sessionId.slice('session-'.length))
  else forms.push('session-' + sessionId)
  for (const entry of keys) {
    if (!entry.isDirectory()) continue
    for (const form of forms) {
      const dir = join(root, entry.name, form)
      try {
        if (!statSync(dir).isDirectory()) continue
        if (!hasSessionLog(dir)) continue
        return dir
      } catch {
        /* 不是这个桶 */
      }
    }
  }
  return null
}

/**
 * 永久删除一个会话。只处理冷会话：live 的拒绝（删了目录，进程里还挂着的
 * 那个 session 会在下次 flush 时把日志写回来，等于删了个寂寞）。
 */
export async function deleteSession(ctx, dshHome, sessionId) {
  // 注意：必须用 ctx.get() 而不是 ctx.sessions——后者的属性读取受 inject 门控，
  // inject 里没有 'sessions' 时会直接抛异常，被 safe() 吞掉就变成「永远不判定为 live」，
  // 结果把正在运行的会话目录删了、内存里还挂着，列表永远删不掉这一行。
  const sessions = safe(() => ctx.get?.('sessions'))
  const agents = safe(() => ctx.get?.('agents'))
  const liveSession = liveWhere(sessions, sessionId)
  const liveAgent = liveWhere(agents, sessionId)
  if (liveSession || liveAgent) {
    const detached = detachLive(sessions, agents, sessionId)
    if (!detached) {
      return { ok: false, status: 409, reason: 'live', error: '这个会话正在运行，没能安全下线，先关掉它再删。' }
    }
    // session/disposed 会让 persistence 的 writer.close() 去 drain 缓存事件。
    // 不等它写完就删目录，最后一批日志可能被重新落盘。0.8s 足够本地写完。
    await delay(800)
  }

  const dir = locateSessionDir(dshHome, sessionId)
  // 投影缓存同样可能带 session- 前缀，两种形态都查。
  const cacheFiles = cacheVariants(dshHome, sessionId).filter((file) => existsSync(file))
  const hadCache = cacheFiles.length > 0
  // 目录没找到、只剩下缓存：这不是「删成功」，是「只删了一半」——只删缓存会让
  // 会话行在下次刷新时又冒回来，却报个 200。宁可报 500 让人看一眼。
  if (dir === null && !hadCache) {
    return { ok: false, status: 404, reason: 'missing', error: '磁盘上找不到这个会话（可能已经被删了）。' }
  }
  if (dir === null) {
    return {
      ok: false,
      status: 500,
      reason: 'partial',
      error: '会话目录没找到（可能工作区桶名不同或已被移走），只看到投影缓存；先别当它删干净了。',
      removed: [],
    }
  }

  const removed = []
  removeTree(dir)
  if (!existsSync(dir)) removed.push(dir)
  for (const file of cacheFiles) {
    try {
      unlinkSync(file)
    } catch {
      /* 上层按 existsSync 报告 */
    }
    if (!existsSync(file)) removed.push(file)
  }
  if (existsSync(dir)) {
    return { ok: false, status: 500, reason: 'partial', error: '删到一半：会话目录还在，检查文件是否被占用。', removed }
  }

  // 投影缓存会在会话 dispose 时异步回写一次 checkpoint（见
  // @deepseek-ai/dsh-session-projection-cache 的 installWritePath：session/disposed
  // → flushSoft(session,'detach')）。它的写入走 storage-domain 的写链，可能比
  // 我们上面的 unlink 更晚落地，于是文件又冒出来。这里等它落完再说：补删文件、
  // 顺手把缓存服务里这条记录也摘掉（连带清掉内存副本，防止下一次写回）。
  await settleProjectionCache(ctx, cacheFiles, sessionId)
  const cacheLeft = cacheVariants(dshHome, sessionId).filter((file) => existsSync(file))
  if (cacheLeft.length > 0) {
    return { ok: false, status: 500, reason: 'partial', error: '会话目录已删，但投影缓存还在，检查文件是否被占用。', removed }
  }

  // 工作区记录里还留着这个 id 也没关系：客户端 deriveFlat 遇到 list.byId[id]
  // 缺失就跳过那一行。但顺手 detach 更干净，失败也不影响主流程。
  try {
    const registry = ctx.workspaceRegistry ?? ctx.get?.('workspaceRegistry')
    if (registry !== undefined && registry !== null && typeof registry.detachSession === 'function') {
      void Promise.resolve(registry.detachSession(sessionId)).catch(() => {})
    }
  } catch {
    /* 尽力而为 */
  }

  // 让已连接的客户端立刻把这一行摘掉。客户端 handleSessionRemoved 会
  // recordMutation({kind:'remove'})，不必等重连。
  try {
    ctx.emit('api-session/removed', sessionId)
  } catch {
    /* 事件发不出去也不影响磁盘结果 */
  }

  return { ok: true, status: 200, sessionId, removed }
}

/**
 * 把一个 live 会话从内存注册表里摘掉，让它立刻从 sessionQuery.listSessions() 消失。
 * 先摘 session（发 session/disposed → api-session/removed，客户端把那行 remove），
 * 再摘 agent——顺序反过来时 agent/disposed 见 sessions 里还有它，会重新广播 added。
 */
function detachLive(sessions, agents, sessionId) {
  let ok = false
  try {
    const session = sessions?.get?.(sessionId)
    if (session !== undefined && session !== null) {
      let entry
      try {
        entry = sessions.liveEntryFor(session)
      } catch {
        /* 不在 live 表里 */
      }
      if (entry !== undefined) {
        sessions.detachEntered(entry)
        ok = sessions.get?.(sessionId) === undefined
      }
    }
  } catch {
    /* 尽力而为 */
  }
  try {
    const agent = agents?.get?.(sessionId)
    if (agent !== undefined && agent !== null) {
      const entry = agents.store?.get?.(sessionId)
      if (entry !== undefined) {
        agents.detachEntered(entry)
        ok = agents.get?.(sessionId) === undefined
      }
    }
  } catch {
    /* 尽力而为 */
  }
  return ok
}

/**
 * 等投影缓存的 disposed 写回落完，并把缓存服务里这条记录摘干净。
 *
 * 背景：会话 detach 时 sessionProjectionCache 会 fire-and-forget 地写一次
 * checkpoint（session/disposed → flushSoft）。那个 put 走 storage-domain 的
 * 异步写链，可能晚于我们的 unlink 落地，于是刚删掉的 <id>.json 又出现。
 * 处理分两段：先等一拍让它写完，再删文件；最后用表接口 delete(id) 把内存
 * 副本一起摘掉，避免后续任何 flush 再从内存写回。
 */
async function settleProjectionCache(ctx, cacheFiles, sessionId) {
  // 写链落地后再删，多给两拍：flushSoft 内部还有 sessions.flush 的 await。
  await delay(400)
  for (const cacheFile of cacheFiles) {
    if (existsSync(cacheFile)) {
      try {
        unlinkSync(cacheFile)
      } catch {
        /* 上层按 existsSync 报告 */
      }
    }
  }
  // 内存副本还在的话，下一次 flush 会把文件重新写出来。
  const cache = safe(() => ctx.get?.('sessionProjectionCache'))
  const table = safe(() => cache?.table)
  if (table !== undefined && table !== null && typeof table.delete === 'function') {
    try {
      await table.delete(sessionId)
    } catch {
      /* 尽力而为：文件已经删了，内存副本最多让它在下次 flush 重写一次 */
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function liveWhere(service, sessionId) {
  try {
    return typeof service?.get === 'function' ? service.get(sessionId) !== undefined : false
  } catch {
    return false
  }
}

function safe(fn) {
  try {
    return fn()
  } catch {
    return undefined
  }
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

export function apply(ctx, config) {
  const allowedHosts = serverHostNames(ctx.webServer)
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: BASE,
    handler: (req, res) => {
      let sub = '/'
      try {
        const url = new URL(req.url ?? '/', 'http://x')
        sub = url.pathname.slice(BASE.length).replace(/\/+$/u, '') || '/'
      } catch {
        /* keep '/' */
      }

      if (sub === '/health') {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
        try {
          json(res, 200, { ok: true, version: VERSION, home: resolveDshHome(config?.dshHome), pid: process.pid, hosts: [...allowedHosts] })
        } catch (error) {
          json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
        return
      }

      if (sub !== '/delete') return json(res, 404, { ok: false, error: `no dsh-session-menu-delete endpoint ${sub}` })
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
      if (!trusted(req, allowedHosts)) return json(res, 403, { ok: false, error: 'forbidden: untrusted delete request' })

      void (async () => {
        try {
          const body = await readBody(req)
          const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
          if (!SESSION_ID_RE.test(sessionId)) {
            return json(res, 400, { ok: false, error: 'sessionId 不是合法的 uuid' })
          }
          const home = resolveDshHome(config?.dshHome)
          if (home === null) {
            return json(res, 500, { ok: false, error: '找不到 DSH_HOME（sessions / storages / profiles 都不存在）' })
          }
          const result = await deleteSession(ctx, home, sessionId)
          json(res, result.status ?? 500, result)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          json(res, 500, { ok: false, error: message })
        }
      })()
    },
  }), 'dsh-session-menu-delete: /api/dsh-session-menu-delete routes')
}

// Cordis 读的是 default 上的 inject，裸 apply 会抛 "cannot get property webServer without inject"。
export default { name, inject, apply }