# Work R0a 移动实机验证（2026-11-01）

**结论：R0a 的移动只读契约在真机上成立**（Composer/创建、编辑、采纳、取消、重试均不出现，只留查看与下载），但**管理面 `/admin/work` 在真机上暴露出 3 处问题**：F1 窄屏写按钮（John 判定不豁免）、F2 席位表列粘连、F3 配额期间未标注。三项已修复并随 `0fdd6bccd`（Helm revision **528**）发布，**同一台真机复验全部通过**（见文末「发布后真机复验」）。本目录是移动实机证据，不等同 D5 全量验收。

## 执行环境与传输

| 项 | 值 |
|---|---|
| 设备 | HONOR `AMM-AN00`，Android 16（SDK 36），物理 1200×2664 @520dpi |
| CSS 视口 | **369px**（`window.innerWidth`，低于 `useReadOnlyViewport` 的 767px 阈值） |
| 浏览器 | Chrome 138.0.7204.45（真机，非模拟器、非 devtools 设备模拟） |
| 驱动 | USB adb（SDK platform-tools）→ `adb forward tcp:9222 localabstract:chrome_devtools_remote` → Playwright 1.62.1 `connectOverCDP` |
| 截图 | `adb exec-out screencap -p`（设备屏原图，含浏览器 UI） |
| 站点 | `https://meet.we-meet.online`（生产，Helm revision 527 前端） |
| 登录 | 由 John 在手机上完成 Keycloak 手机号 OTP 真实登录；**未**使用移植的桌面会话 |
| 会话核对 | `GET /work/v1/bootstrap` 200、`org=Default Organization`、`csrf_token` 已签发 |

登录页在 369px 下渲染正常：`+86`、手机号、验证码、「获取验证码」「验证登录」齐全（`kc-front.png`）。

## 路由结果（`mobile-run.json`，脚本 `verify-work-mobile.cjs`）

| 路由 | 只读媒体查询 | textarea | 横向溢出 | 可见按钮 | 关键链接 |
|---|---|---|---|---|---|
| `/work` | 是 | 0 | 无 | 查看全部工作 | 首页/我的工作/历史/管理 + 3 个任务卡 |
| `/work/new` | 是 | 0 | 无 | 查看全部工作 | 同上（无 Composer） |
| `/work/items` | 是 | 0 | 无 | 加载更多 | 任务列表 |
| `/work/archive` | 是 | 0 | 无 | — | 导航 + 空态 |
| `/work/items/{taskId}` | 是 | 0 | 无 | 查看成果 | 返回我的工作、下载 Markdown（`?disposition=attachment`）、打开成果工作区 |
| `/work/items/{taskId}/artifacts/{artifactId}?version=1` | 是 | 0 | 无 | 版本 v1 芯片 | 返回任务、下载 Markdown |
| `/admin/work` | 是 | 0 | 无 | **创建导出** | 无（走 meet Admin shell，无 Work 导航） |

抽样任务 `de7d87c8…` / 成果 `10fee3b1…`（`awaiting_acceptance`、Run `succeeded`、正文 1,050 字节、`sha256:6682c575c…`）。

**移动只读契约成立的证据**：任务工作区显示「移动端为只读模式：可查看目标、时间线和成果；创建、编辑、采纳、取消和重试请使用更宽的屏幕。」；成果页显示「移动端为只读模式：可查看与下载成果，采纳请在更宽的屏幕操作。」并保留下载与版本列表；`/work` 与 `/work/new` 显示「创建任务需要更宽的屏幕，请在平板或电脑上新建工作。」且 textarea 数为 0。7 条路由 `scrollWidth == innerWidth`，无横向溢出。

## 真机暴露的问题

**F1 管理面在窄屏仍提供写操作。（已判定并修复，未部署）** `/admin/work` 曾在 369px 下显示「创建导出」按钮（`POST /work/v1/admin/audit-exports`）。**John 2026-11-01 判定：管理面不豁免移动只读规则**——审计导出属写动作，窄屏不提供。已按 `useReadOnlyViewport` 实现：`<768px` 时导出卡片只保留标题与提示「审计导出请在更宽的屏幕发起。」，表单与按钮不渲染；概览与席位表照常只读。e2e 双向覆盖：369px 断言按钮数为 0 且提示可见，1280px 断言「创建导出」仍可见（防止过度隐藏）。本轮真机仍未点击该按钮，管理面写路径的真机行为未验证。

**F2 席位列表在窄屏列粘连。（已修复，未部署）** 截图 `m-admin.png` 显示角色/状态/Work 席位三列挤成 `memberactive否`，根因是席位表单元格完全没有内边距（`AdminPage.tsx` 的 `<table>` 只有 `width/borderCollapse`）。修复：四列表头/单元格统一加 `paddingY: xs` + `paddingInlineEnd: md`、表头 `whiteSpace: nowrap`、成员列 `wordBreak: break-all`、行间分隔线，表头补 `scope="col"`。回归用例在 **369×844 视口**（真机同宽）mock 管理接口，断言四列文本各自独立、相邻单元格文本框水平间距 ≥4px、页面无横向溢出。**正负对照**：同一条用例跑在 codegen 之前（旧 CSS、无内边距）的服务器上失败于 `Received: 0`，重新 `panda codegen` 后通过。成员列仍显示裸 UUID：`GET /work/v1/admin/seats` 只返回 `subject_id/role/status/work_seat/revision`，要显示姓名需接口补字段，本轮未改。

**F3 组织概览的配额是当前期间口径且未标注。（已判定并修复，未部署）** 页面曾显示「已结算 / 配额（Token） 0 / 0」「预留 Token 0」，而同一时刻任务级读回（144 个任务分页遍历）仍有 **9 个任务各持 100,000、合计 900,000 预留**，且当日 E8 结算 45,549。根因：`work.quota_account` 按 `(org_id, account_key, period_id)` 唯一，概览只读当前期间（`quota_period_id=2026-11`），而 9 笔预留创建于 2026-10-30、落在 `2026-10` 期间账户。**John 2026-11-01 判定：标注期间 + 运维注记**（不为此加后端字段）。已实现：概览新增「配额期间」一行直接展示接口已返回的 `quota_period_id`；运维 Runbook 增 §5.17 说明「预留 0 ≠ 没有 held 预留」及两条只读核对路径（任务面 `?limit=100` 遍历 / `work-reconcile -scan`）。**已知限制**：管理页不汇总跨期未释放预留。

## 发布后真机复验（2026-11-01，Helm revision 528）

同一台 HONOR `AMM-AN00`、同一会话（`/work/v1/bootstrap` 200）、同一 369px 视口，对 `/admin/work` 复跑 `verify-f123.cjs`（结果 `post-release-checks.json`）：

| 判定 | 结果 |
|---|---|
| `(max-width: 767px)` 命中 | 是 |
| 「创建导出」按钮数 | **0**（F1 生效） |
| 宽屏提示「审计导出请在更宽的屏幕发起」 | 可见（页面尾部文本一致） |
| 「配额期间」标签与值 | 可见，值为 `2026-11`（F3 生效） |
| 席位表首行四列文本 | `03a7c56e-91f4-…` / `member` / `active` / `否`，相邻文本间距 **14.7 / 12 / 12 px**（F2 生效，修复前为 0） |
| 横向溢出 | 无（`scrollWidth == innerWidth`） |

截图 `admin-after.png`（概览含「配额期间 2026-11」＋席位表列已分开）与 `admin-export-card.png`（导出卡片只剩提示）。线上 bundle 为 `/assets/index-ClRLKydd.js`（发布前是 `index-43bSDm7P.js`），容器内 `grep` 亦在 `assets/work-ZLCJa9HU.js` 命中两处新文案。

## 边界

- 单一机型（HONOR/Android 16/Chrome 138）；**未**覆盖 iOS/Safari、微信内置浏览器、平板断点（768–1023px）与桌面断点的真机对照。
- 移动端按设计不执行创建/编辑/采纳/取消/重试，因此这些动作在真机上「不出现」是证据，「能正常工作」仍由桌面浏览器与测试覆盖。
- 未点击「创建导出」，管理面写路径的真机行为未验证（发布后窄屏已不再渲染该按钮，因此这条缺口在移动面上不可再触发，桌面侧仍未点过真机以外的负例）。
- F1/F2/F3 的修复已随 `0fdd6bccd`（Helm revision 528）发布并在同一台真机复验通过；本目录前文的 7 张 `m-*.png` 与 `m-admin.png` 仍是**修复前**状态，保留作对照。
- 未做弱网/离线/横屏/系统字体放大与读屏器检查（axe 只在桌面视口跑过）。
- 本目录证明移动只读契约与管理面缺陷，不构成 R0a 全部验收；U1（11-27）与 C22（11-06/15-16）仍按排期。
