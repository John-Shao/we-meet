# 上传原文翻译失败诊断

`POST .../upload-translations/` 的 202 代表任务受理，列表 GET 的 200 代表查询成功，均不代表翻译成功。以任务 `status`、`error_code` 和 `completed_chunks/total_chunks` 为准。

Web 仅在列表存在 `queued/running` 任务时每 5 秒轮询。失败、成功、取消、超时或空列表不再定时查询；手动刷新、重新进入或窗口重新聚焦仍可重新读取状态。显式重新翻译受理后重新读取列表，活动任务恢复轮询。GET 不调用翻译模型。

## 错误码

| error_code | 含义 |
| --- | --- |
| `output_truncated` | 模型以 `length` 结束，输出被截断 |
| `output_not_complete` | 模型未以 `stop` 正常结束，日志记录安全的结束原因 |
| `output_invalid_json` | 返回内容不是可解析的 JSON |
| `output_schema_mismatch` | 顶层或段落字段、结构不符合约定 |
| `output_segment_count_mismatch` | 返回段落数量与输入不一致 |
| `output_segment_id_mismatch` | ID 被修改、替换、重复或类型不正确 |
| `output_segment_order_mismatch` | ID 集合相同，但顺序不一致 |
| `output_empty_text` | 译文为空或不是字符串 |
| `output_text_too_long` | 单段译文超过大小上限 |
| `provider_timeout` | 模型请求超时 |
| `provider_connection_failed` | 连接模型服务失败 |
| `provider_auth_failed` | 模型服务返回 401/403 |
| `provider_rate_limited` | 模型服务返回 429 |
| `provider_http_error` | 模型服务返回其他 HTTP 错误，日志记录状态码 |
| `provider_unavailable` | 模型调用阶段其他异常，不能据此断言是网络错误 |
| `execution_failed` | 初始化、权限检查或进度保存等其他执行异常 |
| `source_budget_exceeded` | 执行阶段原文分块超出限制 |

保留已有 `execution_timeout`、`source_or_access_changed`、`dispatch_unavailable` 处理方式。旧任务中的 `invalid_output` 不会被自动重写，不能追溯推断具体子原因。

## 逐段生成约束（prompt_version 2）

新任务在每批请求中发送明确的 `expected_segments` 和包含全部原始 ID 的 `output_template`，要求模型逐项填入译文。重复内容、口头语和不完整句子仍须分别输出；禁止合并、拆分或省略条目。模板只包含当前批次，例如 44 个短段落按 20、20、4 分批时，各批分别要求对应数量。

API 创建新任务时记录 `prompt_version: 2`；已排队的 v1 任务继续使用原提示词。发布时须同时更新 API 与翻译 worker，新任务才会使用 v2。失败历史不会自动重跑；段数、ID、顺序和非空校验保持不变，不补空译文或发布部分结果，也不增加自动付费重试。

这是针对段数不匹配的生成约束改进，并非模型必然遵循的结构化保证；本地测试使用模拟输出，实际模型效果需要部署后验证。如再次失败，仍根据下述安全日志判断具体预期/实际数量。

## 发布后排查

1. 更新 API 后端与执行 `core.tasks.upload_translations.translate_upload` 的 Celery worker；不需要数据库迁移。更新 Web 以生效终态停止轮询。
2. 由用户显式发起一次重新翻译。不会自动重试旧失败任务或增加模型调用；生成仍可能产生 AI 用量。
3. 从列表响应取新任务 `id` 和 `error_code`，在对应 worker 日志中搜索该 ID 与 `Upload translation failed:`。
   新版失败任务还返回 `error_details`：只包含已知的 `prompt_version`、`chunk_index`、`expected_segments`、`actual_segments`、`segment_index` 数值。例如 `expected_segments: 20, actual_segments: 19` 表示该批少返回一段；实际数量未知时省略字段，不伪造为 0。旧失败任务返回空对象，不追溯补数。此信息存入已有任务配置字段，无需数据库迁移。
4. 日志的 JSON 包含任务/记录 ID、错误码、执行阶段、失败批次 `chunk_index`（从 1 开始）、总批次、预期/实际段落数量；适用时包含首个异常段落序号、结束原因或 HTTP 状态码。无法获取的数量为 `null`，不伪造为 0。

日志不输出原文、译文、段落 ID、供应商响应正文、异常消息/堆栈、URL、请求头或凭据。结束原因仅保留白名单值，未知值写作 `unknown`。

所有批次完成并通过原文/权限检查后才发布译文；任何批次失败均不发布部分结果，不放宽 ID、顺序、数量或完整性校验。此改动提高可诊断性，本身不等于已修复线上模型输出不合规的具体原因。
