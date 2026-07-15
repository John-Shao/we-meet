# we-meet 统一 SSO 实施记录（Keycloak 手机验证码登录）

> 本文原为「Docs 接入 SSO 的实施方案」（曾在 `we-meet-docs/deploy/aliyun-docs/sso-integration-plan.md`），
> 现随实施落地迁入 `we-meet/docs/installation/`，并**按实际实施重写**（原方案的阶段二「静默桥接」未采用，见下）。
>
> 涉及三个仓库：
> - `we-meet/we-meet`（meet 前后端 + 线上 Keycloak compose + `deploy/aliyun/keycloak/` bootstrap 脚本 + `build-and-push.sh`）
> - `we-meet/keycloak-phone-auth`（KC 手机验证码认证器插件副本；原 `Meeting/keycloak-phone-auth` 供 jusi、保持不动）
> - `we-meet/we-meet-docs`（Docs 部署套件 `deploy/aliyun-docs/`）

## 实施结果（TL;DR）

**meet / docs / 未来任何接同一 realm 的 OIDC 应用，web 端统一走 Keycloak 手机验证码登录，一次登录、全产品免登（真·SSO）。** 登录、登出、demo 测试号全部实测通过（2026-07-14）。

### 与原方案的关键差异

| 项 | 原方案 | 实际实施 |
|---|---|---|
| **meet 网页登录** | 阶段二「静默桥接」：保留自建弹窗（手机+扫码）+ 后端签 HS256 断言 + KC `meet-assertion` 认证器静默建会话 | **直接走 Keycloak OIDC**：meet web 登录入口重定向到 Keycloak 手机号页（`phone-browser` flow）→ 建 KC 会话。**没做桥接/断言/meet-assertion**。更简单、更标准；代价是 web 登录从「停在 meet 页的弹窗」变「跳转 Keycloak 登录页」 |
| **flow 绑定范围** | 只绑 `docs` client（不影响 meet） | **realm 全局**（`browserFlow=phone-browser`）——所有 client 入口统一手机号页 |
| **配置方式** | 手动 Admin Console | **全程脚本化**（`bootstrap-phone-auth.sh` 等，幂等可重跑） |
| **KC 镜像构建** | aliyun-zlm 本机 `docker build` | **PC build → 火山 CR → ECS pull** + `--optimized`（2C2G ECS 本机 `kc.sh build` 会 OOM 137）；纳入 `build-and-push.sh keycloak` |
| flow 名 / 结构 | `browser-phone`，仅 Phone OTP(Required) | `phone-browser`，`Cookie(ALT) + phone-forms 子流(ALT) → phone-authenticator(REQUIRED)`（Cookie 分支保留 SSO 免登；phone-authenticator 只支持 REQUIRED/DISABLED，故必须放进 ALTERNATIVE 子流才能与 Cookie 共存） |

自建 mobile OTP 弹窗（`LoginDialog`/`PhoneLoginPanel`/`QrLoginPanel` → `/api/mobile/auth/*` + token-exchange）**保留给原生 App**，web 端不再触发（成 dead code，留待清理）。

### 目标架构（两类客户端）

| 客户端 | 登录方式 | 会话 |
|---|---|---|
| 原生 App | mobile OTP API（`/api/mobile/auth/*`）+ token-exchange（**不变**） | App 自持令牌，不建 KC 浏览器会话 |
| **web**（meet / docs / 未来 OIDC 应用） | **Keycloak 浏览器手机验证码登录**（`phone-authenticator` 插件） | 共享同一 KC 浏览器会话 → 全免登 |

> 为什么 mobile OTP 给不了 SSO：它走 token-exchange、令牌存前端 localStorage，**不在浏览器建立 Keycloak 会话**；去 docs 时 KC 认不出用户 → 重新登录。SSO 必须由一次「浏览器 → KC 登录页」的重定向建立会话。这正是把 web 登录改走 OIDC 的根本原因。

---

## 一、backend SMS 网关（前置）

Keycloak 的 phone-auth 插件自己生成 OTP，POST 给 meet 后端发短信。该网关原本不存在，已补：

- `core/api/keycloak_sms.py`（`KeycloakSmsGatewayView`）：校验 `Authorization: Bearer <KEYCLOAK_SMS_GATEWAY_TOKEN>`（token 非空则强制校验）→ 从 message 正则提取验证码 → 复用 `mobile_auth._send_sms`（火山短信）下发。
- `core/urls.py`：加**顶层**路由 `keycloak-sms/send/`（**不在 `/api/` 下**）。
- `meet/settings.py`：加 `KEYCLOAK_SMS_GATEWAY_TOKEN`（`values.secrets.yaml` 填真实值 + `.dist` 占位）。

### ⚠️ ingress 路由（否则 405）

`/keycloak-sms/send/` 是顶层路径，而 meet 主 ingress 默认只把 `/api`、`/external-api` 转给 backend，其余落 **frontend 静态 nginx** → 对 POST 直接 **405**（请求根本没到 Django）。修复：`values.meet.yaml` 的 `ingress.customBackends` 加一条（chart 现成扩展位，不改模板）：

```yaml
ingress:
  customBackends:
    - path: /keycloak-sms/
      pathType: Prefix
      backend:
        service: { name: meet-backend, port: { number: 80 } }
```

**验证**（不带 token 应 401，证明鉴权生效）：
```bash
curl -i -X POST https://meet.we-meet.online/keycloak-sms/send/ \
  -H "Content-Type: application/json" -d '{"msisdn":"13800000000","message":"code 123456"}'
```

---

## 二、Keycloak phone-auth 插件镜像

插件源：`we-meet/keycloak-phone-auth`（provider id `phone-authenticator`、显示名「Phone OTP Authentication」、自带 `phone` 登录主题；`SmsGatewayClient` POST `{msisdn,message}` + `Authorization: Bearer` 到网关）。

### 构建 / 部署（PC build → CR → ECS pull）

2C2G 的 `aliyun-zlm` 本机跑 `kc.sh build`（Quarkus augmentation）会 **OOM（exit 137）**。所以：

1. **Dockerfile** 里 `kc.sh build` **bake 了 build-time 选项**（供 `--optimized` 启动、免运行时 augmentation）：
   ```
   RUN kc.sh build --db=postgres --health-enabled=true --features=token-exchange,admin-fine-grained-authz
   ```
   这些必须与 `compose.yaml` 的 build-time env 一致。
2. **PC build + push 火山 CR**（纳入统一脚本，keycloak 为可选模块、tag 固定 `25.0-phone`、Dockerfile 在外部仓库）：
   ```bash
   bash deploy/aliyun/build-and-push.sh keycloak
   # → jusi-cn-guangzhou.cr.volces.com/we-meet/keycloak:25.0-phone
   ```
3. **`compose.yaml`**：`image` 指向该 CR tag，`command: [start, --optimized]`。ECS 只 `docker compose pull && up -d`（秒起、不 build、不 OOM）。

> 版本：Dockerfile `ARG KC_VERSION=25.0`（对齐线上 `id.we-meet.online`）。原 `Meeting/keycloak-phone-auth` 停在 KC26 供 jusi，两副本独立。

---

## 三、Keycloak flow 配置（`bootstrap-phone-auth.sh`）

全脚本化，在 `we-meet/deploy/aliyun/keycloak/`，用 admin REST API，幂等可重跑：

```bash
cd ~/we-meet/deploy/aliyun/keycloak
PHONE_FLOW_BINDING=realm bash bootstrap-phone-auth.sh
```

做的事：
1. 建顶层 flow `phone-browser`：`Cookie(ALTERNATIVE) + 子流 phone-forms(ALTERNATIVE) → phone-authenticator(REQUIRED)`。
2. 配 authenticator：`sms_gateway_url` = `https://meet.we-meet.online/keycloak-sms/send/`、`sms_gateway_token`（= backend `KEYCLOAK_SMS_GATEWAY_TOKEN`）、`otp_length=6`/`otp_expiry_seconds=300`/`otp_max_attempts=3`、`demo_phones`/`demo_otp`（见六）。
3. `loginTheme=phone`。
4. **绑定**：`PHONE_FLOW_BINDING=realm` → realm `browserFlow=phone-browser`（所有 client 统一）。`=client` 只绑 meet client（docs 直接入口会退回密码页）；`=none` 只建 flow 不绑。

**token 三处必须逐字符同值**：backend `values.secrets.yaml` 的 `KEYCLOAK_SMS_GATEWAY_TOKEN` ↔ keycloak `.env` 的 `KEYCLOAK_SMS_GATEWAY_TOKEN`（`bootstrap-phone-auth.sh` 从这读）↔ authenticator config 的 `sms_gateway_token`。任一不一致 → 插件调网关 401、发不出码。

> 注意脚本要在有 `.env`（含 admin 凭据 + `SMS_GATEWAY_URL` + `KEYCLOAK_SMS_GATEWAY_TOKEN`）的机器跑（通常 aliyun-zlm）。它连的是远程 KC admin API，在哪跑都配同一个 realm，但 `.env` 缺 token 会把 `sms_gateway_token` 配成空。

---

## 四、meet 前端走 OIDC（替换自建弹窗）

`we-meet/src/frontend`。上游 la-suite/meet 本就走 OIDC；we-meet 曾加 `else` 分支弹自建 mobile OTP 弹窗（注释还写「legacy Keycloak OIDC page is a dead end」）。装了 phone-auth 插件后那个「dead end」复活成手机号页，故改回 OIDC：

- `components/LoginButton.tsx`（header 登录）：`else` 分支从弹 `LoginDialog` → `onPress={() => { window.location.href = authUrl() }}`。
- `features/home/routes/Home.tsx`（首页 hero 匿名登录）：内联的 `DialogTrigger + LoginDialog` → 同样 `authUrl()`（**这个是单独入口、不走 LoginButton，容易漏**）。

`authUrl()`（`features/auth/utils/authUrl.ts`）= `/authenticate/?returnTo=...` → backend OIDC RP → Keycloak `phone-browser` flow。登录建 KC 会话 → docs 等走 OIDC silent 免登。

部署：`bash deploy/aliyun/build-and-push.sh frontend` → ECS `kubectl -n meet rollout restart deploy/meet-frontend`。

---

## 五、logout 白名单

RP-initiated logout 报 `Invalid redirect uri` / 400：client 的「Valid post logout redirect URIs」为空/不含回跳地址（老 client 建于脚本加该 attribute 之前）。且 **backend `LOGOUT_REDIRECT_URL` 无尾斜杠**（`https://meet.we-meet.online`），KC `/*` 通配匹配不到裸域名 → 白名单要放**带/不带斜杠两条**。

- 现有 client：`bash bootstrap-logout-uris.sh`（admin API 给 meet + docs client PUT 更新，`##` 分隔两条，幂等）。
- 新建 client：`bootstrap-realm.sh`（meet）/ `bootstrap-docs-client.sh`（docs）的 `post.logout.redirect.uris` 已改宽松（`https://host##https://host/*`）。

---

## 六、demo 测试号（app 审核 / 测试）

backend 侧 demo（`core/api/mobile_auth.py`）：`MOBILE_AUTH_DEMO_PHONES`（`13800000000`–`13800000009`）用 `MOBILE_AUTH_DEMO_OTP`（`123456`）固定码、跳短信（`values.meet.yaml` L127-128）。web 转 Keycloak 后，插件自己生成随机 OTP、发真短信，**不认 backend demo** → 测试号失效。

修复：给插件加 `demo_phones` / `demo_otp` 两个 config（`PhoneAuthenticator.issueOtp`/`isDemoPhone`：demo 号返回固定码、跳 `SmsGatewayClient`；Factory 加两个 config 项）。`bootstrap-phone-auth.sh` 默认对齐 backend 写入（`DEMO_PHONES`/`DEMO_OTP` env 可覆盖，留空 `DEMO_OTP` 即禁用）。

> **⚠️ 改插件逻辑要两步都做**：① `build-and-push.sh keycloak` rebuild 镜像 + `compose pull/up`（旧镜像不认新 config）② 重跑 `bootstrap-phone-auth.sh` 写 config（不重跑 config 里没 demo）。只做一步 demo 不生效。

---

## 部署顺序（首次 / 全量）

1. **backend**：`build-and-push.sh backend` → sync `values.secrets.yaml`（含 `KEYCLOAK_SMS_GATEWAY_TOKEN`）到 ECS → 改 `values.meet.yaml`（`ingress.customBackends`）→ `helm upgrade meet`。验证网关不带 token 返回 401。
2. **Keycloak 镜像**：`build-and-push.sh keycloak` → aliyun-zlm `docker compose pull && up -d`（`--optimized`）。
3. **flow**：`PHONE_FLOW_BINDING=realm bash bootstrap-phone-auth.sh`（写 flow + config + demo + realm 绑定）。
4. **logout**：`bash bootstrap-logout-uris.sh`。
5. **前端**：`build-and-push.sh frontend` → `rollout restart deploy/meet-frontend`。
6. **验证**（见下）。

## 端到端验证

- 无痕开 `meet.we-meet.online` → header / hero 两个「登录」都跳 Keycloak 手机号页 → 收码 → 登录。
- 同浏览器开 `docs.we-meet.online` → **免登直接进**（SSO）。
- 直接先开 `docs.we-meet.online`（未登录）→ 点「开始写作」→ 也跳手机号页（realm 全局）→ 登录 → 回 docs。
- **logout** → 正常清会话跳回首页（不 `Invalid redirect uri`）。
- **demo 号** `13800000000` + 固定码 `123456` → 直接进验证码页、不发真短信 → 登录成功（KC 日志见 `demo phone … fixed OTP, SMS skipped`）。

## 关键文件

| 仓库 | 文件 | 作用 |
|---|---|---|
| we-meet | `src/backend/core/api/keycloak_sms.py` / `core/urls.py` / `meet/settings.py` | SMS 网关 + token |
| we-meet | `src/helm/env.d/aliyun-prod/values.meet.yaml`（`ingress.customBackends`）/ `values.secrets.yaml(.dist)`（token） | ingress 路由 + 密钥 |
| we-meet | `deploy/aliyun/build-and-push.sh` | 含 keycloak 模块（外部仓库 / CR / 固定 tag） |
| we-meet | `deploy/aliyun/keycloak/compose.yaml` | KC 镜像（CR tag）+ `--optimized` |
| we-meet | `deploy/aliyun/keycloak/bootstrap-phone-auth.sh` | flow + config + demo + 绑定 |
| we-meet | `deploy/aliyun/keycloak/bootstrap-logout-uris.sh` / `bootstrap-realm.sh` | logout 白名单 |
| we-meet | `src/frontend/src/components/LoginButton.tsx` / `features/home/routes/Home.tsx` | web 登录改走 OIDC |
| keycloak-phone-auth | `src/we/meet/keycloak/PhoneAuthenticator.java` / `PhoneAuthenticatorFactory.java` | 插件 + demo 逻辑 |
| keycloak-phone-auth | `Dockerfile` | KC25 + 插件 + `kc.sh build` bake |
| we-meet-docs | `deploy/aliyun-docs/bootstrap-docs-client.sh` | docs client（含 logout 白名单） |

## 风险与回滚

- **KC 镜像**：换镜像有 ≈1 分钟认证中断。回滚 = `compose.yaml` image 换回 `quay.io/keycloak/keycloak:25.0`（provider/主题不影响原有流程）；换镜像前 `pg_dump` 备份 KC 库。
- **realm 全局绑定**：`browserFlow=phone-browser` 后 realm 下**所有 web 登录变手机号 OTP**，`bootstrap-realm.sh` 建的密码测试用户 `meet@we-meet.online` 登不了（真实用户皆手机号，无妨）；**admin console（master realm）不受影响**。回滚 = PUT realm `browserFlow` 改回 `browser`。
- **token 不一致 / 网关不通**：手机页发码失败 → 先 `curl` 网关、核对三处 token。
- **不触碰 token-exchange**：原生 App / mobile OTP 不受影响。

## 后续（状态记录，备查）

1. **静默桥接（原阶段二，已放弃❌️）**：原计划让 meet web 保留自建弹窗、后台桥接建 KC 会话（`meet-assertion` 认证器 + 后端签 HS256 断言 + `kc_bridge` cookie）。**实际改为 web 直接走 OIDC**（更简单、标准、无需新认证器/断言安全面）。若未来要「保留 meet 弹窗 UX 又要 SSO」，可回到此思路 —— 但需重新评估断言安全（≤60s、单次 jti、专用密钥、cookie `HttpOnly/Secure/SameSite`）。
2. **KC 25 → 26 升级（已放弃❌️）**：原计划全集群版本统一。**已放弃** —— KC 25 已稳定投产、phone-auth 插件在 25 上跑通，升级 26 需重点复验 token-exchange（KC26 有重构，meet mobile OTP / App 全靠它）+ 插件换 26 build + DB 单向迁移，复验成本高、而版本统一收益不紧迫，无限期搁置。若将来确需升级再评估：前置 `pg_dump` 备份、保留 25 镜像可回滚、复验 token-exchange 与 Caddy hostname、插件换 26 build。
3. **登录界面品牌化（✅ 已完成 2026-07-15）**：`phone` 主题已做成 we-meet 品牌页 —— LaSuite Meet logo + 浅蓝渐变底 + 白卡片居中 + 灰底填充输入框（`+86` 前缀）+ 品牌蓝按钮 + 《用户协议》《隐私政策》页脚；验证码页含掩码手机号、框内「重新发送」+ 60s 倒计时、「‹ 重新输入手机号」重置链接。同时**修复 i18n 坑**：realm 默认 locale=`en`、主题只有 `messages_zh_CN` 时所有 `${msg(...)}` key（含服务端错误 `otp.wrong`/`phone.invalid`）会吐原始 key —— 加基础 `messages.properties` 作全 locale 兜底 + UI 文案硬编码双保险。实现见 `keycloak-phone-auth/theme/phone/login/`（`phone-input.ftl`/`phone-otp.ftl`/`messages/`/`resources/{css,js,img}/`），用自有 `wm-*` class、不依赖 PatternFly 内部类名。⚠️ KC 静态资源按**版本号**缓存（非文件内容），改主题后须无痕窗口或 `Ctrl+F5` 验证。
4. **手机用户 profile 合成（✅ 已实现）**：手机用户没 email/姓名会触发 Keycloak `VERIFY_PROFILE`、卡在「Update Account Information」页逼手填。插件 `PhoneAuthenticator.fillProfile()` 在建号/登录时**补全缺失字段**：`email = <手机号>@phone.we-meet.online`（`email_domain` config 可配，`bootstrap-phone-auth.sh` 传）+ `emailVerified=true`、`firstName = meet-<后4位>`、`lastName = we`。新老用户下次登录自动补全，profile 完整即不再触发 VERIFY_PROFILE（无需关 required action）。改后同样要 rebuild 镜像 + 重跑 bootstrap（写 `email_domain`）。
   > ⚠️ **已知隐患（保持现状、记录备查）**：`fillProfile` 只补**缺失**字段、**不覆盖已有值**。早于本功能建号的**老手机用户**（App mobile OTP 后端建号，已写合成 email 但 `emailVerified=Off`）重新登录时 email 非空 → 不进补 email 分支、`emailVerified` 仍 Off。**当前无碍**（realm 未启用 Verify Email required action，登录不被拦）；若将来**启用 Verify Email**，这批 verified=Off 的手机用户会被要求验证邮箱、又卡住（无真邮箱）。届时处理二选一：① `fillProfile` 改成「合成域名 email 一律 `setEmailVerified(true)`」+ rebuild；② admin API 批量刷老手机用户 `emailVerified=true`。
5. **dead code 清理**：web 端不再用的 `LoginDialog`/`PhoneLoginPanel`/`QrLoginPanel`（`api/mobileOtp.ts` 得留着，App 用）。
