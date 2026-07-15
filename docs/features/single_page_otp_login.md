# 单页手机号登录（抖音式：获取验证码→输码→验证登录 一页完成）— 设计文档

状态:**已上线、实测通过**(2026-07-15;realm `unified-browser` 手机侧单页,获取验证码不刷新 + 验证登录一次提交建会话,meet/docs 全通)
背景:统一双栏登录页(realm `unified-browser`)手机侧原为**两步整页刷新**(输手机号→整页 POST 发码→第二页输码→验证登录)。改为抖音式**单页**:手机号 + 验证码同页,「获取验证码」内联 AJAX 发码(不刷新)+ 倒计时,填完「验证登录」一次提交。
调研依据:`core/api/mobile_auth.py`(OTP 发/校验/cache/demo)、`core/api/keycloak_sms.py`(shared-bearer 网关)、`keycloak-phone-auth/UnifiedLoginAuthenticator.java`、`docs/features/qr_login_sso.md`。
原则:① 复用现成 OTP 与已验证的通信模式 ② 不碰 Keycloak 内部 session_code ③ 扫码侧不动。

> 关联:统一登录整体见 [qr_login_sso.md](qr_login_sso.md)。

## 1. 为什么这么设计

单页要求「获取验证码」**不刷新页面**。两条路:
- ❌ **AJAX 打 Keycloak `loginAction`**:会撞 KC 内部 `session_code` 轮转机制,本地无法验证、生产登录风险高。
- ✅ **发码/校验都交给后端**:浏览器 AJAX 发码 + KC 服务端校验。全程只用**两个已实测跑通的模式** —— 浏览器跨域简单请求(同扫码的 `/ready/`)+ KC→后端 shared-bearer(同 `authenticator-status`);`loginAction` 只在最后「验证登录」命中一次,无 session_code 复用。

**副产物**:统一认证器手机侧被**简化** —— 不再在 KC 里生成 OTP / 存 authNotes / 处理 demo 号,全部下沉后端(与 mobile app 复用同一套 OTP)。

## 2. 数据流

```
① 输手机号 → 点「获取验证码」（unified-otp.js）
   → AJAX POST {backend}/api/keycloak-sms/otp/send/  (form-urlencoded 简单请求, ACAO:*)
   → 后端 _issue_otp：生成/存 cache(mobile_otp:{phone})/发短信 / demo 固定码
   → 前端启 60s 倒计时、验证码框聚焦（页面不刷新）
② 输验证码 → 点「验证登录」→ 整页 POST loginAction(phone+otp，唯一一次)
   → UnifiedLoginAuthenticator.action() → SmsGatewayClient.verifyOtp
   → POST {backend}/api/keycloak-sms/otp/verify/ (Bearer KEYCLOAK_SMS_GATEWAY_TOKEN)
   → 后端 _validate_otp：attempts/expiry/比对，回 {valid}，**不发 token**
   → valid: findOrCreateUser(phone)+setUser+success 建会话;invalid: 重渲染报错(手机号回填)
```

## 3. 组件

### 后端(we-meet)
- `core/api/mobile_auth.py`:抽 `_issue_otp(phone)→bool` 与 `_validate_otp(phone,otp)→(ok,err)`(DRY);`SendOtpView`/`VerifyOtpView` 改用之(mobile 契约不变,verify 之后仍 Token Exchange 返 token)。
- `core/api/keycloak_sms.py`:
  - `KeycloakOtpSendView`(`POST /api/keycloak-sms/otp/send/`):`AllowAny`+`MobileAuthThrottle`,调 `_issue_otp`,响应头 **`Access-Control-Allow-Origin: *`**(KC 页跨域 AJAX,form-urlencoded 免预检)。只回 `{success}`。
  - `KeycloakOtpVerifyView`(`POST /api/keycloak-sms/otp/verify/`):**shared-bearer `KEYCLOAK_SMS_GATEWAY_TOKEN`、fail-closed**(未配即拒),调 `_validate_otp`,回 `{valid, error}`,**不发 token**。
- `core/urls.py`:注册两路由。

### KC 插件(keycloak-phone-auth)
- `UnifiedLoginAuthenticator.java`:手机侧改单页 —— `authenticate()` 渲双栏单页(无 OTP authNotes);`action()` 手机分支读 `phone+otp`→`SmsGatewayClient.verifyOtp`→valid 建会话/invalid 重渲染报错。**移除**手机侧 OTP 生成/authNotes/resend/demo(下沉后端)。扫码侧(`qrConfirm`/`ensureQrToken`/`ScanGatewayClient`)不动。
- `SmsGatewayClient.java`:加 `verifyOtp(baseUrl,token,phone,otp)→OtpVerify`(HttpURLConnection POST + Bearer,解析 `{valid,error}`)。
- `theme/phone/login/unified-login.ftl`:手机侧单页表单(`+86` 手机号 + 验证码框内嵌「获取验证码」+「验证登录」提交 + 发码提示位)。扫码列不动。
- `theme/phone/login/resources/js/unified-otp.js`(新):「获取验证码」JS 校验手机号→`fetch` POST send(form-urlencoded)→成功启 60s 倒计时「Ns 后重发」、失败 inline 提示。
- `login.css`:`#wm-login-form` 撑满下沉 + `.wm-send-hint` 样式。

## 4. 配置 / CORS
- **无需 CORS 配置改动**:send 用 form-urlencoded 简单请求 + 响应 `ACAO:*`(免预检);verify 是 KC 服务端→后端(无浏览器跨域)。
- 认证器复用现有 config:`backend_base_url`(ftl 拼 send URL + verify URL)、`sms_gateway_token`(=`KEYCLOAK_SMS_GATEWAY_TOKEN`,verify 的 Bearer)。`demo_phones`/`demo_otp`/`otp_*` 不再被认证器用(后端 `MOBILE_AUTH_DEMO_*` 已配)。**bootstrap 无需改**。

## 5. 风险与回滚
- 改的是生产统一认证器。`phone-browser` 回滚保险仍在:异常则 realm `browserFlow` 切回 `phone-browser`。
- 部署前 Docker builder 阶段编译验证 Java(已过);错码/错多次由后端 `_validate_otp` attempts 上限拦;verify 端点 fail-closed 防暴力猜码。

## 6. 验证
1. **编译**:`docker build --target builder`(全 Java 通过)+ 后端 `py_compile`(通过)。
2. **部署**:PC `build-and-push.sh keycloak` + `build-and-push.sh backend`→`helm upgrade` → zlm `compose pull && up`。**不用重跑 bootstrap**。
3. **E2E(无痕)**:输手机号→获取验证码(收短信 / demo 号固定码)→倒计时启动、页面不刷新→输码→验证登录→建会话进 meet→开 docs 免登。
4. **边界**:错码→重渲染报错(手机号回填);错多次→attempts 拦;demo 号(13800000000/123456)可登;扫码侧不受影响仍可用。

## 7. 部署踩坑（实测暴露）
- **DRF 默认仅收 JSON**:`otp/send` 收浏览器 form-urlencoded 会回 **415**。修:该视图显式 `parser_classes=[FormParser, JSONParser]`(保「简单请求免预检」设计)。
- **ftl 变量名要与 Java `setAttribute` 完全一致**:单页重写把属性名改成 `readBase` 但漏改扫码列 ftl 的 `${readyBase}`(未定义)→ FreeMarker `InvalidReferenceException` → **整页 500**。改 theme 后务必无痕验证渲染。

## 8. 多语言 i18n（2026-07-15 上线）

**形态**:登录页**不放语言切换器**,语言完全跟浏览器 `Accept-Language` 自动匹配。支持五语(对齐 we-meet):`zh-CN / en / de / fr / nl`;命中出对应语言,全不命中由 realm `defaultLocale=en` **兜底英语**(ja 浏览器 → 英文即验证兜底)。

**实现**:
- theme UI 文案全抽 `${msg(key)}`,`messages/` 下六份 `messages[_<locale>].properties`(含无后缀 `messages.properties` 作全 locale 兜底,避免解析不到 key 直接吐 key 名);后端错误改回 **reason code**(`wrong/locked/expired/phone`),由 KC 按登录页 locale 渲染 `otp.wrong`/`otp.locked`/… ——错误提示也跟随语言。
- realm `internationalizationEnabled=true` + `supportedLocales=[zh-CN,en,de,fr,nl]` + `defaultLocale=en`,由 `deploy/aliyun/keycloak/bootstrap-i18n.sh` 落库(改 defaultLocale 单跑此脚本即可,不用重上 theme)。

**关键坑:父主题 `#kc-locale` 语言切换器在自定义 authenticator 下点击必 400。** realm 开 i18n 后基础 `template.ftl` 会渲染语言下拉,其链接是 KC 的 **client_data 重启链**(只带 `client_id/tab_id/execution/kc_locale`,丢 `redirect_uri/scope/response_type`);自定义 authenticator challenge 页点它 → KC 重启路径重新校验 redirect_uri → `400 无效的参数 : redirect_uri`(同一 redirect_uri 初始能过、重启过不了,KC 已知问题 keycloak#16063)。故 CSS `#kc-locale{display:none}` 隐藏它,纯靠 `Accept-Language` 匹配。
- **若将来要页面切换器**:别用父主题那个(必 400)。自渲染 `<select>`(`locale.supported`),change 时写 `KEYCLOAK_LOCALE` cookie + `location.assign(pathname+search)` 原样 GET 重载(别用 `reload()`——POST 重渲染页会重放表单),避开重启链。此方案本会话已跑通,后按「纯匹配」需求回退。
