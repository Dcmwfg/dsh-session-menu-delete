/**
 * 客户端半的离线自检：用假的 __ModuleLoader__ / require / React 把模块跑起来。
 * 只验证「模块能加载 + 两处插槽注册成功 + 菜单项与对话框组件能渲染并接线」，
 * 真实观感仍需重启后在 GUI 里看。
 *   node scripts/client-test.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const failures = []
function ok(label, cond, extra) {
  if (cond) console.log('PASS ' + label)
  else { failures.push(label); console.log('FAIL ' + label + (extra !== undefined ? ' — ' + extra : '')) }
}

/* ---------- 假 jsx：返回带 type/props 的普通对象，便于断言接线 ---------- */
function jsx(type, props) {
  return { __el: true, type, props: props ?? {} }
}

/* ---------- 假 primitives：每个组件/图标都带 __name ---------- */
function typeName(element) {
  if (element === null || element === undefined) return String(element)
  const type = element.type
  return typeof type === 'string' ? type : (type && type.__name) || String(type)
}

function makeComponent(name) {
  const fn = function (props) { return { __el: true, type: name, props: props ?? {} } }
  fn.__name = name
  return fn
}
const primitives = new Proxy({}, {
  get(target, key) {
    if (typeof key !== 'string') return undefined
    if (!(key in target)) target[key] = makeComponent(key)
    return target[key]
  },
})

/* ---------- 假 React：每个组件实例一份持久 state，跨渲染保留 ---------- */
const componentStates = new WeakMap()
let currentStates = []
let currentOwner = null
let currentIndex = 0
let currentEffects = []
const React = {
  useState(initial) {
    const index = currentIndex++
    if (index >= currentStates.length) currentStates[index] = initial
    return [currentStates[index], (next) => {
      currentStates[index] = typeof next === 'function' ? next(currentStates[index]) : next
    }]
  },
  useEffect(fn) { currentEffects.push(fn) },
  Fragment: 'Fragment',
}
/** 渲染一个组件，保留它的 state（相当于 React 的组件实例）。 */
function renderComponent(component, props) {
  const owner = component
  currentOwner = owner
  currentStates = componentStates.get(owner) ?? []
  componentStates.set(owner, currentStates)
  currentIndex = 0
  currentEffects = []
  const result = component(props)
  // 模拟 mount 时的 effect：订阅在这里建立，后续 requestStore.settle() 才能写回 state
  for (const effect of currentEffects) {
    try {
      const dispose = effect()
      if (typeof dispose === 'function') effectDisposers.push(dispose)
    } catch { /* 断言不依赖 */ }
  }
  return result
}
const effectDisposers = []
function resetComponentState(component) {
  componentStates.delete(component)
}

/* ---------- 假 window / document ---------- */
const styleNodes = []
const document = {
  head: { appendChild: (node) => styleNodes.push(node) },
  createElement: (tag) => ({ tagName: tag.toUpperCase(), id: '', textContent: '', remove() { this.removed = true } }),
  getElementById: (id) => styleNodes.find((n) => n.id === id) ?? null,
}

/** 每次 load 一个全新的模块实例（独立的模块级 requestStore）。 */
function loadModule(fetchImpl) {
  let def = null
  const window = { __ModuleLoader__: { load(next) { def = next } }, document, console }
  globalThis.window = window
  globalThis.document = document
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
  const run = new Function('window', 'document', 'fetch', source)
  run(window, document, fetchImpl)
  if (def === null) throw new Error('__ModuleLoader__.load was not called')
  const requireStub = (name) => {
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    if (name === 'react') return React
    if (name === 'react/jsx-runtime') return { jsx, Fragment: 'Fragment' }
    throw new Error('unexpected require: ' + name)
  }
  return { def, exports: def.factory(requireStub) }
}

/* ---------- locale 桩 ---------- */
function makeT(record) {
  const dict = {
    'menu.delete': '删除会话',
    'confirm.title': '删除这个会话？',
    'confirm.desc': '“{title}”会被永久删除，会话记录和左侧列表里的这一行都不会保留。',
    'confirm.delete': '永久删除',
    'confirm.cancel': '取消',
    'confirm.pending': '正在删除…',
    'confirm.close': '关闭',
    'confirm.untitled': '未命名会话',
  }
  return (key, params) => {
    if (record !== undefined) record.push([key, params])
    let text = dict[key] ?? key
    for (const [k, v] of Object.entries(params ?? {})) text = text.split('{' + k + '}').join(String(v))
    return text
  }
}

/* ---------- 假 ctx ---------- */
function makeCtx() {
  const registered = []
  const effectDisposers = []
  const localeCalls = []
  const ctx = {
    locale: {
      bind: () => makeT(),
      register(namespace, dict) { localeCalls.push([namespace, dict]); return () => {} },
    },
    slots: {
      inject(name, fn) {
        if (name !== 'sidebar.workspaces.session.menu.item' && name !== 'shell.overlay') throw new Error('unknown slot ' + name)
        const dispose = fn()
        return dispose
      },
      register(def, component) { registered.push({ def, component }); return () => {} },
    },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') effectDisposers.push(dispose) },
    get() { return undefined },
  }
  return { ctx, registered, effectDisposers, localeCalls }
}

const SESSION_ID = '0057fcfa-eb7f-46d1-acb0-8276b10fd0d2'
const TITLE = '测试会话'

/* ================= 1. 模块加载与导出 ================= */
let loadError = null
let first = null
try { first = loadModule(() => Promise.reject(new Error('no fetch in this phase'))) } catch (error) { loadError = error }
ok('模块加载并调到 __ModuleLoader__.load', loadError === null && first !== null, loadError && loadError.stack)
ok('load 的 id 是包名', first !== null && first.def.id === 'dsh-session-menu-delete', first && first.def.id)
ok('导出 name / inject / apply', first !== null
  && first.exports.name === 'dsh-session-menu-delete'
  && Array.isArray(first.exports.inject)
  && typeof first.exports.apply === 'function', first && Object.keys(first.exports).join(','))

/* ================= 2. apply 注册 ================= */
const boot = makeCtx()
let applyError = null
try { first.exports.apply(boot.ctx) } catch (error) { applyError = error }
ok('apply 执行不抛错', applyError === null, applyError && applyError.stack)
ok('注册了两个插槽', boot.registered.length === 2, boot.registered.map((r) => r.def.name).join(','))
const menuReg = boot.registered.find((r) => r.def.name === 'sidebar.workspaces.session.menu.item')
const dialogReg = boot.registered.find((r) => r.def.name === 'shell.overlay')
ok('菜单项 id/order/locale 正确', menuReg !== undefined && menuReg.def.id === 'dsh-session-menu-delete.delete' && menuReg.def.order === 440 && menuReg.def.locale === 'dsh-session-menu-delete', menuReg && JSON.stringify(menuReg.def))
ok('对话框 id 正确', dialogReg !== undefined && dialogReg.def.id === 'dsh-session-menu-delete.dialog', dialogReg && JSON.stringify(dialogReg.def))
ok('注册了中英文字典', boot.localeCalls.length === 1 && boot.localeCalls[0][0] === 'dsh-session-menu-delete' && boot.localeCalls[0][1].zh !== undefined && boot.localeCalls[0][1].en !== undefined)
ok('样式已挂到 document.head', styleNodes.length === 1 && String(styleNodes[0].textContent).includes('.dsmd-danger'))

/* ================= 3. 无请求时对话框不渲染 ================= */
resetComponentState(dialogReg.component)
const idle = renderComponent(dialogReg.component, { t: makeT(), ctx: boot.ctx })
ok('无请求时对话框返回 null', idle === null, JSON.stringify(idle).slice(0, 160))

/* ================= 4. 菜单项 ================= */
ok('菜单项使用 MenuItemButton', menuReg !== undefined && menuReg.component.name === 'DeleteSessionMenuItem')
resetComponentState(menuReg.component)
let menuClosed = false
let menuRenderError = null
let renderedMenu = null
try {
  renderedMenu = renderComponent(menuReg.component, {
    sessionId: SESSION_ID,
    displayTitle: TITLE,
    useMenuOpenState: () => [true, (open) => { menuClosed = !open }],
    t: makeT(),
  })
} catch (error) { menuRenderError = error }
ok('菜单项渲染不抛错', menuRenderError === null, menuRenderError && menuRenderError.stack)
ok('菜单项是 MenuItemButton', typeName(renderedMenu) === 'MenuItemButton', typeName(renderedMenu))
ok('菜单项用垃圾桶图标且无分隔线', renderedMenu !== null && renderedMenu.props.icon !== undefined && typeName(renderedMenu.props.icon) === 'IconTrashOutlineRegular' && renderedMenu.props.separatorBefore === undefined, JSON.stringify(renderedMenu && renderedMenu.props).slice(0, 200))
ok('菜单项文案走 locale', renderedMenu !== null && renderedMenu.props.children === '删除会话', renderedMenu && String(renderedMenu.props.children))
renderedMenu.props.onSelect()
ok('onSelect 关闭菜单', menuClosed === true)

/* ================= 5. 有请求时渲染确认框 ================= */
resetComponentState(dialogReg.component)
const dialogT = []
const dialog = renderComponent(dialogReg.component, { t: makeT(dialogT), ctx: boot.ctx })
ok('有请求时渲染 Modal', typeName(dialog) === 'Modal', typeName(dialog))
ok('Modal 标题正确', dialog !== null && dialog.props.title === '删除这个会话？', dialog && String(dialog.props.title))
ok('Modal 描述带标题插值', dialog !== null && String(dialog.props.description).includes(TITLE), dialog && String(dialog.props.description))
ok('Modal 有关闭回调与 closeLabel', dialog !== null && typeof dialog.props.onClose === 'function' && dialog.props.closeLabel === '关闭')
const footer = dialog !== null ? dialog.props.footer.props.children : []
ok('底部两个按钮', Array.isArray(footer) && footer.length === 2, String(footer && footer.length))
ok('取消按钮是 outline', footer[0] !== undefined && footer[0].props.variant === 'outline' && footer[0].props.children === '取消')
ok('确认按钮带危险样式', footer[1] !== undefined && footer[1].props.className === 'dsmd-danger' && footer[1].props.children === '永久删除')

/* ================= 6. 点确认 → POST → 成功清空 ================= */
const calls = []
let settleFetch = null
const fetchImpl = (url, init) => {
  calls.push({ url, init })
  return new Promise((resolve) => { settleFetch = resolve })
}

// 换一个干净的模块实例，确保 requestStore / fetch 都是新的
const second = loadModule(fetchImpl)
resetComponentState(dialogReg.component)
const boot2 = makeCtx()
second.exports.apply(boot2.ctx)
const menu2 = boot2.registered.find((r) => r.def.name === 'sidebar.workspaces.session.menu.item')
const dialog2 = boot2.registered.find((r) => r.def.name === 'shell.overlay')

resetComponentState(menu2.component)
renderComponent(menu2.component, {
  sessionId: SESSION_ID,
  displayTitle: TITLE,
  useMenuOpenState: () => [true, () => {}],
  t: makeT(),
}).props.onSelect()

resetComponentState(dialog2.component)
const live = renderComponent(dialog2.component, { t: makeT(), ctx: boot2.ctx })
ok('点击后立刻出现确认框', typeName(live) === 'Modal', typeName(live))
live.props.footer.props.children[1].props.onClick()
await new Promise((resolve) => setTimeout(resolve, 10))
ok('确认后 POST 到宿主路由', calls.length === 1 && calls[0].url === '/api/dsh-session-menu-delete/delete', JSON.stringify(calls.map((c) => c.url)))
ok('POST body 带 sessionId', calls.length === 1 && JSON.parse(calls[0].init.body).sessionId === SESSION_ID, calls[0] && calls[0].init.body)
ok('POST 带 same-origin 凭据', calls.length === 1 && calls[0].init.credentials === 'same-origin')
settleFetch({ ok: true, status: 200, json: async () => ({ ok: true }) })
await new Promise((resolve) => setTimeout(resolve, 20))
const after = renderComponent(dialog2.component, { t: makeT(), ctx: boot2.ctx })
ok('成功后请求清空（对话框消失）', after === null)

/* ================= 7. 失败路径 ================= */
resetComponentState(menu2.component)
renderComponent(menu2.component, {
  sessionId: SESSION_ID,
  displayTitle: TITLE,
  useMenuOpenState: () => [true, () => {}],
  t: makeT(),
}).props.onSelect()
resetComponentState(dialog2.component)
const failing = renderComponent(dialog2.component, { t: makeT(), ctx: boot2.ctx })
failing.props.footer.props.children[1].props.onClick()
await new Promise((resolve) => setTimeout(resolve, 10))
settleFetch({ ok: false, status: 409, json: async () => ({ ok: false, error: '这个会话正在运行，先关掉它再删。' }) })
await new Promise((resolve) => setTimeout(resolve, 20))
const failed = renderComponent(dialog2.component, { t: makeT(), ctx: boot2.ctx })
const errorNode = failed !== null ? (failed.props.children ?? []).find((node) => node !== null && node.props && node.props.role === 'alert') : null
ok('失败时显示宿主返回的原因', errorNode !== undefined && errorNode !== null && String(errorNode.props.children).includes('正在运行'), errorNode && String(errorNode.props.children))

/* ================= 8. 无返回体时给 HTTP 兜底文案 ================= */
resetComponentState(menu2.component)
renderComponent(menu2.component, {
  sessionId: SESSION_ID,
  displayTitle: TITLE,
  useMenuOpenState: () => [true, () => {}],
  t: makeT(),
}).props.onSelect()
resetComponentState(dialog2.component)
renderComponent(dialog2.component, { t: makeT(), ctx: boot2.ctx }).props.footer.props.children[1].props.onClick()
await new Promise((resolve) => setTimeout(resolve, 10))
settleFetch({ ok: false, status: 502, json: async () => { throw new Error('not json') } })
await new Promise((resolve) => setTimeout(resolve, 20))
const plain = renderComponent(dialog2.component, { t: makeT(), ctx: boot2.ctx })
const plainError = plain !== null ? (plain.props.children ?? []).find((node) => node !== null && node.props && node.props.role === 'alert') : null
ok('非 JSON 错误回落到 HTTP 状态', plainError !== undefined && plainError !== null && String(plainError.props.children).includes('502'), plainError && String(plainError.props.children))

console.log('')
if (failures.length === 0) {
  console.log('全部通过')
  process.exit(0)
} else {
  console.log(failures.length + ' 项失败: ' + failures.join(' | '))
  process.exit(1)
}