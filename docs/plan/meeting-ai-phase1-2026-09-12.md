# 会议 AI 阶段 1 执行记录

日期：2026-09-12。状态：**进行中，首批数据与只读服务基础完成；M1 尚未完整验收。**

第二批已完成来源链接解析、列表范围筛选与回填审计增强，详见 [第二批执行记录](meeting-ai-phase1-batch2-2026-09-12.md)。下文保留首批交付时的边界，新增接口与最新验证结果以第二批记录为准。

第三批已实现不可变原文快照、AI 纪要版本和受版本保护的生成 Worker，详见 [第三批执行记录](meeting-ai-phase1-batch3-2026-09-12.md)。新链路默认关闭；转写完成水位、实时/速记版本、独立采集和端页面接入仍待完成。

第四批已增加转写送达序号、封存账本及 Agent 收尾，详见 [第四批执行记录](meeting-ai-phase1-batch4-2026-09-13.md)。文字送达完整性与整场音频识别完整性分开标示，后者仍未验证；新开关默认关闭，M1 继续进行。

用户已要求提交阶段 0 并进入阶段 1。阶段 0 的规划、契约与模型连通验证已以 `cdbfde2a` 推送至 `origin/aliyun-dev`。真实业务样本质量、ASR 最终选型与 Android 独立录音实机验证继续保留为待完成项，不妨碍本批数据基础开发。

## 本批实现

| 工作 | 本批交付 | 后续缺口 |
| --- | --- | --- |
| B01 统一对象 | 新增 MeetingRecord、MeetingRecordAccess、CaptureSession、MeetingMediaSegment、MeetingProcessingJob；迁移 0148 | 真实分片上传、资产映射、独立采集写接口、独立原文与纪要版本 |
| B02 权限 | 新只读 API 先按组织成员资格和来源授权过滤，再分页；原文与纪要分开授权 | 播放、下载、分享管理、问答，以及旧入口全面接入 record 权限 |
| B03 兼容 | 已归属场次的材料可幂等投影为记录；提交后按开关投影；dry-run 默认回填命令 | 生产历史数据演练、旧深链转换、历史材料完整性核对 |
| B04 处理状态 | 分项 job、输入 revision、generation、attempt；取消与重试防迟到覆盖 | 实际 Worker 接入、live/quick/final 版本、水位与 usage；本批不调用模型 |
| B05 查询层 | Web 独立类型与读查询 hooks，缓存键包含 viewer/record/cursor | 页面切换到新查询、旧缓存回收与错误状态展示、Android 对齐 |
| T01 翻译协议 | 本批未迁入 | 继续依阶段 0 的协议验证结果迁入 |

新增接口由 `MEETING_RECORDS_ENABLED` 控制，默认关闭。现有会议页面与旧接口继续使用原数据路径。本批没有新增可点但无实际能力的录音或 AI 控件。

## 数据与访问约束

- 线上记录只从有转写、录制或纪要材料的确定场次创建；一个场次一份记录。纯开会但没有记录材料不会生成笔记。
- `source_session_id` 保留原场次 UUID，`meeting_session` 是可空的在线关系。源 Room 删除后记录身份保留、在线关系为空，不解析到另一场会议。**旧音视频/转写/纪要仍遵守原有删除规则，本批没有把旧材料复制为永久存档。**
- source_type、source_session_id、organization_id 的正常模型写入禁止重新分配；数据库另有来源类型、场次一致性、唯一性与版本约束。后台代码仍须通过服务写入，不能用 QuerySet.update 绕过跨表业务校验。
- 历史记录 retention_mode 为 `unknown`，不推断已经执行“仅留文字”的音频清理。线上记录不复制一个可能失效的房主身份作为永久所有者，使用当前 Room ResourceAccess。
- 独立 audio/upload 不需要假 Room。独立录音要求创建者拥有记录；同设备/用户与同记录最多一个未停止采集。设备租约、续传和暂停/结束控制尚未接入。
- 组织记录要求用户有该组织的有效成员关系且组织有效，再检查所有权、当前 Room 访问授权或显式记录读授权。单纯参会、公开入会、同组织成员身份不授予材料权限；源房间组织漂移时拒绝读取。
- `read_summary` 和 `read_transcript` 可以分开分享；服务暂不开放媒体、编辑、管理、采集能力。没有分享管理 API，不能由客户端自行创建读授权。
- 列表权限使用 EXISTS 子查询，避免材料多表联接膨胀及每条记录再查一遍权限。响应设置 `Cache-Control: private, no-store`。

与阶段 0 目标契约的当前差异：媒体模型仅保存映射骨架，`sequence` 暂为 record 范围唯一；采集内上传序号、upload_status、asset_id、校验冲突与续传规则待上传协议接入时补齐。当前未回填媒体起止位置，不用 created_at 猜测实际录制偏移。TranscriptSegment、Speaker、SummaryVersion 尚未新建，读取仍适配旧场次材料。

## 已实现的 API 子集

公共前缀：`/api/v1.0/meeting-records/`。接口关闭时返回 404；开启后仍要求登录和每次请求的授权校验。

| 请求 | 返回 |
| --- | --- |
| `GET /` | `{results: MeetingRecord[], next_cursor: string|null}`，每页 30 条 |
| `GET /{record_id}/` | 身份、来源、标题、origin_at、retention_mode、revision、source_available、capabilities |
| `GET /{record_id}/transcripts/` | `{results: Transcript[], next_cursor}`，按原文 started_at/id 排序 |
| `GET /{record_id}/summaries/` | `{results: Summary[]}`；最多一条旧纪要，标记 `legacy: true` |

列表支持 `source_type`、`meeting_session_id`、`q`（标题，最长 200 字符）、`cursor`。尚未实现 owned/participated/shared 视图参数、全文检索、上传、详情修改及任务控制接口。

原文仅返回当前 record 指向的 session/room 交集。纪要返回人工编辑后的 effective_content，保留 is_edited 与来源 session；空场次返回空结果，禁止回退到房间最新场次。

Web 类型位于 `src/frontend/src/features/meetings/api/ApiMeetingRecord.ts`，查询位于 `fetchMeetingRecord.ts`。所有 hooks 显式传入 authenticated viewerId 与 enabled；不会复用旧 room 查询键，不保留卸载后的内容缓存。页面集成时仍需按能力控制查询，并在 403/404 后清除正在展示的旧数据。

## 回填与开关操作

以下命令已具备执行入口，**本批仅在隔离测试数据库验证，不代表已在业务环境执行**：

```sh
python manage.py migrate
python manage.py backfill_meeting_records
# 检查 dry-run 报告后才执行写入：
python manage.py backfill_meeting_records --apply
```

报告包括 eligible_sessions、existing_records、created、conflicts、unresolved（无场次）、mismatched_room（场次与房间不一致）。来源不明/不一致材料不猜测归属、不重写。每个场次独立事务、可重复运行；apply 中发现记录来源冲突会计数并返回失败退出码，已成功的记录可在下次运行复用。

开关开启后，Transcript/Recording/Summary 的正常 save 在事务提交后投影身份；bulk 写入不触发 Django save 信号，需显式调用服务或运行回填。投影失败由 Django 记录错误，原材料仍然存在，可用回填补齐。该机制是可修复索引，不是保证送达的任务队列。

上线顺序：目标环境备份与迁移演练 → 安装 0148 → dry-run 与核对 → apply 与复核 → 启用读取/投影开关 → 再做端入口灰度。本批只有全局开关，租户灰度路由仍需后续实现。

回退时关闭开关并保留新增表和数据。不要在已有新增记录后直接反向执行 0148，因为反向迁移会删表；旧版本不依赖新增表，可以保留结构回退应用。

## 验证证据

- 新增 25 项测试通过：场次唯一与隔离、来源约束、删除后身份、独立采集限制、媒体关联、组织/分享权限、撤权、只读接口、游标分页、人工纪要、提交/回滚、回填幂等、代际与重试保护。
- 旧链路 74 项兼容测试通过：MeetingSession 服务、场次材料、纪要人工编辑、旧 Room 最新场次接口、Recording 模型、媒体授权。媒体授权最初因隔离环境缺少 S3 凭证失败；新建本地 MinIO 测试桶后，该文件全部 16 项通过。
- 隔离 PostgreSQL 16 从空库执行全部迁移至 0148 成功；`makemigrations --check --dry-run` 无变化，Django system check 无问题。
- Web `tsc -b`、新增文件 ESLint 与 Prettier 通过。新增 Python 文件 Ruff 通过；models.py 仍有两处本次未修改的既有 DJ012 顺序告警。
- 后端测试使用 Python 3.13.5、Django 5.2.14、pytest 9.0.3；迁移初次由镜像中的 Django 5.2.11 生成，升级到仓库指定版本后检查无模型差异。测试镜像并非完整锁文件重建，不将这次验证等同于完整 CI。

环境：`meeting-ai-phase1-tests` 挂载本仓库 backend，另有专用 PostgreSQL、Redis、MinIO 和 Docker network。未使用另一项目的 /app 挂载或数据库；本批未读取生产凭证、调用真实模型、发送 IM 通知或发布应用。

## 下一批顺序

1. B02/B03：明确旧录制授权与记录授权迁移映射，补旧深链解析及历史差异核对；保留来源不明材料报告。
2. B01/B04：独立原文、说话人、纪要版本与媒体上传协议；接入有版本保护的实际任务，补并发 Worker 测试。
3. B05：Web 页面和 Android 查询/深链统一，再验收 M1。T01 可按音频工作安排迁入。

阶段 1 完整完成前，不宣称独立录音、Qwen 总结、同传或新资料工作区已交付。
