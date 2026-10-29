/**
 * dsh-session-menu-delete — client half.
 *
 * 两处注册：
 *   1. sidebar.workspaces.session.menu.item（order 440，紧跟归档会话之后）：会话行三点菜单里的
 *      「删除会话」项。点击只做一件事——把 { sessionId, displayTitle } 放进模块级请求
 *      store，然后关菜单。
 *   2. shell.overlay：确认对话框。菜单项和对话框都挂在同一个模块里，所以直接用模块
 *      级 store 通信，不依赖 slots 的 hooks 注入协议（少一层契约，少一处会断的地方）。
 *
 * 确认后调宿主半的 POST /api/dsh-session-menu-delete/delete。宿主删盘并 emit
 * api-session/removed，客户端列表自己会摘掉那一行；这里再补一次 sessions.refresh()
 * 兜底（事件没转发成功时，重拉列表同样看不到已删的磁盘记录）。
 */
window.__ModuleLoader__.load({
  id: "dsh-session-menu-delete",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
    var primitives = require("@deepseek-ai/dsh-client-ui-primitives")
    var React = require("react")
    var jsx = require("react/jsx-runtime").jsx
    var Fragment = require("react/jsx-runtime").Fragment

    var NAME = "dsh-session-menu-delete"
    var NS = NAME
    var ENDPOINT = "/api/dsh-session-menu-delete/delete"
    var STYLE_ID = "dsh-session-menu-delete-style"

    var en = {
      "menu.delete": "Delete conversation",
      "confirm.title": "Delete this conversation?",
      "confirm.desc": "\u201c{title}\u201d will be deleted permanently. Its session log and its row are both removed. This cannot be undone.",
      "confirm.delete": "Delete permanently",
      "confirm.cancel": "Cancel",
      "confirm.pending": "Deleting\u2026",
      "confirm.close": "Close",
      "confirm.untitled": "Untitled conversation",
      "error.http": "The host rejected the delete request (HTTP {status}).",
    }
    var zh = {
      "menu.delete": "\u5220\u9664\u4f1a\u8bdd",
      "confirm.title": "\u5220\u9664\u8fd9\u4e2a\u4f1a\u8bdd\uff1f",
      "confirm.desc": "\u201c{title}\u201d\u4f1a\u88ab\u6c38\u4e45\u5220\u9664\uff0c\u4f1a\u8bdd\u8bb0\u5f55\u548c\u5de6\u4fa7\u5217\u8868\u91cc\u7684\u8fd9\u4e00\u884c\u90fd\u4e0d\u4f1a\u4fdd\u7559\u3002\u8fd9\u4e2a\u64cd\u4f5c\u4e0d\u80fd\u64a4\u9500\u3002",
      "confirm.delete": "\u6c38\u4e45\u5220\u9664",
      "confirm.cancel": "\u53d6\u6d88",
      "confirm.pending": "\u6b63\u5728\u5220\u9664\u2026",
      "confirm.close": "\u5173\u95ed",
      "confirm.untitled": "\u672a\u547d\u540d\u4f1a\u8bdd",
      "error.http": "\u5bbf\u4e3b\u62d2\u7edd\u4e86\u5220\u9664\u8bf7\u6c42\uff08HTTP {status}\uff09\u3002",
    }

    /** 模块级请求 store：菜单项写、对话框读。getSnapshot 返回同一个引用，React 才不抖。 */
    var pending = null
    var listeners = new Set()
    function emitChange() {
      listeners.forEach(function (listener) {
        try { listener() } catch (error) { /* 订阅者抛错不打断其它订阅者 */ }
      })
    }
    var requestStore = {
      get: function () { return pending },
      subscribe: function (listener) {
        listeners.add(listener)
        return function () { listeners.delete(listener) }
      },
      request: function (next) { pending = next; emitChange() },
      settle: function () { pending = null; emitChange() },
    }

    function usePendingRequest() {
      var state = React.useState(requestStore.get())
      var value = state[0]
      var setValue = state[1]
      React.useEffect(function () {
        return requestStore.subscribe(function () { setValue(requestStore.get()) })
      }, [])
      return value
    }

    function installStyles() {
      if (typeof document === "undefined") return
      if (document.getElementById(STYLE_ID) !== null) return
      var style = document.createElement("style")
      style.id = STYLE_ID
      style.textContent = [
        ".dsmd-danger:not(:disabled){color:var(--dsw-alias-state-error-primary);}",
        ".dsmd-error{margin-top:8px;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary);word-break:break-word;}",
      ].join("")
      document.head.appendChild(style)
    }

    function removeStyles() {
      if (typeof document === "undefined") return
      var style = document.getElementById(STYLE_ID)
      if (style !== null) style.remove()
    }

    /** 会话行三点菜单里的一项。会话 id 与标题由宿主行组件直接传进来。 */
    function DeleteSessionMenuItem(props) {
      var sessionId = props.sessionId
      var displayTitle = props.displayTitle
      var useMenuOpenState = props.useMenuOpenState
      var t = props.t
      var menu = useMenuOpenState()
      var setMenuOpen = menu[1]
      return jsx(primitives.MenuItemButton, {
        icon: jsx(primitives.IconTrashOutlineRegular, {}),
        onSelect: function () {
          setMenuOpen(false)
          requestStore.request({ sessionId: sessionId, displayTitle: displayTitle })
        },
        children: t("menu.delete"),
      })
    }

    /** 永久删除：调宿主路由 → 宿主删盘 + 广播移除。 */
    function deleteSession(sessionId) {
      return fetch(ENDPOINT, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: sessionId }),
      }).then(function (response) {
        return response.json().catch(function () { return {} }).then(function (payload) {
          if (!response.ok || payload.ok !== true) {
            var message = typeof payload.error === "string" && payload.error !== ""
              ? payload.error
              : "HTTP " + response.status
            throw new Error(message)
          }
          return payload
        })
      })
    }

    /** 兜底刷新：事件没送到时，重拉一次列表基线也能让已删的行消失。 */
    function refreshList(ctx, t) {
      try {
        var sessions = typeof ctx.get === "function" ? ctx.get("sessions") : undefined
        if (sessions !== undefined && sessions !== null && typeof sessions.refresh === "function") {
          return Promise.resolve(sessions.refresh()).catch(function () {})
        }
      } catch (error) { /* 服务不在就当没有 */ }
      return Promise.resolve()
    }

    function DeleteSessionDialog(props) {
      var request = usePendingRequest()
      var t = props.t
      var ctx = props.ctx
      var deletingState = React.useState(false)
      var deleting = deletingState[0]
      var setDeleting = deletingState[1]
      var errorState = React.useState(null)
      var error = errorState[0]
      var setError = errorState[1]
      if (request === null) return null
      var title = typeof request.displayTitle === "string" && request.displayTitle.trim() !== ""
        ? request.displayTitle.trim()
        : t("confirm.untitled")
      var close = function () {
        if (deleting) return
        setError(null)
        requestStore.settle()
      }
      var confirm = function () {
        if (deleting) return
        setDeleting(true)
        setError(null)
        deleteSession(request.sessionId).then(function () {
          return refreshList(ctx, t)
        }).then(function () {
          setDeleting(false)
          requestStore.settle()
        }).catch(function (reason) {
          setDeleting(false)
          setError(reason instanceof Error ? reason.message : String(reason))
        })
      }
      return jsx(primitives.Modal, {
        open: true,
        onClose: close,
        closeLabel: t("confirm.close"),
        title: t("confirm.title"),
        description: t("confirm.desc", { title: title }),
        footer: jsx(Fragment, {
          children: [
            jsx(primitives.Button, {
              variant: "outline",
              disabled: deleting,
              onClick: close,
              children: t("confirm.cancel"),
            }),
            jsx(primitives.Button, {
              variant: "outline",
              className: "dsmd-danger",
              disabled: deleting,
              onClick: confirm,
              children: t("confirm.delete"),
            }),
          ],
        }),
        children: [
          deleting ? jsx("div", { role: "status", children: t("confirm.pending") }) : null,
          error !== null ? jsx("div", { className: "dsmd-error", role: "alert", children: error }) : null,
        ],
      })
    }

    function register(ctx, name, id, order, component, injected) {
      try {
        ctx.slots.inject(name, function () {
          return ctx.slots.register({
            name: name,
            id: id,
            order: order,
            locale: injected.locale === true ? NS : undefined,
          }, component)
        })
        return true
      } catch (error) {
        console.warn("[dsh-session-menu-delete] slot registration failed: " + name, error)
        return false
      }
    }

    function apply(ctx) {
      var t = ctx.locale.bind(NS)
      ctx.effect(function () {
        installStyles()
        return function () { removeStyles() }
      }, "dsh-session-menu-delete: styles")
      ctx.effect(function () {
        return ctx.locale.register(NS, { en: en, zh: zh })
      }, "dsh-session-menu-delete: dictionaries")

      register(ctx, "sidebar.workspaces.session.menu.item", NAME + ".delete", 440, DeleteSessionMenuItem, { locale: true })

      try {
        ctx.slots.inject("shell.overlay", function () {
          return ctx.slots.register({
            name: "shell.overlay",
            id: NAME + ".dialog",
            locale: NS,
            inject: function () { return { ctx: ctx } },
          }, DeleteSessionDialog)
        })
      } catch (error) {
        console.warn("[dsh-session-menu-delete] shell.overlay registration failed", error)
      }
    }

    var inject = ["slots", "locale"]

    exports.name = NAME
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
