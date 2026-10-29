/**
 * 自检：不碰真实 DSH 数据，用临时假 home 验证宿主半的三个函数。
 *   node scripts/selftest.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { deleteSession, locateSessionDir, resolveDshHome, trusted } from '../lib/index.js'

const failures = []
function ok(label, condition, extra) {
  if (condition) {
    console.log('PASS ' + label)
  } else {
    failures.push(label + (extra ? ' — ' + extra : ''))
    console.log('FAIL ' + label + (extra ? ' — ' + extra : ''))
  }
}

const home = mkdtempSync(join(tmpdir(), 'dsmd-'))
const sessionId = '0057fcfa-eb7f-46d1-acb0-8276b10fd0d2'
const otherId = '11111111-2222-4333-8444-555555555555'
const key = '--E-hhh--'
const dir = join(home, 'sessions', key, sessionId)
const cacheFile = join(home, 'storages', 'session_projcache', 'sessions', sessionId + '.json')
mkdirSync(dir, { recursive: true })
mkdirSync(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
writeFileSync(join(dir, 'session.v4.jsonl.zstd'), 'x')
writeFileSync(cacheFile, '{}')
// 第二个会话：只用来确认没被误删
const otherDir = join(home, 'sessions', key, otherId)
mkdirSync(otherDir, { recursive: true })
writeFileSync(join(otherDir, 'session.v4.jsonl.zstd'), 'y')

ok('resolveDshHome 认临时 home', resolveDshHome(home) === home)
ok('locateSessionDir 找到会话目录', locateSessionDir(home, sessionId) === dir)
ok('locateSessionDir 对不存在的 id 返回 null', locateSessionDir(home, '99999999-9999-4999-8999-999999999999') === null)

const emitted = []
const ctx = {
  sessions: { get: () => undefined },
  agents: { get: () => undefined },
  emit: (event, id) => emitted.push([event, id]),
}

const result = await deleteSession(ctx, home, sessionId)
ok('deleteSession 返回 ok', result.ok === true, JSON.stringify(result))
ok('会话目录已删', existsSync(dir) === false)
ok('投影缓存已删', existsSync(cacheFile) === false)
ok('广播了 api-session/removed', emitted.length === 1 && emitted[0][0] === 'api-session/removed' && emitted[0][1] === sessionId, JSON.stringify(emitted))
ok('别的会话没被动', existsSync(join(otherDir, 'session.v4.jsonl.zstd')) === true)

// 真插件里这些服务只能通过 ctx.get(name) 拿（inject 门控下 ctx.sessions 会抛），
// 所以假 ctx 也必须走 get()，否则测的是一条走不到的分支。
const liveCtx = {
  get: (serviceName) => {
    if (serviceName === 'sessions') {
      return { get: (id) => (id === otherId ? { id } : undefined), liveEntryFor: () => { throw new Error('not live') } }
    }
    if (serviceName === 'agents') return { get: () => undefined }
    if (serviceName === 'workspaceRegistry') return { detachSession: async () => {} }
    return undefined
  },
  emit: () => { throw new Error('live 路径不该广播') },
}
const liveResult = await deleteSession(liveCtx, home, otherId)
ok('live 会话摘不掉时被拒绝', liveResult.ok === false && liveResult.reason === 'live', JSON.stringify(liveResult))
ok('live 会话目录还在', existsSync(join(otherDir, 'session.v4.jsonl.zstd')) === true)

// live 会话可正常摘除 + 删除
const detachedIds = []
const liveOkSession = { id: otherId }
const liveOkCtx = {
  get: (serviceName) => {
    if (serviceName === 'sessions') {
      let live = true
      return {
        get: (id) => (live && id === otherId ? liveOkSession : undefined),
        liveEntryFor: () => ({ id: otherId }),
        detachEntered: () => { live = false; detachedIds.push('session') },
      }
    }
    if (serviceName === 'agents') return { get: () => undefined }
    if (serviceName === 'workspaceRegistry') return { detachSession: async () => {} }
    return undefined
  },
  emit: () => {},
}
const liveOkResult = await deleteSession(liveOkCtx, home, otherId)
ok('live 会话能摘能删', liveOkResult.ok === true && detachedIds.includes('session'), JSON.stringify(liveOkResult))
ok('live 会话目录已删', existsSync(join(otherDir, 'session.v4.jsonl.zstd')) === false)

const missing = await deleteSession(ctx, home, '99999999-9999-4999-8999-999999999999')
ok('不存在的会话报 404', missing.ok === false && missing.status === 404, JSON.stringify(missing))

// 日志文件名兼容：宿主按 generation 与压缩方式生成名字，不能只认 session.v4.jsonl.zstd。
// v0 → session.jsonl；vN → session.vN.jsonl；压缩（默认 zstd）再加 .zstd。
// 顺带确认「没有任何日志的杂项目录」不会被当成会话。
const genKey = '--E-gen--'
for (const [label, logName] of [
  ['v0 无版本号', 'session.jsonl'],
  ['v2 无压缩', 'session.v2.jsonl'],
  ['v3 zstd', 'session.v3.jsonl.zstd'],
  ['v7 zstd（未来版本）', 'session.v7.jsonl.zstd'],
]) {
  const id = randomUUID()
  const sessionDir = join(home, 'sessions', genKey, id)
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(join(sessionDir, logName), 'x')
  const found = locateSessionDir(home, id)
  ok('locateSessionDir 认得 ' + label, found === sessionDir, String(found))
  const gone = await deleteSession(ctx, home, id)
  ok('deleteSession 删得掉 ' + label, gone.ok === true && existsSync(sessionDir) === false, JSON.stringify(gone))
}
const strayId = randomUUID()
mkdirSync(join(home, 'sessions', genKey, strayId, 'attachments'), { recursive: true })
ok('没有日志的目录不算会话', locateSessionDir(home, strayId) === null)

// 目录名两种形态互认：本机 297 个真实目录里 49 个是 session-<uuid>。
// 传裸 uuid 要能找到 session-<uuid>，反之亦然 —— 否则只删掉缓存却报成功。
const prefixKey = '--E-prefix--'
const prefixId = randomUUID()
const prefixDir = join(home, 'sessions', prefixKey, 'session-' + prefixId)
mkdirSync(prefixDir, { recursive: true })
writeFileSync(join(prefixDir, 'session.v4.jsonl.zstd'), 'x')
ok('裸 uuid 能找到 session- 前缀目录', locateSessionDir(home, prefixId) === prefixDir, String(locateSessionDir(home, prefixId)))
ok('带前缀的 uuid 也能找到同目录', locateSessionDir(home, 'session-' + prefixId) === prefixDir)
// 缓存名同样两种形态
const prefCache = join(home, 'storages', 'session_projcache', 'sessions', 'session-' + prefixId + '.json')
writeFileSync(prefCache, '{}')
const prefGone = await deleteSession(ctx, home, prefixId)
ok('deleteSession 删得掉 session- 前缀会话', prefGone.ok === true && existsSync(prefixDir) === false && existsSync(prefCache) === false, JSON.stringify(prefGone))

// 只剩缓存、目录没了：必须报 partial(500)，不能报 200。
const orphanId = randomUUID()
const orphanCache = join(home, 'storages', 'session_projcache', 'sessions', orphanId + '.json')
writeFileSync(orphanCache, '{}')
const orphanResult = await deleteSession(ctx, home, orphanId)
ok('只剩缓存时报 partial 而不是 ok', orphanResult.ok === false && orphanResult.status === 500 && orphanResult.reason === 'partial', JSON.stringify(orphanResult))
ok('只剩缓存时不偷偷删缓存', existsSync(orphanCache) === true)
rmSync(orphanCache, { force: true })

rmSync(home, { recursive: true, force: true })

// trusted()：最小 req 形状
ok('trusted 拒绝非回环 socket', trusted({ socket: { remoteAddress: '10.0.0.2' }, headers: { host: '127.0.0.1:7953' } }) === false)
ok('trusted 接受回环 + 回环 Host', trusted({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:7953' } }) === true)
ok('trusted 拒绝 cross-site', trusted({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:7953', 'sec-fetch-site': 'cross-site' } }) === false)
ok('trusted 拒绝外来 Origin', trusted({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:7953', origin: 'https://evil.example' } }) === false)

// 可移植性：别的机器上 DSH 可能监听 127.0.0.2、用 localhost、或配了 trustedHosts 自定义域名。
const req = (address, host, extra) => ({
  socket: { remoteAddress: address },
  headers: Object.assign({ host }, extra ?? {}),
})
ok('trusted 接受 127.0.0.2（整个回环段）', trusted(req('127.0.0.2', '127.0.0.2:3080')) === true)
ok('trusted 接受 IPv4-mapped 回环', trusted(req('::ffff:127.0.0.1', '127.0.0.1:3080')) === true)
ok('trusted 接受 localhost', trusted(req('127.0.0.1', 'localhost:3080')) === true)
ok('trusted 接受 [::1]', trusted(req('::1', '[::1]:3080')) === true)
ok('trusted 拒绝非回环地址', trusted(req('192.168.1.9', '127.0.0.1:3080')) === false)
ok('trusted 默认拒绝自定义域名', trusted(req('127.0.0.1', 'dsh.lan:3080')) === false)
ok(
  'trusted 放行 getOrigin 给出的自定义域名',
  trusted(req('127.0.0.1', 'dsh.lan:3080'), new Set(['dsh.lan', 'dsh.lan:3080'])) === true,
)
ok(
  '自定义域名 + 外来 Origin 仍被拒',
  trusted(req('127.0.0.1', 'dsh.lan:3080', { origin: 'https://evil.example' }), new Set(['dsh.lan', 'dsh.lan:3080'])) === false,
)
ok(
  '自定义域名 + 同源 Origin 放行',
  trusted(req('127.0.0.1', 'dsh.lan:3080', { origin: 'http://dsh.lan:3080' }), new Set(['dsh.lan', 'dsh.lan:3080'])) === true,
)

rmSync(home, { recursive: true, force: true })
if (failures.length > 0) {
  console.error('\n' + failures.length + ' 项失败')
  process.exit(1)
}
console.log('\n全部通过')