# P3-C 云文档登录态引导(Docs Session Bootstrap)

> 状态:已实现,待部署实测。涉及三仓:`we-meet-docs`(Docs fork)、`we-meet`(后端 + Web)、`we-meet-android`。
> 前置:[p3-collab-docs.md](p3-collab-docs.md)(内嵌决策)、[p3-docs-app.md](p3-docs-app.md)(App 端 WebView)。

## 1. 问题

线上现象:**其它模块都是已登录状态,唯独云文档是登出的。**

- Web:`/docs` 里 iframe 白屏,控制台
  `Framing 'https://id.we-meet.online/' violates the following Content Security Policy directive: "frame-ancestors 'self'"`;
- App:云文档 tab 变成一张 Keycloak 手机号登录页。

## 2. 根因

内嵌进站原先只有一条路:Docs 的 `GET /api/v1.0/authenticate/`(OIDC)。它拿的是**浏览器 /
WebView 里的 Keycloak 会话 cookie**,静默换一个 Docs 会话。

但 meet 双端的登录态**不是** KC 浏览器会话:

| 登录方式 | 建 KC 浏览器会话? | 云文档能否进站 |
|---|---|---|
| Web 走 OIDC 按钮(`LoginButton` → `/api/v1.0/authenticate/`) | 建 —— 但 `KEYCLOAK_IDENTITY` 未勾 remember-me 时是**会话 cookie**,关掉浏览器即失效 | 同一次浏览器会话内可以;重开浏览器就不行 |
| Web 手机号 OTP / 扫码(Bearer + localStorage) | **不建** | 一律不行 |
| App(`WE_MEET_WEB_LOGIN=true`,WebView 内 KC 登录) | 建 —— 但会话 cookie 不落盘,进程重启即失效 | 冷启后不行 |

而 meet 自己的登录态(Django 会话 / Bearer + refresh)活得久得多。两者生命周期一脱钩,
云文档就"单独登出"了。

更糟的是 **web 侧无法自愈**:authenticate 甩到 KC 登录页,KC 自带
`Content-Security-Policy: frame-ancestors 'self'`(`deploy/aliyun/keycloak/Caddyfile` +
realm `browserSecurityHeaders` 两份),iframe 直接被浏览器拦掉 —— 白屏,连"点一下重新登录"
都没有。

> 放开 KC 的 `frame-ancestors` 不在选项内:那等于给登录页开点击劫持。

## 3. 方案

### A. 票据引导(根治)

一条与 KC 浏览器会话**无关**的进站链路,让云文档登录态跟随 meet 自己的登录态:

```
客户端 ──POST /api/v1.0/docs/session/ {next}──▶ meet 后端(认调用者:session 或 Bearer)
                                                    │
                                    s2s token ──────┤ POST /api/v1.0/users/session-ticket/
                                                    ▼
                                                 Docs:签一张票据(60s / 单次)
客户端 ◀────────────── {url: ".../session-from-ticket/?ticket=…&next=…"} ─────────┘
   │
   └─ iframe / WebView 载过去 ──▶ Docs 校验并销毁票据 → 建 Docs 会话 → 302 到 next
```

要点:

- **票据只在服务端之间产生**;客户端只拿到一张 60 秒、用一次即废的凭证。
- cache 里存的是 `sha256(ticket)`,URL 里那份即便落进 nginx/Caddy 访问日志也已失效。
- 单次使用以 `cache.delete()` 成功为准 —— 并发重放时只有一方拿得到 payload。
- `next` 两边都校验(meet 侧只放行 `/…`;Docs 侧再走
  `url_has_allowed_host_and_scheme`),不做开放重定向。
- 从未登录过 Docs 的用户在兑换时补建(与 OIDC 首次登录同路径:`User.save()` 会把待生效
  Invitation 转成 DocumentAccess);已存在的用户**只认不改**,不拿 meet 的展示名(常是手机号)
  盖掉 Docs 里的资料。
- 顺带修好一个老毛病:`?embed=1&lang=&theme=` 现在原样活到落地页(以前经
  `authenticate` 会被整串丢掉,只能靠 UA 兜底)。

### B. Web 兜底遮罩(防死路)

票据拿不到时仍退回 `authenticate`,那条路依旧可能撞 KC 的 CSP。所以 `DocsFrame` 加一道
watchdog:docs 在 iframe 里挂载会 `postMessage({type:'wemeet-theme-ready'})`(见 Docs
`ConfigProvider`),**12 秒等不到**就盖一层遮罩:

- 「重新登录」→ 顶层 `authUrl({returnTo})` 走 meet 自己的 OIDC(顶层没有 CSP 限制,
  顺带把 KC 会话重新建起来);
- 「重试」→ 重新换票 + 重载。

计时从挂载起算,所以"换票请求卡住"也在覆盖范围内。

## 4. 改动清单

**we-meet-docs**(分支 `docs-dev`)

- `src/backend/core/api/session_bootstrap.py`(新):票据签发/销毁 + `SessionFromTicketView`。
- `src/backend/core/api/viewsets.py`:`UserViewSet.session_ticket`(s2s)。
- `src/backend/core/urls.py`:挂 `session-from-ticket/`。
- `src/backend/core/tests/test_api_session_bootstrap.py`(新,10 项)。

**we-meet**

- `src/backend/core/services/docs_client.py`:`create_session_ticket()`。
- `src/backend/core/api/docs_session.py`(新):`POST /api/v1.0/docs/session/`。
- `src/backend/core/api/throttling.py` + `meet/settings.py`:`docs_session` scope(30/min)。
- `src/backend/core/urls.py`:挂路由。
- `src/backend/core/tests/test_api_docs_session.py`(新,10 项)。
- `src/frontend/src/features/docs/api/docsSession.ts`(新)、`DocsFrame.tsx`、5 份 `docs.json`。

**we-meet-android**

- `data/api/DocsApi.kt`(新)+ `ApiClient.docsApi`。
- `ui/docs/DocsScreen.kt`:`docsEntryUrl` / `loadDocsTabEntry` / `loadDocsDeepLinkEntry`,
  `createDocsWebView(deferInitialLoad=)`。
- `ui/main/MainTabScreen.kt`、`ui/docs/DocsViewerScreen.kt`:改走引导进站。

## 5. 部署

1. **先发 Docs**(`we-meet-docs`):没有迁移,但要重建后端镜像 —— 客户端拿到票据后
   `session-from-ticket` 必须已经存在,否则退回 authenticate(即回到今天的行为,不会更坏)。
2. 再发 meet 后端 + 前端。无新迁移;按惯例仍走 `helm upgrade`(见
   `reference-prod-deploy-helm-upgrade`)。
3. App 出包。
4. 配置**无需新增**:复用既有 `DOCS_API_URL` / `DOCS_SERVER_TO_SERVER_TOKEN`
   ↔ Docs 的 `SERVER_TO_SERVER_API_TOKENS`。

## 6. 约束与后续

- 票据能把 `docs_sessionid` 落进浏览器,前提是 meet 与 docs **同注册域**
  (`meet.we-meet.online` / `docs.we-meet.online`),iframe 内导航才算 same-site、
  `SameSite=Lax` 才被接受。跨注册域部署要另配 `SameSite=None`(现有 authenticate 链路
  同样受此约束,不是本方案新引入的)。
- Docs 会话本身 `SESSION_COOKIE_AGE=12h`;每次进云文档都会重新引导,过期无感。
- 备选方案 C(给 KC 加 remember-me 让会话 cookie 落盘)**未做**:它只是把"关浏览器就掉"
  推迟到 14 天,过期后仍是死路,且要改 `keycloak-phone-auth` 插件重新出镜像。A + B 落地后
  它不再是必需项。
