/**
 * 集成自检：把宿主半真正挂到一个 HTTP server 上，用真实请求走一遍。
 * 不碰真实 DSH 数据，home 指向临时目录。
 *   node scripts/route-test.mjs
 */
import { createServer, request as httpRequest } from 'node:http'
import { mkdirSync, mkdtempSync, existsSync, writeFileSync, readdirSync, rmdirSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const failures = []
function ok(label, cond, extra) {
  if (cond) console.log('PASS ' + label)
  else { failures.push(label); console.log('FAIL ' + label + (extra ? ' — ' + extra : '')) }
}

const home = mkdtempSync(join(tmpdir(), 'dsmd-route-'))
const sessionId = '0057fcfa-eb7f-46d1-acb0-8276b10fd0d2'
const dir = join(home, 'sessions', '--E-hhh--', sessionId)
const cacheFile = join(home, 'storages', 'session_projcache', 'sessions', sessionId + '.json')
mkdirSync(dir, { recursive: true })
mkdirSync(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
// 用非 v4 + 无压缩的名字，顺带证明 HTTP 链路也不依赖写死的日志名
writeFileSync(join(dir, 'session.v2.jsonl'), 'x')
writeFileSync(cacheFile, '{}')

const emitted = []
let handler = null
const effects = []
const fakeCtx = {
  config: { dshHome: home },
  sessions: { get: () => undefined },
  agents: { get: () => undefined },
  emit: (event, id) => emitted.push([event, id]),
  effect: (fn, label) => { effects.push(label); fn() },
  webServer: {
    register: (def) => { handler = def.handler; return () => {} },
  },
}

// 护栏：home 必须是临时目录，绝不允许回落到真实 ~/.dsh
if (!home.startsWith(tmpdir())) throw new Error('route-test home 不在临时目录: ' + home)
apply(fakeCtx, { dshHome: home })
ok('apply() 注册了路由', handler !== null && effects.length === 1, JSON.stringify(effects))

const server = createServer((req, res) => handler(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = 'http://127.0.0.1:' + port + '/api/dsh-session-menu-delete'

async function call(path, init) {
  const response = await fetch(base + path, init)
  const text = await response.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = text }
  return { status: response.status, body }
}

const health = await call('/health', { method: 'GET', headers: { host: '127.0.0.1:' + port } })
ok('GET /health 200', health.status === 200 && health.body.ok === true, JSON.stringify(health))
ok('/health 报告了 home', health.body.home === home, JSON.stringify(health.body))
if (health.body.home !== home) throw new Error('护栏触发：/health 的 home 不是临时目录，中止测试以免删真实数据')

const wrongMethod = await call('/delete', { method: 'GET', headers: { host: '127.0.0.1:' + port } })
ok('GET /delete 405', wrongMethod.status === 405, JSON.stringify(wrongMethod))

const badId = await call('/delete', {
  method: 'POST',
  headers: { host: '127.0.0.1:' + port, 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: '../../etc/passwd' }),
})
ok('非法 sessionId 400', badId.status === 400, JSON.stringify(badId))

const missing = await call('/delete', {
  method: 'POST',
  headers: { host: '127.0.0.1:' + port, 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: '99999999-9999-4999-8999-999999999999' }),
})
ok('不存在的会话 404', missing.status === 404, JSON.stringify(missing))

const deleted = await call('/delete', {
  method: 'POST',
  headers: { host: '127.0.0.1:' + port, 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: sessionId }),
})
ok('删除成功 200', deleted.status === 200 && deleted.body.ok === true, JSON.stringify(deleted))
ok('目录已消失', existsSync(dir) === false)
ok('缓存已消失', existsSync(cacheFile) === false)
ok('广播 api-session/removed', emitted.length === 1 && emitted[0][0] === 'api-session/removed', JSON.stringify(emitted))

// 浏览器侧护栏：非回环 Host 必须 403，且不泄露任何删除结果。
// 注意 fetch 的 Host 是 forbidden header，会被 undici 丢掉，必须用原生 http 发。
{
  const rawDelete = (headers) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ sessionId: sessionId })
    const request = httpRequest(
      { host: '127.0.0.1', port, path: '/api/dsh-session-menu-delete/delete', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers } },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => { text += chunk })
        response.on('end', () => resolve({ status: response.statusCode, body: text }))
      },
    )
    request.on('error', reject)
    request.end(body)
  })

  const evilHost = await rawDelete({ host: 'evil.example:' + port })
  ok('非回环 Host 被 403', evilHost.status === 403, JSON.stringify(evilHost))

  const crossSite = await rawDelete({ host: '127.0.0.1:' + port, 'sec-fetch-site': 'cross-site' })
  ok('cross-site 请求被 403', crossSite.status === 403, JSON.stringify(crossSite))

  const goodHost = await rawDelete({ host: '127.0.0.1:' + port })
  ok('回环 Host 能过护栏（会话已删故为 404）', goodHost.status === 404, JSON.stringify(goodHost))
}

const notFound = await call('/nope', { method: 'GET', headers: { host: '127.0.0.1:' + port } })
ok('未知子路径 404', notFound.status === 404, JSON.stringify(notFound))

server.close()
rmTreeForCleanup(home)
function rmTreeForCleanup(p) { try { removeDir(p) } catch {} }
function removeDir(p) {
  for (const name of readdirSync(p)) {
    const child = join(p, name)
    if (statSync(child).isDirectory()) removeDir(child)
    else unlinkSync(child)
  }
  rmdirSync(p)
}

