# Work R0a 例外复核单（Lily）

日期：2026-10-31  
范围：本单当时处理 R0a 中 **John 已签、Lily 尚未复核** 的两项范围例外。**两项均已于 2026-10-31 补齐并获接受，本单已闭环**；2026-11-01 起独立复核人离队，剩余悬挂项的承接方式见文末「复核承接」节。Node 队列、modelparams 默认值、F0-R4 静态证书三项已由 John 主签、Lily 经 John 转述复核，不在本单重复。

## E1 管理只读范围例外

**现状（可核）**——指 **2026-10-31 签收当时**的状态；本小节结论已被下文「补齐并部署」取代，不再成立
- Go API 只实现任务面路由；OpenAPI 设计中的 admin 只读 6 接口没有 Go 出口。
- `/admin/work` 管理只读 UI 未实现，导航不提供该入口。
- 数据库层已有 admin 读相关 SQL 函数，但没有新增 HTTP/UI 暴露面。

**John 的签收**
- 2026-10-31 接受 R0a 试点不交付 admin 读接口与 `/admin/work`。
- UT5（管理只读验收）不执行；在 R0b/P1-A 再补。
- 记录位置：[work-project.md](work-project.md) 完成度审计 D2′/D5 行。

**安全与数据边界**
- 不新增 admin HTTP 路由、页面或下载入口；现有任务面的 owner/seat/RLS 与 CSRF 规则不变。
- 当前管理员无法通过产品 UI 查看组织级任务/用量；如运营需要，只能走既有数据库权限与审计流程。
- 若试点要求管理员自助查看管理数据，或新增任何 admin HTTP 面，本例外自动失效并需重新评审。

**Lily 答复（2026-10-31）**
- **不接受该例外，要求补齐接口和页面后再验收。**
- 需补齐：6 个管理只读接口（overview、seats、audit-exports 创建/查询、download-ticket、content）与 `/admin/work` 管理只读页面；UT5 按补齐后的实现执行。
- 追加约束：当前 `work.audit_export` 只有数据层，没有导出 worker；补齐 6 个接口时必须同时实现可用的导出作业（queued→ready、CSV 内容、一次性下载），否则 content 接口永远 not_ready，不能算补齐。

**2026-10-31 补齐并部署（Lily 已复核接受）**
- 6 个接口已实现：`GET /work/v1/admin/overview`、`GET /admin/seats`、`POST /admin/audit-exports`、`GET /admin/audit-exports/{id}`、`POST .../download-ticket`、`GET .../content`。
- 审计导出 worker 已实现并 systemd 常驻：queued→ready、CSV/JSON 写入 Content Store、一次性下载；真实导出 515 行 / 162,897 字节，ticket 200、content 200。
- `/admin/work` 只读页面已发布（frontend `2bc81cab5`，Helm revision 526）；真实 owner 会话渲染组织概览、14 个席位、导出表单；非 admin 的 API 负例测试返回 403 `admin_access_denied`。
- UT5 的完整管理只读验收按补齐后的实现执行；本单不再把 E1 视为已签例外。**2026-11-01 承接**：独立复核人离队后，该项由 John 自决判定（依据见「复核承接」节），不再写「待 Lily 复核」。

**Lily 复核结论（2026-10-31，补齐后）**
- **接受** 6 个管理只读接口、`/admin/work` 页面和审计导出 worker 的当前实现；
- 未提出附加条件，也未额外要求 UT5 场景；E1 关闭，不再作为范围例外。

## E2 成果独立路由简化

**现状（可核）**——指 **2026-10-31 原签当时**的状态；独立成果页随后按 Lily 要求补齐并发布（`42e4736bd` / Helm revision 527），本小节不再成立
- 成果预览、下载、版本采纳继续内嵌在任务工作区。
- 未实现独立 `/work/items/:taskId/artifacts/:artifactId` 页面。
- 成果访问仍受任务 owner 校验、artifact 版本校验与下载令牌约束，没有公开分享链接。

**John 的签收**
- 2026-10-31 接受“成果内嵌任务工作区”的 D5 简化。
- 触发重评审条件：需要独立成果深链、分享，或独立导航入口。
- 记录位置：[work-project.md](work-project.md) 完成度审计 D5 行。

**安全与体验边界**
- 不新增成果公开 URL；现有下载响应头（`no-store`、`nosniff`、附件文件名）不变。
- 通知/外部链接不能直接打开某个成果版本；移动端也没有成果深链。
- 若需要从通知跳转到成果、跨任务引用成果或对外分享，本简化失效。

**2026-10-31 补齐（已实现并发布，部署证据见本节末尾）**
- Go API 新增任务级只读路由：`GET /work/v1/tasks/{taskId}/artifacts/{artifactId}`（任务摘要 + 版本列表 + 已采纳版本）、`GET .../versions/{versionNo}`、`GET .../versions/{versionNo}/content`。
- 深链权限在 SQL 层同时校验组织、任务 owner、`artifact.task_id = taskId`、artifact/version 已发布；跨任务、非 owner、跨组织、staged 版本统一返回 404 `artifact_not_found`，正文仍校验 Content Store 的 hash 与字节数。
- 前端新增独立页面 `/work/items/:taskId/artifacts/:artifactId`，支持 `?version=`、版本列表与采纳标记、Markdown/文本预览、下载、按版本采纳、移动端只读；任务工作区成果面板新增“打开成果工作区”入口。
- 本地验证：Go `go test ./... -p 1 -count=1` 全绿（`internal/api` 48.977s，含跨任务/非 owner/跨组织/无席位负例）；前端 Work 测试 66/66、全量 1772/1772、`tsc -b` 与 `npm run build` 通过。
- **2026-10-31 已部署**：提交 `42e4736bd`；Work API 二进制 sha256 `8fe824b8…` 安装并 restart，`/proc/<pid>/exe` 未删除、`healthz=200`、未登录深链 401；前端镜像 `meet-frontend:42e4736bd`（digest `sha256:fdd76efc…`）发布为 Helm revision **527**。
- **生产浏览器验收（真实登录）**：任务 `a6365a66…` / 成果 `f8a1a8b5…`，直接打开 `/work/items/…/artifacts/…?version=1` 渲染标题、待验收状态、版本列表与 4449 字节正文；任务工作区“打开成果工作区”链接指向同一深链；下载响应 `text/markdown`、`no-store`、`nosniff`、RFC 5987 附件名，正文与版本一致；`/work` 与 `/im` 正常，bundle `index-43bSDm7P.js`。
- **生产深链负例**：同 owner 下错误 artifact、错误 task、错误 task 的 content 均返回 404 `artifact_not_found`；正确 task+artifact 返回 200 且恰好 1 个版本。
- **证据边界**：当前 in-app browser 视口为 561px，页面按设计显示移动端只读，未在浏览器点击采纳；采纳按钮/版本切换由前端测试覆盖。生产该成果只有 1 个版本，跨版本切换由测试覆盖。页面能力与内嵌面板对齐（预览、版本切换、下载、按版本采纳），本轮未新增成果正文编辑/保存入口。
- **CI**：`Work R0a gates` 与 `Release guard` 成功；`meet Workflow` 仅 `test-e2e` 的既有 `work-a11y` 无 session 用例失败，其余 14 个 job 成功，发布未依赖该失败 job。

**请 Lily 复核**
- [x] 接受独立成果页与任务级深链权限
- [ ] 有条件接受（条件：__________）
- [ ] 不接受（原因：__________）

**Lily 复核结论（2026-10-31，经 John 转述）**
- **接受** 独立成果页与任务级深链权限的当前实现；
- 未提出附加条件；E2 关闭，不再作为范围例外。本会话无 Lily 本人书面记录，按转述记录。

## 证据与边界

- 历史页、旧链接和 `/work/new` 已随 frontend `645460d5b` 发布生产（Helm revision 523）并做真实浏览器验收；证据见 [work-project.md](work-project.md) D5 行。
- 生产当前没有 `display_state=archived` 任务，归档列表只有空态证据；移动实机仍未验证。
- 本单只请求对两项范围例外做判断，不把 John 的签收写成 Lily 的复核，也不把例外写成功能已实现。

## 签收栏

| 项 | John（主签） | Lily（复核） | 日期 |
|---|---|---|---|
| E1 管理只读范围例外 | 已签 2026-10-31 | **接受 2026-10-31（补齐后，无附加条件）** | |
| E2 成果独立路由 | 原签简化 2026-10-31；否决后已补齐 | **接受 2026-10-31（经 John 转述，无附加条件）** | |

建议在 C22 环境预检（2026-11-06）前完成复核。**2026-11-01 起该路径失效**，见下一节。

## 2026-11-01 复核承接（独立复核人离队）

**事实**：Lily 于 2026-11-01 离队，R0a 不再有独立复核人，也不再有可指派的第二署名者。因此本单及状态源里所有「待 Lily 复核 / 待 reviewer 复核」都变成无人可答的悬挂项。

**承接方式（John 自决，2026-11-01）**

1. 未答的复核项一律降级为**自决日志 + 延迟复评**：由 John 记录判定与依据，**2026-11-08** 复评一次（7 日窗口），不新增署名者、不伪造外部接受。
2. 措辞永久改写：`待复核` → `自决判定，未经外部复核（无独立复核人）`。历史上已发生的「经 John 转述接受」保留为历史事实，**不追认为 firsthand**，也不得反过来当作外部复核证据。
3. 证据门槛不降：人工判定项必须逐条给出依据（E8 的三项已有 `manualAssessment` 依据与样本），参数类决策必须留决策记录与回归证据（`maxOutputTokens=4096` 已有 `work-r0a-modelparams-4096-2026-10-31.md` 与 18/18 通过证据）。
4. 签收完整性口径随之改写：不再表述为「John 已签、Lily 未复核 → 签收不完整」，而是「**R0a 全部结论均为自决，未经外部复核**」；缺的是独立视角，不是某个签名。

**受影响的悬挂项（本单内已闭环，仅承接说明）**

| 项 | 原状态 | 承接后 |
|---|---|---|
| E1 管理只读补齐后的 UT5 完整验收 | 待 Lily 按补齐实现复核 | John 自决：以已部署实现 + 真实导出 515 行/162,897 字节 + owner 页面与非 admin 403 为验收依据；**未经外部复核**，11-08 复评 |
| E2 独立成果页 | 已获接受（经转述） | 保留为历史转述接受，标注非 firsthand |
| E8 人工三项检查 | 待 reviewer 复核 | John 自决判定（依据见 `e8-golden-2026-11-01/pilot-run.json` 的 `manualAssessment`）；**未经外部复核**，11-08 复评 |
| `maxOutputTokens` 1024 → 4096 | 参数决策记录 | John 自决，回归证据 18/18；**未经外部复核**，11-08 复评 |

**不再做的事**：不为补齐签名而寻找代签者；不把「无人反对」写成「已通过复核」。
