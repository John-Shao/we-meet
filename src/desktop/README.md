# We-Meet 桌面端：D0 可用客户端里程碑

Windows Electron 客户端复用 `src/frontend` 和现有 Django / LiveKit / IM / Docs 服务。D0 的完成标准见 [Work 主计划 §14.0](../../docs/plan/work-module-product-architecture-agent-plan-2026-09-21.md#140-第一里程碑-d0桌面端从外壳到可用客户端)。

**2026-09-22 状态：`0.2.0-d0.7` 已安装；真实登录 / 换号、会议进出、文档编辑与附件上传 / PDF 下载、版本回退和卸载重装已有证据。真实媒体设备、原生交互提示及干净 Windows 环境仍待验收，D0 未放行。**

## 已实现的运行方式

- 安装包内置 React 产物，在专用 Electron session 中拦截配置的服务 origin：页面、字体与脚本从 `app.asar` 加载，API / media 访问真实服务。保留现有绝对资源地址、浏览器路由、Docs 同站点关系；不修改系统 DNS、不忽略 TLS 校验、不依赖 Vite 或系统 Node。
- 主窗口开启 sandbox、context isolation、web security，关闭 Node integration / webview。桥接只提供状态、登录、退出和重试；IPC 校验主窗口、主 frame、origin 及参数数量。外链只允许 HTTP(S) / mailto，交给系统浏览器。
- 登录使用系统浏览器、授权码与 PKCE S256、随机 state / nonce；校验回调目的地、重复参数、有效期、签名、issuer、audience 和 nonce。回调仅消费一次，取消 / 退出后的迟到响应不能恢复会话。
- 凭据仅在主进程使用，Windows 下通过 Electron `safeStorage`（DPAPI）加密保存。API 转发剥离 renderer 的 cookie / Authorization，仅对配置的服务注入当前 token；拒绝跨 origin frame 借用凭据。不向前端 localStorage 或 IPC 返回 token。
- 自动刷新在主进程串行合并；失效 refresh 清除本机凭据及专用 session 的旧账号缓存，并返回登录页，临时网络错误保留凭据供重试。新登录 / 退出更新会话代次，旧账号请求不能覆盖新会话；退出清除专用 session 内包括 Docs 在内的存储和缓存。退出本机账号不等于注销系统浏览器的 SSO 会话。
- API 转发使用 Node fetch 的手动重定向能力，把 30x 返回 Chromium；下一跳重新按 origin 判断，主进程 bearer 不随跨站跳转外传。已修复 Electron `net.fetch(..., redirect: 'manual')` 对 Django 补尾斜杠跳转报 `Redirect was cancelled` 的兼容问题。代理环境仍需在目标网络实测，不能将系统浏览器可联网直接等同于主进程可联网。
- 外部站点通过 Electron `net.request` 保留专用 session 的 Cookie、原始 `Referer` 和 CSRF 头，并把重定向返回 Chromium；修复 Docs 写入 403 及票据地址未跳转造成的文档刷新错误。不会向外部站点注入 Meet 原生 token，也不为缺少来源的请求构造可信来源。API 的 120 秒等待上限止于响应头，长流继续受页面取消信号控制。
- 单实例、最小化 / 恢复、退出确认、页面崩溃提示、服务连接失败提示与手动重连。退出 / 重载提示本机会议和采集中断，云端任务保持独立；不暗示关闭后仍在录音。
- 麦克风 / 摄像头限主窗口可信 origin，按本次运行授权；屏幕共享需用户手势并选择来源。首版来源列表最多展示 20 项，不默认共享系统音频；真实设备、实际屏幕共享和录音保存仍需验收。

实现入口：[main.ts](src/main.ts)、[auth.ts](src/auth.ts)、[renderer.ts](src/renderer.ts)、[forward.ts](src/forward.ts)、[policy.ts](src/policy.ts)、[preload.ts](src/preload.ts)。协议接口依据 [Electron protocol](https://www.electronjs.org/docs/latest/api/protocol)、[net](https://www.electronjs.org/docs/latest/api/net) 与 [ClientRequest](https://www.electronjs.org/docs/latest/api/client-request)，凭据存储边界见 [safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)，原生登录遵循 [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html)。

## 构建和启动

使用 Node 22.22.3 / npm 10.9.8 验证过构建；锁定 Electron **44.4.3**、electron-builder **26.15.3**、jose **6.2.2**。先安装前端与桌面依赖：

```powershell
cd src/frontend
npm ci
cd ../desktop
npm ci
npm test
npm run package
```

`package` 校验并准备 npm 锁定的 Electron 二进制，构建前端、复制资源、写入公共配置并生成 Windows x64 NSIS。首次需要下载 Electron 与 NSIS 组件；重试可复用缓存。`package:prepared` 只用于已有完整 `dist/renderer` 和 `dist/runtime-config.json`、仅调整主进程时重打包，正式发行应执行完整 `package`。

产物：`release/We-Meet-<version>-setup.exe`，配套 `We-Meet-<version>-manifest.json` 记录 SHA-256、包内 asar / 依赖锁哈希、版本、配置与源码提交及 dirty 标记；运行测试产物在 `test-results/`，两者均不入 Git。当前包来自存在其他并行工作改动的工作区，包含当时的共享前端，不能声称仅凭 HEAD 即可复现；正式交付需在明确提交基线上完整构建。前端源码构建时强制 `VITE_API_BASE_URL` 为空，使业务请求使用客户端配置的服务 origin，避免打入开发者的本地 API 地址。

默认公共配置：

| 配置 | 默认值 |
| --- | --- |
| 服务 origin | `https://meet.we-meet.online` |
| OIDC issuer | `https://id.we-meet.online/realms/meet` |
| public client | `desktop` |
| 精确回调 | `online.we-meet.desktop://oauth/callback` |
| 前端 IM origin | `https://im.we-meet.online` |
| 应用标题 | `We-Meet` |

切换部署环境时，在**构建前**设置 `WEMEET_SERVICE_URL`、`WEMEET_OIDC_ISSUER`、`WEMEET_OIDC_CLIENT_ID`、`WEMEET_IM_URL`，随后完整打包。自定义服务未指定 IM 地址时构建失败，避免混连生产 IM。构建固定前端 API 为本源，并显式注入 IM 地址与应用标题；复制前核对 `desktop-build.json`，防止配置变更后继续打包旧前端。生产配置只接受无账号密码的 HTTPS 地址，服务及 IM 地址必须是 origin；不会从安装包的运行环境任意覆盖配置。包内 `dist/runtime-config.json` 不包含 secret。

开发默认也使用已复制的本地前端资源。执行 `npm run dev` 前先完成 `build:renderer` / `copy:renderer`；需要 HMR 时可设置 `WEMEET_RENDERER_URL=http://localhost:3000` 并另启 Vite。HMR 模式用于 Web UI 调试，不作为原生凭据代理、安装包或真实登录的验收依据。`WEMEET_USER_DATA` 仅开发版有效，用于隔离测试目录。

## 统一登录服务配置

[desktop-client.json](../../deploy/aliyun/keycloak/desktop-client.json) 是独立 public client 的可审查配置：无 secret，关闭密码流 / implicit flow / service account，仅开放精确回调并强制 S256。不要复用 Android 的 client 或放宽 Web client 回调。

```powershell
# 默认只检查；复用 Keycloak 部署目录的 .env 或既有 KC_ADMIN_* 环境变量。
python deploy/aliyun/keycloak/bootstrap-desktop-client.py
# 仅在不存在时创建，已存在但不一致时停止，不自动覆盖。
python deploy/aliyun/keycloak/bootstrap-desktop-client.py --apply
```

命令在仓库根目录执行。工具不输出凭据、不跟随携带管理员凭据的 HTTP 跳转。2026-09-22 已按用户确认的现有部署执行：`meet` realm 中新建 `desktop`，回读确认 public client、精确回调与 S256；其他 client 未修改。若撤回试用，在 Keycloak 中仅禁用此 `desktop` client，不调整 Web / Android / Docs 客户端。已有部署的业务服务未重新部署。

登录时由用户在系统浏览器完成认证及“打开 We-Meet”确认。Windows 安装程序 / 启动程序注册回调协议；开发版的真实回跳验证应使用安装包，避免抢占当前安装的协议处理程序。

## 测试与当前证据

| 范围 | 2026-09-22 结果 | 证据 / 限制 |
| --- | --- | --- |
| 主进程与前端构建 | 通过 | TS、Vite；原有大 chunk 与两个静态 SVG 引用警告仍存在 |
| 安全 / 会话 / 转发回归 | 11 个测试组通过 | `npm test`：PKCE、nonce、签名、非法回调、刷新与退出隔离、路径与 origin、构建配置、外部重定向 / Cookie / 流式传输；`node scripts/forward-smoke.cjs` 额外通过真实 Electron 网络栈验证 |
| 桌面集成 | 通过 | `npm run test:smoke`；隔离 profile、打包前端、模拟匿名 API / 假媒体设备；路由刷新、允许 / 拒绝、最小化 / 恢复、取消退出、断网 / 重连、退出清缓存；重启后模拟 refresh 被撤销时只刷新一次、清除旧账号缓存并返回登录页 |
| Windows 安装 | `0.2.0-d0.7` 重装成功，退出码 0 | Windows 11 build 26200，x64，按当前用户安装到 `%LOCALAPPDATA%/Programs/WeMeetD0`；测试机有开发工具，干净 Windows 环境仍未验收 |
| 安装后的真实公共服务 | 通过 | `scripts/installed-smoke.cjs`；`app.isPackaged=true`、从已安装 `app.asar` 加载、生产 config 200、匿名 users/me（含尾斜杠跳转）401、单实例、浏览器 PKCE 入口 |
| 真实服务预检 | 10 项通过 | 用户授权的 demo 账号通过现有短信 OTP API 登录；用户资料、会议列表、会议记录、文档列表、IM 凭据接口成功；Docs 票据返回 302 且独立 Docs 会话的 users/me 返回 200。仅证明接口链路，不等同于桌面 PKCE 或业务 UI 验收 |
| 桌面真实认证 | 通过专用测试浏览器链路 | 用户授权 Playwright 后，真实 `desktop` PKCE 登录、Windows 注册协议回跳、users/me 200、重启同账号、退出后 users/me 401 / Docs Cookie 清空及两个 demo 账号切换通过。测试运行器打开独立 Chrome 并分派真实回调，未验系统默认浏览器的“打开应用”提示 |
| 桌面业务 | 部分通过 | 消息列表 / 搜索；仅本人且关闭音视频的会议进入、结束；Docs 免登、文档创建 / 编辑 / 深链接刷新；附件上传 201 且刷新保留；PDF 导出完成并检查文件头。未向他人发送消息。真实设备 / 屏幕共享 / 录音待验 |
| 文件交互 | 传输通过，原生选择器待验 | 上传为测试文字附件，下载为 5369 字节 PDF；测试运行器指定输入文件和证据目录，未把这一结果计作系统文件选择器交互通过 |
| 手动升级 / 回退、卸载 | 原测试机通过 | 多次跨版本升级保留真实会话；退出后 `d0.7 → d0.6` 回退并通过安装包冒烟；卸载退出码 0、程序删除 / 数据保留 / 原生凭据已清除；重装 `d0.7` 后冒烟通过 |
| 签名 | 未签名 | `Get-AuthenticodeSignature` 为 `NotSigned`；仅内部验收，未发布或上传安装包 |

当前 `0.2.0-d0.7` 安装包 SHA-256：`4F359E22032BAEC4DA70E179274B067A0695831107BB2F8AFC0DDA130ABD1F10`。已退出验收账号并重装该包；所有候选包的独立哈希、配置和源码状态均保留在各自 manifest，不跨版本挪用结论。

本轮版本顺序：`d0.1` 安装与 API 尾斜杠修复；`d0.2` 新登录代次隔离；`d0.3` 失效刷新清缓存并完成真实认证；`d0.4` 修复缺少 IM 构建配置导致的登录后白屏；`d0.5` 修复 Docs 来源丢失；`d0.6` 修复外部重定向隐藏最终地址；`d0.7` 限定请求超时到响应头并完成附件 / PDF 传输验证。`live-desktop-d0.3.json`、`live-desktop-d0.4.json` 保留早期失败项；后续修复证据分别见 `live-business-d0.4.json`、`live-desktop-d0.6.json`、`live-desktop-d0.7.json`，不能把早期失败记录改成全通过。

已安装包检查（会启动客户端，要求当前未登录；真实验收账号使用独立人工流程）：

```powershell
$env:WEMEET_INSTALLED_EXE = "$env:LOCALAPPDATA/Programs/WeMeetD0/We-Meet.exe"
node scripts/installed-smoke.cjs
# 真人登录：只等待状态与 users/me 响应，不填写认证表单、不记录 token。
node scripts/live-acceptance.cjs
```

`installed-smoke.json` / `smoke.json` 保存版本、时间、检查范围；PNG 保存窗口证据。真人流程只记录 API 状态，不保存账号信息。当前剩余项是系统默认浏览器与原生选择器交互、真实媒体允许 / 拒绝、屏幕共享、录音保存及采集中退出 / 重启、干净 Windows 环境；已有证据的升级、换号和业务操作不重复标成待开始。

用户授权专用自动化验收时，可用 `scripts/live-ui-session.cjs` 保持安装包测试进程独立于交互运行器，记录脱敏异常。终端需保持 stdin 打开（PTY）；支持 `status` 和 `quit`，后者用于确认无会议 / 采集后的测试退出。仅当验证下载到证据目录时设置 `WEMEET_TEST_DOWNLOADS=1`；这会代替原生保存选择器，不是产品默认行为。测试资料为 demo 账号下的“D0 桌面验收 2026-09-22”文档和 `D0-upload-fixture.txt`，均未分享给其他人。

真实服务预检使用 `scripts/live-service-check.cjs`，在桌面目录执行，运行前通过环境变量 `WEMEET_DEMO_PHONE` / `WEMEET_DEMO_OTP` 提供已获授权的 demo 账号和验证码。脚本仅接受既有 demo 号码范围，目标固定为本轮确认的部署；不写入桌面凭据存储，不发送聊天消息，不创建会议或文档。结果写入 `test-results/live-service-check.json`，只含接口名、状态码和结论，不保存 token、票据、账号身份或业务响应内容。2026-09-22 已完成 10 项检查；此脚本通过现有 mobile OTP 接口取得服务凭据，**不能作为 desktop client 的授权码 / PKCE、Windows 协议回跳或持久化会话证据**，也不能用来跳过系统浏览器登录实现。

## 内部试用的手动升级与回退

1. 保留当前安装包、版本和 SHA-256。先在客户端停止并保存录音 / 上传，离开会议，再从菜单退出；确认进程退出后安装。
2. 对照交付的 SHA-256 检查新包，在**相同安装范围与目录**运行 NSIS。内部测试可用 `/S /currentuser /D=<原安装目录>`，`/D` 必须放最后；日常用户使用向导。
3. 启动后通过“关于 We-Meet”核对版本和服务地址，验证会话恢复、消息、会议、文档及回跳。升级保留 `userData` 与加密会话；会话过期时必须重新登录，不能显示旧缓存当作已在线。
4. 回退前先退出账号并停止客户端，再运行已保存的上一内部候选包到相同目录，重新登录验证。当前会话存储为 `session-v1.enc`，将来有不兼容迁移时需单独提供迁移 / 回退策略，不能直接覆盖格式。
5. 卸载使用 Windows 应用列表或安装目录的卸载程序。配置为保留应用数据；要移除本机凭据先在客户端“退出账号”，不要以为卸载等于退出 SSO。干净安装 / 卸载验证必须使用专用测试 profile，避免删除真实录音和资料。

对外分发前需配置组织的 Windows 签名证书、验证签名 / 安装 / 升级与干净环境，并确认稳定下载地址。当前无自动更新 feed，不声称可以自动更新。macOS 构建、公证、托盘、原生通知和本地 Agent 工具不在本次 D0 已验收范围内。
