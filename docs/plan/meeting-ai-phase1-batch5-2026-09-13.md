# 会议 AI 阶段 1：第五批执行记录

日期：2026-09-13。基线：`36f8e8f4`。本批完成用户纪要请求、待投递请求恢复及 Web 入口，M1 尚未整体验收。

## 用户入口与权限

会议详情增加按开关显示的「AI 纪要」标签。先选择明确场次，再查看生成状态、版本内容和引用原文；会议室复用时不会自动选择最新一场。现有人工纪要、行动项等入口继续使用原服务。

- 当前会议所有者或管理员可以生成新版本、重试可恢复失败；普通成员与只读分享者只能读取已授权内容。独立录音记录尚未接入该生成入口。
- 服务端列表查询直接计算 generate_summary，避免按记录逐条查询权限。每次写请求、队列投递及 Worker 调用模型/发布结果时重新检查权限。
- 公共任务固定发起人的 requested_by。发起人被撤权或停用时，尚未投递的任务取消；Worker 也会拒绝模型调用或结果发布。调用期间撤权无法撤销已发生的上游计算和计费。
- 只读分享不能通过任务状态读取配置、供应商原始响应或逐字稿；引用必须另外具备 read_transcript，按快照 ID 和具体片段定位。
- 新权限只代表允许请求生成；会议结束且已有原文后才显示为可开始。实际生成仍检查完整输入预算、来源时间和版本。

## API 与幂等契约

| 接口 | 用途 |
| --- | --- |
| GET /api/v1.0/meeting-records/?room_id=UUID | 按准确会议室筛选已授权场次，保留游标分页 |
| GET /api/v1.0/meeting-records/{record_id}/summary-job/ | 当前 revision、generation_ready 及最新任务的 status/attempt/generation/retryable/error_code/dispatch_pending |
| POST /api/v1.0/meeting-records/{record_id}/summary-requests/ | 保存生成、重生成或重试意图，返回 202 |

POST 必须携带 UUID 格式的 `Idempotency-Key` 请求头，JSON 示例：

```json
{
  "operation": "generate",
  "expected_revision": 1,
  "expected_job_id": null,
  "expected_attempt": null
}
```

operation 为 generate / regenerate / retry。有已知任务时，expected_job_id 与 expected_attempt 必须一起提供，并匹配最新任务；初次生成二者为 null。不接受指定模型、原文或其他额外字段。

迁移 0151 新建 MeetingSummaryRequest，保存用户、记录、请求键、规范化载荷、任务和固定 attempt，以及 pending/sent/abandoned 投递状态。`(user, key)` 全局唯一，同键同载荷返回同一意图；同键换记录/操作/预期状态返回 409。首次请求和快照/任务在同一事务提交，事务回滚不发消息。

不同请求键不能绕过 revision、最新 job 和 attempt 的检查。regenerate 不允许替换 queued/running 任务；retry 仅针对当前 revision、原文未变且可恢复的失败，并且只推进一次 attempt。generate 可复用当前同输入任务。返回中的 job 是该意图关联任务的当前状态，前端随后读取 summary-job 确认最新任务。

每个用户每分钟最多 6 次 POST 请求，轮询不占此额度。该限流沿用 DRF 缓存限流机制，用于限制频繁操作，不是严格财务预算控制。跨域允许的请求头增加 idempotency-key，仍只允许原配置中的可信 Origin，保留原认证和 CSRF 行为。

## 队列与恢复

请求提交后通过 on_commit 尝试投递。公共接口使用 Celery send_task，明确不走原 task 装饰器的同步 fallback；API 启用还要求 CELERY_ENABLED。

- 投递与保存回执不能形成跨数据库/Broker 的一次性事务。Broker 接受后本地回执未保存，可能重复投递；Worker 使用原有 job/attempt/generation/input revision 校验避免重复发布。
- 投递持有记录及请求锁，避免并发重放重复推进状态；连接和 socket 配置 3 秒超时，关闭 publish retry。多个网络步骤仍可能使总耗时超过 3 秒。
- Broker 失败保存 dispatch_unavailable，保留 pending 请求，HTTP 仍返回已接受的 202，不泄露 Broker 错误正文。GET 状态显示等待队列投递。
- 新命令重新投递 pending 意图，不创建新任务或 attempt：

```sh
python manage.py dispatch_summary_requests --limit 100
```

命令处理从未尝试或距上次尝试超过 30 秒的请求，limit 范围 1..1000。部署启用新入口时，应安排周期性执行（例如每分钟），或在故障恢复后显式运行；本批没有创建生产定时任务。重复 HTTP 请求也会尝试恢复同一 pending 意图。

已 sent 的 Broker 消息丢失不在此扫描范围；必要时沿用 `generate_record_summary` 操作命令重新投递。running 超时仍使用上一批已有的显式恢复流程，本批不增加公共「强制恢复运行中任务」按钮。公共调用发起人被撤权造成的未投递任务会取消，避免永久显示排队。

## Web 行为

- 明确场次选择、生成/新版本/失败重试、排队/运行/失败/取消/结果可用状态、历史版本分页和原文引用。
- 点击同步加锁，禁止同一按钮并发提交；网络或 5xx 结果不明时保留原键和原载荷，显示「重新提交同一请求」。429 也保留该请求，等待后再提交。409 刷新服务端状态，下一次明确操作使用新键。
- 请求键仅保存在当前组件内存，不写 localStorage；重新打开页面以服务端最新任务和版本为准，不自动重发未知请求。
- 任务运行时每 3 秒轮询，其他任务状态、记录权限及版本每 10 秒刷新；错误停止轮询，页面隐藏已缓存内容。查询按 viewer/record/snapshot/cursor 隔离，离开后不保留内容缓存。
- 请求被接受、任务结束或用户刷新时更新版本。新 AI 内容使用结构化字段和 React 文本渲染；引用读取自己的不可变快照，不跳到当前逐字稿的相似文字。
- 同时展示 delivery_status 与「整场音频覆盖尚未验证」；partial 是有可读结果但完整性尚未证实，不等同于生成失败。
- 本批补充中英文文案；其他语言沿用项目的中文 fallback。

## 开关与上线前提

新增 `MEETING_SUMMARY_REQUESTS_ENABLED=false`。写入口要求以下全部开启：MEETING_RECORDS_ENABLED、MEETING_VERSIONED_SUMMARY_ENABLED、MEETING_SUMMARY_REQUESTS_ENABLED、CELERY_ENABLED。

config 接口增加 meeting_records.enabled 和 summary_requests_enabled；前端按记录开关显示 AI 标签，并以每条记录的 capability 决定是否提供生成按钮。已有 useConfig 缓存策略下，配置变更后应重新加载页面；服务端开关与实时权限检查始终生效。

测试/灰度顺序：执行迁移 → 配置 Broker 和消费默认队列的 Worker → 验证既有版本化任务已注册 → 配置 pending 请求扫描 → 启用上述开关 → 使用准确场次验证生成、重试、历史版本和撤权。总结模型仍由上一批独立配置选择，默认 `qwen3.8-flash`。

回退时关闭公共请求开关，保留新表和历史版本；不要反向迁移删除幂等意图。对已排队公共任务，Worker 在继续调用或发布前检查公共开关和发起人权限。Operator 原有生成命令保留原契约。

## 验证

- 新增 16 项后端测试通过：权限矩阵、调用前/调用中撤权、同键重放/载荷冲突、跨记录冲突、版本冲突、retry/regenerate、Broker 失败恢复、事务回滚、真实 PostgreSQL 双连接并发、开关/请求校验、限流、列表无逐条权限查询、跨域预检。
- 扩大回归 100 项通过；随后新增跨域预检并重跑本批 16 项全部通过，覆盖共 101 个不同后端用例。上一批已复现的旧 Room retrieve 11 项基线失败未纳入修复，本次不宣称整库测试全部通过。
- Web 新增 6 项交互测试通过，覆盖双击、网络不确定后再遇限流仍复用请求键、只读分享、引用快照、刷新撤权和会议室复用选择；连同原详情面板共 12 项通过。
- 0151 在专用 PostgreSQL 迁移成功；makemigrations 无差异，Django system check 通过。新增服务/接口/测试 Ruff 通过；models.py 原有两处 DJ012 保留。
- Web tsc、ESLint、Prettier 和 JSON 校验通过，完整 `npm run build` 成功。构建仍提示已有的 marianne.svg / devise.svg 运行时资源路径及大包体积；本批未改动这些资源。
- 使用独立测试环境和模拟 Broker/模型，不包含生产部署、真实供应商调用、真实队列消费或浏览器端到端联调；后端容器仍不是完整锁文件 CI 重建。

## 下一批

继续补齐 Speaker 与独立采集的权限、原文和恢复协议；随后接入真实 ASR/Qwen 会议链路及音频结束证明。Web 当前是会议详情中的版本化纪要入口，还不是完整会议笔记/独立 AI 录音工作区。Android 对齐、实时总结/速记、待办转换与助手通知仍按原计划推进。
