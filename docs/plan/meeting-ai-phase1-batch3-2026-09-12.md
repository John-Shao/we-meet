# 会议 AI 阶段 1：第三批执行记录

日期：2026-09-12。基线：`2b28e71a`。状态：本批版本化生成基础完成，阶段 1 / M1 尚未完整验收。

## 已实现

- 迁移 0149：MeetingTranscriptVersion 保存不可变原文快照；MeetingSummaryVersion 保存独立 AI 输出；ProcessingJob 关联输入快照并保存生成配置。
- 从已结束的确定场次读取全部当前原文，保存指纹、原文 UUID、时间偏移、说话人标签和语言。相同输入复用快照；原文变化提升记录 revision 并创建新快照，旧文本不覆盖。
- 每个快照内的 segment_revision 采用该快照 revision，尚不是独立逐句编辑版本；引用必须带所属快照 ID。没有引入独立 Speaker 表，也不将说话人标签猜测成账户。
- 显式准备任务后交给已注册的 Celery task。Worker 在短事务内认领，模型调用在数据库锁之外执行，发布时再次锁记录并检查 attempt、generation、input revision 和实时原文指纹。
- 同一任务重复投递、旧 attempt、被重生成取代的任务不重复发布；生成期间源文本改变或删除会取消发布。两个真实数据库连接并发认领已测试。
- 输出通过严格 JSON schema 和引用校验：overview、decisions、chapters、action_items、open_questions；每个结构化条目的引用必须匹配本快照原文 ID、revision 和完整时间区间。不能返回额外账户或任务字段。
- 新输出不写入旧 Summary/ActionItem，不修改人工纪要，不创建任务、不发文档或 IM。旧自动纪要路径继续沿用原服务，尚未切换为新 Worker。

## 完整性边界

旧 Transcript 没有可信的“尾段全部转写完成”水位。即使 JSON 和引用通过，新任务也保存为 **partial**，`coverage_status=unverified`；表示已有可读结果，但尚未核实整场音频覆盖范围。不能根据会议 ended 状态宣称最终输入已收齐。

本批仅有 `stage=final` 的生成版本，尚未提供 live/quick 阶段；final 是处理阶段标签，不是完整覆盖证明。页面必须同时显示 coverage_status。`is_current` 只表示匹配最新任务及当前源文本，不能用来替代覆盖完整性判断。

输入完整 JSON 超过 250,000 UTF-8 字节时显式拒绝，不截取会议尾部；输出预算 8,192 tokens。该限制是当前实现的保守输入预算，不是模型上下文上限。后续长会分段与全量归并另行实施。

模型输出的机械引用有效不代表语义正确；真实业务样本质量仍需要后续评测。原文中的命令作为资料处理，不启用模型工具、联网或自动动作。

## 配置与执行入口

| 配置 | 默认/用途 |
| --- | --- |
| MEETING_RECORDS_ENABLED | false，统一记录入口 |
| MEETING_VERSIONED_SUMMARY_ENABLED | false，新版本化生成 Worker；需两个开关同时开启 |
| MEETING_SUMMARY_MODEL | qwen3.8-flash |
| MEETING_SUMMARY_BASE_URL | https://dashscope.aliyuncs.com/compatible-mode/v1 |
| DASHSCOPE_API_KEY | 从部署环境读取；不写入快照、任务配置或错误信息 |

model/base_url 在准备任务时固定，后续配置变化不改变已排队任务的选型。模型客户端直接使用这组独立配置，不改变其他聊天/检索的 LLMClient.from_settings 行为。usage 使用现有统计服务，关联 meeting_record。

```sh
python manage.py migrate
python manage.py generate_record_summary <record_uuid>
python manage.py generate_record_summary <record_uuid> --retry
python manage.py generate_record_summary <record_uuid> --regenerate
python manage.py generate_record_summary <record_uuid> --recover-running
```

这些是部署后操作入口，本批没有在生产执行。命令输出 job UUID；Celery 未启用时使用仓库现有同步 fallback，同步失败返回非零退出码。队列投递失败保留已提交的 queued 任务，再运行命令可重新投递；不把数据库提交与消息队列发送当作分布式事务。

`--retry` 只重试可恢复失败，提升 attempt；`--regenerate` 显式创建新 generation。覆盖未验证的 partial 结果不自动重试，以免重复生成相同输入。`--recover-running` 只允许恢复运行超过 10 分钟的任务，先终止旧 attempt 再重试；不提供自动超时扫描。Worker 崩溃后需要运维触发恢复；上游已计费但本地未落库时重试可能再次调用模型，不承诺供应商侧恰好计费一次。

任务模块已导入 core.tasks 并验证在 CELERY_ENABLED=True 时注册，沿用默认队列配置。生产 Broker 投递、部署 Worker 消费和真实 Qwen 响应仍需联调，本批只验证注册与模拟调用的数据库行为。

## 读取接口与 Web 查询

- `GET /api/v1.0/meeting-records/{record_id}/summary-versions/`：按生成时间倒序游标分页，返回内容、模型、input_snapshot_id、input_revision、coverage_status、is_current；要求 read_summary。
- `GET /api/v1.0/meeting-records/{record_id}/transcript-versions/{snapshot_id}/`：返回该快照完整原文与版本，要求 read_transcript；不允许跨 record 读取。
- 仅纪要分享可以读 AI 版本，但不能通过 input_snapshot_id 读历史原文。原文改动后，旧引用仍可以由具备原文权限的人核对当时文本。
- Web 增加版本类型及两个查询 hook，查询键包含 viewer/record/snapshot/cursor，保留私有缓存策略。现有页面尚未改用这些接口。

没有新增面向终端的生成 POST API；当前生成命令是受信任后台操作入口。用户操作鉴权、幂等请求键、按钮与队列进度展示待下一批集成。

## 验证与回退

- 16 项新增测试通过，包括两个数据库连接并发认领、旧结果拒绝、源文本变化/删除、输入快照保留、无效/跨来源引用、配置固定、错误脱敏、重试/超时恢复、命令派发、历史原文权限。
- 合计 72 项相关测试通过：新增 16、原记录与兼容 43、旧纪要人工编辑 5、场次材料 6、旧 Room 接口 2。第二批记录的旧录制详情 6 项基线失败仍未纳入本批修复，不宣称整个测试套件通过。
- 0149 在专用本地 PostgreSQL 迁移成功；makemigrations 检查无差异，Django system check 无问题；新任务注册验证通过。
- 新 Python 文件 Ruff、Web tsc -b / ESLint / Prettier 通过。模型文件原有的两处 DJ012 顺序告警不在本批修改范围。
- 测试模型传输为 mock；没有真实供应商调用，没有读取生产密钥、推送消息或部署应用。

回退时关闭新生成开关，保留新增表及版本；读取接口继续由统一记录开关控制。不要反向执行 0149 删除已产生的快照和版本。旧应用逻辑不依赖新表，可保留数据库结构回退应用。

下一批：完善统一原文写入与完成水位、Speaker/独立采集协议；接入受用户权限及幂等键保护的任务请求，再对齐 Web/Android 页面和真实模型链路。
