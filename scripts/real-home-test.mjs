/**
 * 真机磁盘自检：在真实 DSH_HOME 下造一个哑会话（随机 uuid，不属于任何工作区），
 * 走 deleteSession 删掉，验证真实目录布局能被定位并清除。
 * 不碰任何真实会话：uuid 是现场生成的，删的只是自己造的那一个。
 *   node scripts/real-home-test.mjs
 */
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { deleteSession, locateSessionDir, resolveDshHome } from '../lib/index.js'

const failures = []
function ok(label, cond, extra) {
  if (cond) console.log('PASS ' + label)
  else { failures.push(label); console.log('FAIL ' + label + (extra !== undefined ? ' — ' + extra : '')) }
}

const home = resolveDshHome('')
ok('auto 解析出真实 DSH_HOME', home !== null && home !== undefined, String(home))
console.log('     home = ' + home)

// 找一个已存在的 workspaceKey 桶来放哑会话，贴近真实布局
import { readdirSync } from 'node:fs'
const buckets = readdirSync(join(home, 'sessions'), { withFileTypes: true }).filter((e) => e.isDirectory())
ok('sessions 下至少有一个 workspaceKey 桶', buckets.length > 0, String(buckets.length))
const bucket = buckets[0].name
const id = randomUUID()
const dir = join(home, 'sessions', bucket, id)
const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
const cacheFile = join(cacheDir, id + '.json')

mkdirSync(dir, { recursive: true })
mkdirSync(cacheDir, { recursive: true })
// 故意用一个非 v4 的名字，验证「按目录扫 canonical generation」而不是写死版本
writeFileSync(join(dir, 'session.v3.jsonl.zstd'), 'dummy')
writeFileSync(join(dir, 'notes.txt'), 'dummy') // 子项也要能删掉
writeFileSync(cacheFile, '{"title":"dummy"}')
ok('哑会话目录已造好', existsSync(dir) && existsSync(cacheFile))

const located = locateSessionDir(home, id)
ok('locateSessionDir 在真实布局里找到它', located === dir, String(located))

const fakeCtx = {
  sessions: { get: () => undefined },
  agents: { get: () => undefined },
  emit: (event, arg) => { (globalThis.__emitted ??= []).push([event, arg]) },
  get: () => undefined,
}
const result = await deleteSession(fakeCtx, home, id)
ok('deleteSession 返回 ok', result.ok === true, JSON.stringify(result))
ok('真实目录已消失', existsSync(dir) === false)
ok('真实投影缓存已消失', existsSync(cacheFile) === false)
ok('广播了 api-session/removed', (globalThis.__emitted ?? []).some(([e, a]) => e === 'api-session/removed' && a === id))

// 再删一次应当是 404（幂等可观测）
const again = await deleteSession(fakeCtx, home, id)
ok('重复删除返回 404 missing', again.status === 404 && again.reason === 'missing', JSON.stringify(again))

// 收尾：万一没删掉，别在真实目录里留垃圾
if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
if (existsSync(cacheFile)) rmSync(cacheFile, { force: true })

console.log('')
if (failures.length === 0) { console.log('全部通过'); process.exit(0) }
else { console.log(failures.length + ' 项失败: ' + failures.join(' | ')); process.exit(1) }
