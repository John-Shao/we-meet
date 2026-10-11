# AI 录音分人操作与身份查询走查

日期：2026-10-10（Asia/Shanghai）。分支：`feature/speaker-identity-voiceprint`。

## 当前范围

接通独立录音分人任务的拥有者操作 API、取消回执及录音派生版本的可信身份查询；复用现有身份候选、独立任务队列、持久建议和逐个人工确认事务。HTTP 请求只创建持久任务，不执行存储下载或收费 POST；既有 Celery tick 在独立队列处理任务。Qwen 仍为首选，未引入 CAM++。

- `GET /api/v1.0/capture-sessions/{capture_id}/diarization/`：私有状态、当前版本、最近 20 份公开任务回执和能否创建新任务。
- 同路径 `POST`：严格整数 `expected_revision`、UUID `Idempotency-Key`，幂等请求绑定同一录音和记录 revision。
- `POST /api/v1.0/capture-sessions/{capture_id}/diarization/{job_id}/cancel/`：拥有者取消排队／运行任务；重复取消同一 revision 可重放，终态或旧 revision 拒绝。

操作只允许当前拥有者和有效账号，要求记录管理／媒体权限；`X-Voiceprint-Owner` 参与账号切换校验。新收费请求要求开关、Celery 和服务密钥具备；关闭开关后仍允许重放已有命令、读取状态及取消。回执隐藏任务 provider ID、输入对象键、VersionId、摘要、音频 URL、worker ID 和完整 provider 报告，响应为 `private, no-store`。取消停止本地处理，不保证撤销已经发送的云端任务或退还费用。

录音身份查询必须固定当前成功分人任务、同一个成功 ASR、完整派生发布摘要和选定的私有音频对象 VersionId。候选库仍按个人／组织授权隔离，临时音频到期后拒绝查询。歧义段落作为区间屏障，不把录音者直接当作全部说话人的身份；查询不登记样本、不增加模板、不自动绑定姓名。

## 发现与修复

| 问题 | 修复与针对性验证 |
|---|---|
| 录音来源比较使用 `audio`，与真实枚举 `audio_recording` 不符 | 所有新增门禁使用 `MeetingRecord.Source.AUDIO`；实际录音可创建任务、构建可信查询并生成两名说话人的建议 |
| 取消后的晚到付费任务回执可能改写终态，取消输入没有进入清理队列 | 允许保存晚到任务 ID，但保持 `canceled`；撤销租约，并把取消输入纳入已有写入排空／精确版本清理流程 |
| 录音查询可能沿用导入源桶配置 | 按查询来源选择录音派生桶，下载前核对桶／前缀／区域／端点摘要；错误桶在任何 I/O 前拒绝 |
| S3 VersionId／ETag 回执未单独绑定媒体内容摘要 | 下载后在解码／模型调用前核验选定输入 SHA-256；身份建议发布事务再独立校验同一摘要，错误内容不产生建议 |
| 录音回执接纳及读取把字符串 `"null"` 当作固定版本 | 两个边界均拒绝该值，不允许创建选定输入、签名或查询；回归先复现旧实现错误接纳／读取，再验证拒绝且没有存储或付费 I/O |
| 查询结果摘要、状态或原因类型异常时，提交阶段抛 `TypeError` 并留下运行中的任务 | 提交前严格检查字段类型，把任务终止为 `failed / identity_query_invalid`；三种异常均不得生成建议 |
| 派生 JSON 缺少加载前预算，大父段落还可能在多条子段落 join 中重复加载 | PostgreSQL 检查派生 JSON 总量最多 32 MiB，冻结输入证明最多 64 MiB；复用原有正文／逐词预算，并 defer 不需要的父正文、逐词和派生字段 |
| 重复授权检查和状态列表可能加载大冻结输入或报告 | 轻量 header／状态查询 defer 冻结输入与无关报告；完整查询及建议提交时再核验完整来源证明 |

数量和字节限制是拒绝上限，不代表实际容量或延迟实测结果。

`"null"` 不是固定内容证明：版本控制暂停后，同一键的 null 版本可被后续 PUT 覆盖。依据 [AWS S3 官方文档](https://docs.aws.amazon.com/AmazonS3/latest/userguide/AddingObjectstoVersionSuspendedBuckets.html)。正常上传子进程已有该值的拒绝规则；本次补齐录音回执接纳和持久来源读取边界，防止异常或恢复回执绕过门禁。

## 验证与剩余工作

测试使用隔离 PostgreSQL、合成 WAV、本地私有存储 HTTP 及模拟 Qwen 响应；未使用真人录音、真实麦克风、收费 ASR 或生产存储。完整两说话人测试从录音分片、ASR 完成、Qwen 分人发布走到身份队列、两份建议和两次人工确认；确认前没有姓名绑定，确认后仍未新增声纹样本或模板。

第一轮专项与原生媒体回归：74 项收集，73 项通过，1 项因未指定外部 Qwen 运行时而跳过；日志 `work/capture-identity-review-regression-final-2026-10-10.log`。第二轮指定工作区已有 FFmpeg／FFprobe、固定 Qwen encoder pack 和独立 Python 运行时：308 项全部通过，包含第一轮跳过的实际 Qwen 查询，以及导入来源、身份任务／决定、派生发布、时间对齐、PCM、纪要、记录删除、录音清理与保留策略；日志 `work/capture-identity-review-compatibility-2026-10-10.log`。

收尾先加入两种 null 回执及三种异常字段类型的回归，旧实现准确复现 5 项失败，既有 6 项拒绝用例仍通过；日志 `work/capture-identity-review-boundary-reproduction-2026-10-10.log`。修复后分人 API、分人 worker 和身份队列的最终 106 项全部通过，包含实际 Qwen 查询／持久化；日志 `work/capture-identity-review-boundary-final-2026-10-10.log`。

本轮共验证 386 个不同用例，第一轮跳过的实际 Qwen 用例已在第二轮通过，第三轮包含 101 个已执行用例和 5 个新边界用例；不能把三轮通过数直接相加。修改的服务、独立接口和测试通过 Ruff lint／格式检查。`urls.py` 与 HEAD 基线仍有同一项既有 import 排序诊断，没有新增诊断；保留该文件原有格式。Django 系统检查无问题、迁移漂移检查无变化，本轮没有新增或应用迁移。三份修改文档的本地链接检查通过。

Web／Android 的录音分人入口、派生版本分页及录音身份试听仍待实现，不能把当前 ASR 分页描述为已展示新派生版本。可信通话采样、暂停／共享设备排除、真实设备分组、生产消费者与恢复部署，以及获授权真人／容量验收仍属于完整目标。所有新增能力仍遵循默认关闭及独立发布验收。
