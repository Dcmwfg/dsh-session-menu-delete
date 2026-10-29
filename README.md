# dsh-session-menu-delete

在 DSH Web GUI 的侧边栏，会话行三点菜单里加一项 **删除会话**（排在「归档会话」下面）。
确认后：永久删除该会话的磁盘记录与投影缓存，并立刻把左侧那一行摘掉。

## 装

```jsonc
// ~/.dsh/profiles/desktop/package.json
"dependencies": {
  // 指向你克隆下来的目录（Windows 用正斜杠）
  "dsh-session-menu-delete": "link:/path/to/dsh-session-menu-delete"
}
```

并把 `"dsh-session-menu-delete"` 加进同文件的 `dsh.profile.bundles` 数组，然后在 profile 目录里 `pnpm install`、重启 DSH。

profile 目录按系统不同：
- Windows：`%USERPROFILE%\.dsh\profiles\desktop`
- macOS / Linux：`~/.dsh/profiles/desktop`

装完想看有没有装坏，重启前先跑一遍 `dsh-plugin-guard`（若已安装）。

插件自带 `cordis.patch.yml`（`- insert:` 一条），由 bundle patch 机制加载，不用改 profile 的 cordis.patch.yml。

## 用

侧边栏 → 会话行右侧「…」→ 删除会话 → 永久删除。

## 实现

浏览器半（`lib/client.js`）注册两个插槽：

- `sidebar.workspaces.session.menu.item`，order `440`：菜单项。
- `shell.overlay`：确认对话框。

宿主半（`lib/index.js`）起一个只监听回环的路由：

- `GET  /api/dsh-session-menu-delete/health`
- `POST /api/dsh-session-menu-delete/delete` `{ "sessionId": "<uuid>" }`

删除顺序（不能改）：

1. 会话还活在内存里 → `sessions.liveEntryFor()` + `detachEntered()` 摘掉，再摘 agent；
2. 等 800ms，让持久化 writer 的 drain 写完；
3. 删 `<DSH_HOME>/sessions/<workspaceKey>/<id>/` 与 `storages/session_projcache/sessions/<id>.json`；
4. 等 400ms 补删投影缓存并 `table.delete(id)`（缓存服务会在 disposed 时异步回写一次）；
5. `ctx.emit('api-session/removed', id)`。

目录名与缓存名都有两种形态：裸 UUID 和 `session-<uuid>`（新会话未命名时落盘是后者）。插件先按传入的 id 精确找，找不到再试另一种写法——同一个 uuid 的两种写法指向同一个会话。**目录没找到、只找到缓存时不报成功**，直接返回 500 `partial`：只删缓存会让那一行在下次刷新时冒回来。

## 自检

```bash
node --check lib/index.js && node --check lib/client.js
node scripts/selftest.mjs       # 40 项：路径解析、日志名版本兼容、目录名双形态、live 判定、删除、权限校验
node scripts/route-test.mjs     # 14 项：真 HTTP 路由 + 403 护栏（只在临时目录里跑）
node scripts/client-test.mjs    # 30 项：客户端渲染与 POST 契约
node scripts/real-home-test.mjs #  9 项：真实 DSH_HOME 下造哑会话删掉
```

## 兼容性

宿主没有公开的「会话文件操作」API，这个插件靠三样东西：侧边栏插槽、会话目录布局、内存会话服务。前两个是稳定契约，第三个是内部实现。

**会话日志文件名不写死。** 宿主自己生成的名字随格式版本走（`session.jsonl` / `session.vN.jsonl`，压缩时再加 `.zstd`），读的时候是「扫目录、取版本号最大的那个」。插件照同样规则认文件，所以：

- 老会话（v3 之类）能删；
- 将来框架升到 v5、v6，只要命名规则不变就继续能删；
- 目录里没有 canonical 日志名的目录，当杂项跳过，不误删。

**依赖的内部 API**（没有公开契约，宿主改内部实现就可能失效）：

| 位置 | 用法 | 失效后的现象 |
| --- | --- | --- |
| `sessions.liveEntryFor()` / `detachEntered()` | 判断并摘除热会话 | live 会话删不掉，返回 409 带原因；冷会话不受影响 |
| `agents.store?.get?.()` / `agents.detachEntered()` | 摘 agent | 可选调用，失败不影响删盘 |
| `ctx.get('sessionProjectionCache')` 的 `table` | 直接删投影缓存条目 | 可选，退化成只删 json 文件 |

前两类都做了可选链与兜底，宿主不提供时降级而不是崩掉。**代价是：如果哪天 DSH 改了这些方法名，卸载干净、最坏情况是「点了删除，磁盘删了但左侧列表还在」，刷新页面即正常——不会丢别的会话数据。**

**磁盘布局假设**：`<DSH_HOME>/sessions/<workspaceKey>/<sessionId>/`（目录名可能是裸 UUID，也可能是 `session-<uuid>`）和 `<DSH_HOME>/storages/session_projcache/sessions/<id>.json`（同名两种形态）。DSH_HOME 解析顺序是 配置注入 → `DSH_HOME` → `DSH_HOME_DIR` → `~/.dsh`，校验目录下至少有 `sessions` / `storages` / `profiles` 之一。

**装不上时先看这里**：插件在 profile 的 `node_modules` 里只能解析到 `@deepseek-ai/schemastery`，官方其它包（home-paths、session-format 等）都在 app.asar 里、插件 import 不到。所以插件不 import 任何宿主内部包，路径与文件名规则是自带的实现。自己改这个插件时别加这类 import，会直接起不来。

**依赖的两个插槽**（官方客户端扩展点，名字变了菜单就不出现）：

- `sidebar.workspaces.session.menu.item`（list，scope root）——宿主半的会话行三点菜单。同一个插槽里还有 pin / rename / fork / archive / session-id 几项，本插件 order `440`，排在 archive(400) 后面。
- `shell.overlay`——确认对话框。

宿主半 `inject = ['webServer']`，所以**只在带 Web 服务端的形态（desktop / dsh web）里工作**。纯 CLI 形态下这个服务不存在，插件加载时会因为 inject 未满足而不启动（不会崩，也不会删任何东西）。

## 已知边界

- 只删**冷会话或能安全摘除的 live 会话**；摘不掉就返回 409 并说明原因，不动磁盘。
- 会话目录与投影缓存必须至少找到其中之一；**只找到缓存不删、报 500 partial**，避免伪装成删除成功。
- 只监听回环 + 同源校验，外部 Origin 一律 403。回环认 127.0.0.0/8 整段、`::1`、IPv4-mapped 与 `localhost`；如果 DSH 配了 `trustedHosts` 自定义域名，插件会放行 `webServer.getOrigin()` 报出来的那个 host，其余一律拒绝。
- 不碰 `workspace.json`：客户端 `deriveFlat` 遇到 `list.byId[id]` 缺失会跳过那一行。
