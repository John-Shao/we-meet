# P3.5 — 云文档集成 App 客户端(Android)

> 上承 [p3-collab-docs.md](p3-collab-docs.md)(web 端已收官:框架内 iframe + SSO 免登 + embed 收敛)。
> 本文是 **Android App 端** 的设计文档。范围:仅 Android(无 iOS 工程);入口 = 第 5 个底部 tab(用户已拍板)。

## 一、Context(为什么做、难点在哪)

web 端云文档已在 meet 框架内无缝打开。App 端对应形态 = **WebView 内嵌 `docs.we-meet.online`**,但有一个 web 端不存在的**硬约束**:

**App 现有登录(手机号 OTP → 后端 Token Exchange)只产出 access/refresh token,全程无浏览器参与——Keycloak 从未给任何浏览器/WebView 种过会话 cookie。** 而 docs 前端要的是同域 KC 会话 cookie(不是 Authorization 头),token 喂不进 WebView、也变不出 KC 会话。`qr_login_sso.md` 已记录同款阻塞点:凡 token 回传模式(Token Exchange / Device Flow / CIBA)皆给不了浏览器 SSO cookie。

**唯一现实解**:让「种 cookie」的动作发生在 WebView 自己身上——App 登录迁移到 **WebView 内的 Keycloak OIDC 授权码流**。登录页就是 realm 已上线的统一登录页(`browserFlow=unified-browser`,手机号 OTP + 扫码双栏,与 web 完全同页)。登录完成:

- App 拿到 access/refresh token(API 调用照旧);
- **WebView 的进程级 CookieManager 持有 KC 会话 cookie(自动持久化)** → 云文档 tab 的 WebView 静默 SSO 免登。

用户已拍板:**做鉴权改造**(不接受"docs tab 内再登一次"的折中),一并上第 5 tab。

## 二、关键决策

- **D1 登录迁移 + 双流兜底。** 新增 `WebLoginScreen`(WebView 加载 KC authorize URL,拦截 redirect 取 code,PKCE 换 token)。**原生 OTP 登录整套保留**,BuildConfig 开关 `WE_MEET_WEB_LOGIN`(默认 true)一键回退——动登录主流程的保险丝。
- **D2 新 Keycloak public client `app`。** PKCE S256、`redirectUris=["com.we.meet://oidc/callback"]`、standardFlow on、directAccess off、**scope 请求 `openid offline_access`**。public client 无 secret,App 直连 KC token endpoint 换/刷 token,不再经后端。bootstrap 脚本照 `bootstrap-docs-client.sh` 模式放 `deploy/aliyun/keycloak/bootstrap-app-client.sh`(we-meet 仓库,与 realm 建置同处)。
- **D3 后端零改动。** 已核实 meet 后端 DRF 鉴权 = `mozilla_django_oidc.contrib.drf.OIDCAuthentication`(settings.py:418),按 **userinfo** 校验 Bearer——同 realm 任意 client 签发的 token(含 `openid` scope)都接受,无 audience 检查。`/api/mobile/*` 原端点原样保留(legacy 流仍在用)。
- **D4 token 刷新双路。** `TokenStore` 加 `authFlow`("web"/空=legacy)+ `idToken`。`TokenRefreshAuthenticator`:web 流直连 KC token endpoint(`grant_type=refresh_token&client_id=app`,走独立 plain OkHttp,同 refreshOkHttp 的隔离理由);legacy 流照旧走 `/api/mobile/auth/refresh/`。**升级兼容**:老安装的存量 token 是 legacy 流,authFlow 为空 → 走旧路,零感知;下次主动登出/过期后自然切 web 流。
- **D5 docs 免登机制与时限。** Android CookieManager 是**进程级单例且自动落盘**——登录 WebView 种的 KC cookie,docs tab 的 WebView 直接命中。`offline_access` 让 **App 自身长登录**(offline refresh token 默认 30 天 idle、可续,不受 SSO 会话时限);但 **KC SSO cookie 受 realm 会话时限**(现 idle 30min / max 10h)——超时后 docs tab 会再见统一登录页(输一次 OTP 即恢复)。若要拉长,后续调 realm `ssoSessionIdleTimeout/MaxLifespan`(影响 web 端,单独评估,不在本次)。
- **D6 入口 = 第 5 tab。** `MainTab` 加 `Docs`(消息·日历·会议·通讯录·云文档),icon `Description`。**WebView 实例提升到 MainTabScreen 层持有**(`remember` + factory 里先脱旧 parent)——tabs 是 `tabs[safeTab].content()` 切换重组,不提升则每次切 tab 重建 WebView 重走加载/SSO。`BackHandler`(选中本 tab 且 `canGoBack`)支持页内返回。URL 带 `?embed=1&lang=<设备语言>`。
- **D7 docs 侧 embed 收敛补丁(docs-dev)。** App WebView 是**顶层**加载(非 iframe):`window.self!==window.top` 判据失效;`?embed=1` 又被 docs 的 `/`→`/home/` 客户端重定向丢弃(web 端 iframe 踩过的同一坑)。补:`useIsEmbedded.tsx` **模块级**捕获 `?embed=1` 写入 `sessionStorage`(模块 import 发生在重定向前),hook 判据 = iframe ∨ 参数 ∨ sessionStorage。web 端行为不变,app 端收敛生效。
- **D8 登出语义。** 主动登出(web 流):best-effort 调 KC `end_session`(带 id_token_hint)+ **清 WebView cookie**(否则下个用户打开登录页被静默续登为前一账号)。**会话过期**(401 刷新失败)**不清 cookie**:登录页加载 authorize URL 时若 KC cookie 尚活 → 静默拿新 code → **免输入自动复登**(体验红利)。

## 三、登录/免登时序

```
[首次登录]
WebLoginScreen(WebView)
  → GET {KC}/realms/meet/protocol/openid-connect/auth
      ?client_id=app&response_type=code&scope=openid offline_access
      &redirect_uri=com.we.meet://oidc/callback&state=..&code_challenge(S256)=..
  → 统一登录页(手机号 OTP / 扫码双栏,同 web) → 用户完成
  → KC 302 com.we.meet://oidc/callback?code=..&state=..   [KC 会话 cookie 已落 CookieManager]
  → shouldOverrideUrlLoading 拦截 → 校验 state
  → POST {KC}/token  grant_type=authorization_code + code_verifier (无 secret)
  → access/refresh(offline)/id_token → TokenStore(authFlow=web)
  → CookieManager.flush() → 进主界面

[云文档 tab]  ← 实测订正:必须从 authenticate 端点进,且靠 UA 认嵌入(见 §七)
DocsScreen(WebView) → https://docs.we-meet.online/api/v1.0/authenticate/
                        ?returnTo=<docs 根 URL(带 embed/lang)>
  → docs 302 KC → 命中 CookieManager 里的 KC 会话 → 静默 SSO → 302 回 docs
  → docs 建「已认证」会话 → 落到文档列表(免登)
  → WebView 的 UA 含 WeMeetApp 标记 → docs 隐藏自带用户区(D7 订正)

[API 与刷新]
业务 API:AuthInterceptor 加 Bearer(不变)
401 → TokenRefreshAuthenticator:authFlow=web → 直连 KC 刷新;否则走后端 refresh(不变)
```

## 四、触点清单(文件级)

**we-meet-android(主体)**
| 文件 | 动作 |
|---|---|
| `gradle.properties` + `app/build.gradle.kts` | 新增 `WE_MEET_DOCS_URL`、`WE_MEET_OIDC_CLIENT_ID`(默认 `app`)、`WE_MEET_WEB_LOGIN`(默认 true)三个 BuildConfig |
| `data/auth/KeycloakOidc.kt`(新) | PKCE 工具 + authorize URL 构造 + code 换 token + refresh(独立 plain OkHttp + org.json;含 id_token payload 解析取 phone/nickname) |
| `data/auth/TokenStore.kt` | 加 `idToken`、`authFlow` 两个 key |
| `data/auth/TokenRefreshAuthenticator.kt` | 双路刷新(D4);构造注入 `KeycloakOidc` |
| `data/api/ApiClient.kt` | 装配 KeycloakOidc 进 authenticator |
| `data/repository/AuthRepository.kt` | 加 `completeWebLogin(code, verifier)`(存 token/authFlow/身份提取 + push 注册,对齐 verifyOtp 的副作用);`signOut()` 加 web 流 end_session + 清 cookie(D8) |
| `ui/login/WebLoginScreen.kt`(新) | WebView 登录页:加载 authorize、拦截回调、loading/error 态、完成回调 `onLoggedIn` |
| `ui/nav/AppNav.kt` | `Routes.LOGIN` 按 `WE_MEET_WEB_LOGIN` 分发 WebLoginScreen / LoginScreen |
| `ui/main/MainTabScreen.kt` | `MainTab.Docs` 第 5 tab + 提升持有 docs WebView(D6) |
| `ui/docs/DocsScreen.kt`(新) | docs WebView。**四个实测要点(§七)**:①`MATCH_PARENT` LayoutParams;②`WebViewClient` 必须在 `loadUrl` 前设;③入口走 `/api/v1.0/authenticate/?returnTo=`;④UA 追加 `WeMeetApp/1.0 (embedded-docs)`。另:BackHandler、无手势导航一律留在 WebView |
| `res/values/strings.xml` + 其余四语 | `tab_docs`(Docs/云文档)+ 登录页文案(五语齐) |

**we-meet(仅脚本)**
- `deploy/aliyun/keycloak/bootstrap-app-client.sh`(新):realm `meet` 加 public client `app`(D2)。**部署时需在 aliyun-zlm 跑一次**。

**we-meet-docs(docs-dev)**
- `src/frontend/apps/impress/src/hooks/useIsEmbedded.tsx`:判据 = iframe ∨ **UA 含 `WeMeetApp`** ∨ sessionStorage ∨ `?embed=1`(D7 订正,见 §七.5)→ **重建 docs 前端镜像**。

**keycloak-phone-auth(main,登录页主题)**
- `theme/phone/login/resources/css/login.css` + `js/unified-poll.js`:触摸设备(`(hover:none) and (pointer:coarse)`)隐藏扫码列并跳过轮询 —— 手机上扫自己屏幕没意义;**不用宽度判**,否则桌面窄窗口会误伤(那里二维码仍有用)。→ **重建 keycloak 镜像**。

## 五、风险

1. **动登录主流程** → D1 的 BuildConfig 开关整流回退;原生 OTP 代码零删除。
2. **统一登录页在竖屏窄幕的双栏排版**未验证(theme 是否响应式堆叠)→ 首测确认,不佳则 theme 侧微调(keycloak-phone-auth 仓库,正交)。
3. **KC SSO 10h max** → docs tab 隔天首开要输一次 OTP(D5 已述,后续 realm 调优可消)。
4. **WebView 与 Custom Tabs 的取舍**:Keycloak 官方偏好 Custom Tabs,但其 cookie 与 WebView **不共享**,用了反而 docs 免登不成立——本场景 WebView 是刚需而非偷懒。
5. 老版本 App 升级:存量 legacy token 继续可用(D4),无强制重登。

## 六、验证(E2E)

| # | 动作 | 期望 |
|---|---|---|
| 1 | 全新安装 → 打开 App | WebView 显示统一登录页(手机号 OTP 列),输码登录成功进主界面 |
| 2 | 底部第 5 tab 云文档 | **免登**直入 docs(简体中文),无 docs 自带用户区(embed 收敛) |
| 3 | 会议/IM/日历等既有功能 | Bearer 正常(后端 userinfo 校验新 client token 通过) |
| 4 | 杀进程重开 → 云文档 tab | 仍免登(CookieManager 落盘) |
| 5 | 401 触发刷新(等 access 过期) | web 流直连 KC 刷新成功,无感 |
| 6 | 登出 → 再进登录页 | 需重新输 OTP(cookie 已清),不会静默续登前一账号 |
| 7 | 老包升级(legacy token 在库) | 不强制重登;登出后再登走 web 流 |
| 8 | `WE_MEET_WEB_LOGIN=false` 构建 | 回退原生 OTP 登录,App 全功能照旧(docs tab 首开需在页内登录) |

---

## 七、实战踩坑录(2026-07-16 落地,真机 + 模拟器验收通过)

> 设计(§二)整体成立 —— **CDP 实测确认登录 WebView 种的 KC 会话 cookie
> (`KEYCLOAK_IDENTITY`/`KEYCLOAK_SESSION`/`AUTH_SESSION_ID`)确实进了进程级
> CookieManager,docs 的 WebView 直接命中**,鉴权改造这条主链没白做。
> 但下面 5 个坑**设计时全没想到**,且多数光读代码看不出来,是靠 Chrome DevTools
> Protocol(`adb forward` + `webview_devtools_remote_<pid>`)实测撞出来的。

### 1. Kotlin 嵌套块注释吃掉整个文件
`KeycloakOidc.kt` 的 KDoc 里写了 `/api/mobile/auth/*` —— 其中的 `/*` 被 Kotlin 当成
**嵌套块注释**起始(Kotlin 支持注释嵌套),外层 KDoc 就此不闭合,报
`Syntax error: Unclosed comment`,连带整个类"不存在"、几十处 Unresolved reference。
**注释里别写含 `/*` 的路径通配。**

### 2. `WebViewClient` 必须在 `loadUrl` **之前**设 —— 一因两果
最初把 client 设在 `DocsTabScreen`(要等用户点开 tab 才组合),而 `loadUrl` 在
`createDocsWebView` 里就发生了。**没有 WebViewClient 的 WebView 会把导航交给系统
浏览器**(Android 官方默认行为),于是 docs 的 `/`→`/home/` 重定向逃出 WebView:
- **无手势**(自动重定向)→ Chromium 报 `Denied starting an intent without a user
  gesture` 拦下 → 导航被吞 → **页面空白**(真机现象);
- **有手势**(点 tab)→ 拉起成功 → **蹦出 Chrome**(模拟器现象)。

配套加固:`shouldOverrideUrlLoading` 里**无用户手势的导航一律 `return false`**
(留在 WebView),只有用户真手点的外站才外跳 —— 这样即便域名判断出错,最坏也只是
外链在 WebView 内打开,**结构上不可能再变空白**。

### 3. docs 打开 `/` 不会自动 OIDC 登录
全新 WebView 没有 docs 会话,而 docs 根路径**只渲染匿名着陆页**("Start Writing"),
`/users/me/` 一路 401,页面停在 spinner。web 端 iframe 之所以直接见文档列表,是因为
那个浏览器**早就登录过 docs**、已有已认证会话 —— 这掩盖了问题。
**修法**:从 `/api/v1.0/authenticate/?returnTo=<目标>` 进入,用已有 KC 会话静默换出
docs 的已认证会话。CDP 实测:`/users/me/` **401 → 200**,文档列表渲染。

### 4. WebView 没 LayoutParams → CSS 视口高度报 0 → 所有 `vh/dvh` 归零 ⭐
现象:点 docs 左上角面板开关,**只出遮罩、面板不见**(真机+模拟器一致,同 URL 在
浏览器窄窗口正常)。CDP 对照实验一锤定音:
```
innerHeight=780   supportsDvh=true          ← 视口明明是 780
100dvh → 0px   100svh → 0px   100vh → 0px   ← 视口单位全废
100%   → 780.19px                            ← 只有百分比正常
```
根因:程序化 `new WebView(context)` **没有 LayoutParams**,宿主按 `WRAP_CONTENT`
量它,Chromium 于是把 CSS 视口高度报成 0。docs 左面板恰是 `height:100dvh` → 算成 0,
又叠加 `overflow:hidden` → 渲染成一个**空抽屉**。
**修法**:`layoutParams = MATCH_PARENT/MATCH_PARENT`。复测全部恢复 780.19px。
**这条影响 WebView 里任何用 vh/dvh 的页面,不止这个面板;docs 侧零改动。**

### 5. `?embed=1` 活不过重定向 → 改用 UA 标记
embed 判据演进了三轮,前两轮都被现实推翻:
| 判据 | 结果 |
|---|---|
| `?embed=1` URL 参数 | ✗ docs 的 `/`→`/home/`、`authenticate`→`returnTo`→`/` 都会丢掉 query |
| `window.self !== window.top` | ✓ web iframe 可靠;✗ **App WebView 是顶层加载,恒 false** |
| **UA 追加 `WeMeetApp`** | ✓ 不依赖 URL、不依赖 iframe 嵌套,**抗重定向** —— App 端最终方案 |

现判据 = `iframe ∨ UA ∨ sessionStorage ∨ ?embed=1`(任一成立),web 端行为不变。
⚠️ **UA 标记串在两仓各存一份**(`DocsScreen.kt` 的 `EMBED_UA_MARKER` ↔
`useIsEmbedded.tsx` 的 `EMBED_UA_MARKER`),**改动须同步**,两边注释已交叉引用。

### 落地结果
| 能力 | 状态 |
|---|---|
| WebView Keycloak OIDC 登录(鉴权改造) | ✅ 真机通过 |
| 第 5 tab 云文档 · 免登直入文档列表 | ✅ 真机通过 |
| 导航面板 / 文档列表渲染 | ✅ 真机通过 |
| 手机端登录页隐藏二维码 | ✅ 真机通过 |
| docs 用户区收敛到 meet 框架 | ✅ 真机通过 |

**§五 风险 2(统一登录页竖屏双栏排版)已解**:不是排版问题,而是二维码在手机上
本就不该出现 —— 按触摸特征隐藏(见 §四 keycloak-phone-auth)。

### 调试手法备忘(下次直接用)
WebView 出问题别靠猜,**开 CDP 直连页面**:
```bash
adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof com.we.meet)
curl -s http://localhost:9222/json          # 列可检查页面 + 当前 URL + ws 地址
# 再用 websocket-client 跑 CDP:Network.getAllCookies / Runtime.evaluate /
# Network.responseReceived(抓 401)/ Log.entryAdded。
# 注意:websocket 握手需 suppress_origin=True,否则 403 Rejected origin。
```
debug 包已开 `WebView.setWebContentsDebuggingEnabled(true)`,也可 PC Chrome 开
`chrome://inspect` 直接看 Console/Network。
