# Work R0a 例外复核单（Lily）

日期：2026-10-31  
范围：仅 R0a 中 **John 已签、Lily 尚未复核** 的两项范围例外。Node 队列、modelparams 默认值、F0-R4 静态证书三项已由 John 主签、Lily 经 John 转述复核，不在本单重复。

## E1 管理只读范围例外

**现状（可核）**
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
- UT5 的完整管理只读验收仍待 Lily 按补齐后的实现复核；本单不再把 E1 视为已签例外。

**Lily 复核结论（2026-10-31，补齐后）**
- **接受** 6 个管理只读接口、`/admin/work` 页面和审计导出 worker 的当前实现；
- 未提出附加条件，也未额外要求 UT5 场景；E1 关闭，不再作为范围例外。

## E2 成果独立路由简化

**现状（可核）**
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

**2026-10-31 补齐（本地实现，待部署）**
- Go API 新增任务级只读路由：`GET /work/v1/tasks/{taskId}/artifacts/{artifactId}`（任务摘要 + 版本列表 + 已采纳版本）、`GET .../versions/{versionNo}`、`GET .../versions/{versionNo}/content`。
- 深链权限在 SQL 层同时校验组织、任务 owner、`artifact.task_id = taskId`、artifact/version 已发布；跨任务、非 owner、跨组织、staged 版本统一返回 404 `artifact_not_found`，正文仍校验 Content Store 的 hash 与字节数。
- 前端新增独立页面 `/work/items/:taskId/artifacts/:artifactId`，支持 `?version=`、版本列表与采纳标记、Markdown/文本预览、下载、按版本采纳、移动端只读；任务工作区成果面板新增“打开成果工作区”入口。
- 本地验证：Go `go test ./... -p 1 -count=1` 全绿（`internal/api` 48.977s，含跨任务/非 owner/跨组织/无席位负例）；前端 Work 测试 66/66、全量 1772/1772、`tsc -b` 与 `npm run build` 通过。
- **尚未部署**：生产 Work API 与前端仍是旧构建；生产浏览器验收与真实深链负例待发布后执行。页面能力与内嵌面板对齐（预览、版本切换、下载、按版本采纳），本轮未新增成果正文编辑/保存入口。

**请 Lily 复核**
- [ ] 接受独立成果页与任务级深链权限
- [ ] 有条件接受（条件：__________）
- [ ] 不接受（原因：__________）

## 证据与边界

- 历史页、旧链接和 `/work/new` 已随 frontend `645460d5b` 发布生产（Helm revision 523）并做真实浏览器验收；证据见 [work-project.md](work-project.md) D5 行。
- 生产当前没有 `display_state=archived` 任务，归档列表只有空态证据；移动实机仍未验证。
- 本单只请求对两项范围例外做判断，不把 John 的签收写成 Lily 的复核，也不把例外写成功能已实现。

## 签收栏

| 项 | John（主签） | Lily（复核） | 日期 |
|---|---|---|---|
| E1 管理只读范围例外 | 已签 2026-10-31 | **接受 2026-10-31（补齐后，无附加条件）** | |
| E2 成果独立路由简化 | 已签 2026-10-31 | 待签：__________ | |

建议在 C22 环境预检（2026-11-06）前完成复核。若未回复，状态保持“John 已签、Lily 未复核”，R0a 签收不完整，但不因此回滚现有试点功能。
