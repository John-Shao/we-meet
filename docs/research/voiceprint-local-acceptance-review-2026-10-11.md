# 本地 Docker 合成声纹链路验收

日期：2026-10-11（Asia/Shanghai）。用户确认先用本地 Docker 完成合成链路验收，ECS 验收后补；监控部署等待监控 ECS 到位。本记录仅覆盖隔离工程验收，不批准生产采集或实名自动归属。

## 环境与制品

采用随机命名的内部 Docker 网络、独立 PostgreSQL 主库与日志库、Redis、LiveKit、Qwen encoder、后端、sampler 和原生媒体 driver，共八个容器。后端使用镜像内 Production 配置和实际迁移，运行真实 HTTPS API、Celery Beat 及 prefork 消费者；应用源码没有挂载覆盖，只有独立验收入口和协议 fixture 通过只读挂载提供。

启动前解析完整本地 image ID，所有创建均使用 `--pull=never`，无宿主端口。资源上限见[部署前检](voiceprint-isolated-deployment-preflight-2026-10-11.md)：每容器 256 PID，上限合计 7.75 CPU／7,296 MiB。该预算用于本次合成场景，不作为生产 requests 或整机独占保证。

| 组件 | 本地 image ID |
|---|---|
| 后端 | `sha256:789ec902ea0247d842aa786f7e0cf10d9beb25e09ebe07d366cb2ecc8a32fadc` |
| sampler／driver | `sha256:6ffc0e48b45a786294e31e749a988c97dfac615bc9cfdb382b610d730f5a0f0c` |
| Qwen encoder | `sha256:43e4b7c4b77199bc31f4352dd0d6d617e881c6d227860f67b4074a83bdd32bd7` |
| LiveKit | `sha256:2c6869d2d5ff6c9c0166f47be1c92dad6928bfecfa5e4060a6ece48db8accfa3` |
| PostgreSQL 主库／日志库 | `sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685` |
| Redis | `sha256:ff02b58f971e7d7d156a1267e283fcbbeee91773b6aa36c49dac28ecfe28eadf` |

Qwen 使用已有固定 encoder pack，不动态下载模型，不改为 CAM++。后端对应[分组区间制品](voiceprint-cluster-uncertainty-review-2026-10-11.md)，encoder 对应[结果指标制品](voiceprint-encoder-result-metrics-review-2026-10-11.md)。镜像没有上传 registry，也没有部署到生产 ECS。

## 采样登记阶段结果

运行 `run_voiceprint_rtc_probe.py --media-boundaries`，本次资源前缀为 `vp-full-rtc-85680098f5`，退出码 0。

| 验证项 | 实际结果 |
|---|---|
| HTTPS／会话／CSRF、原生 RTC、真实调度及签名 webhook | 通过；52 次 webhook 全部成功 |
| RTC 候选、Qwen 编码、本人逐次确认 | 3 个候选、3 次编码成功、3 次确认；未授权参与者候选为 0 |
| 加密与模板 | 3 个加密 embedding、1 个加密 baseline，支持样本 3 个、语音量 30,000 ms |
| 音频擦除 | 确认后维护消费完成，候选原音频剩余 0 |
| 媒体边界 | 静音恢复、空调度恢复、闲置退出恢复、音轨替换、重连和房间中断均通过 |
| 许可及独立日志 | 11 个许可，3 消费、8 取消，终态擦除 6 个；来源绑定一致，日志当前序号 12 |
| fixture 边界 | 实名匹配关闭；本地 ASR 协议调用 4 次，不是云端 ASR |

该阶段只证明采样登记路径；身份队列另按下一节执行，不迁移历史镜像的测试结果。

## 身份队列与人工确认

入口新增显式选项 `--synthetic-identification`，缺省仍关闭匹配、没有门限文件、不启动 identity 消费者。开启后，在同一隔离部署中同时运行 control／processing／identity 三类消费者及 Beat。

合成来源为 30 秒、24 kHz、16 bit 单声道 WAV，发布三个相邻的转写区间；真实 producer 合并同说话人区间、裁去边界，再按自身策略选择查询片段，不把转写行数当作查询数。fixture 只发布录音／转写来源元数据，并在后端 loopback 提供有界私有对象读取；不预制模板、向量、许可、身份任务或候选建议。匹配库复用真实 RTC 登记并由用户确认的模板。使用真实提交／查询／确认 API、真实队列消费、媒体下载／校验、FFmpeg 预处理、实际 Qwen 查询编码及持久化建议。

策略版本 `rtc-synthetic-test-only-v1` 的 accept／min-pair 为 0.85、margin 为 0.05，仅用于该合成协议场景。`calibrated` 字段用于通过既有生产策略格式校验，其摘要明确标记合成 fixture；不是真人校准报告。策略在一次性凭据目录内生成，运行结束回收，不进入应用默认配置或生产环境。

修复后的完整重跑使用 `--media-boundaries --synthetic-identification`，资源前缀 `vp-full-rtc-b806f86d6f`，总回执 `status=passed`，退出码 0。

| 验证项 | 实际结果 |
|---|---|
| RTC 登记及媒体边界重跑 | 3 个候选／确认／编码成功，1 个加密 baseline；52 次签名 webhook 全成功，静音、闲置恢复、替换、重连及中断通过 |
| 真正的身份队列 | 1 个任务、1 次尝试、1 次成功；实际 identity prefork 消费者执行，无 eager 或任务处理函数替换 |
| 私有来源及 Qwen 查询 | 对象 HEAD／GET 各 1 次；5 个查询片段、25,000 ms 有效语音，持久化 1 个 suggested 建议 |
| 用户边界 | 未授权账号读取被拒绝；建议生成后身份仍未写入，人工确认后归属本人 |
| 冲突与污染约束 | 同一确认重放返回 409，只有 1 条身份决定；支持样本仍为 3 个，没有用识别查询自动补充声纹库 |
| 媒体与日志 | 登记原音频剩余 0、查询临时目录子项 0；日志当前且序号 13，许可绑定一致、终态擦除 6 个 |
| 协议 fixture | 本地 ASR 调用 8 次；实际云端转写不在本次覆盖内 |
| 回收 | 8 个自建容器、1 个内部网络、3 个匿名卷及临时私有凭据目录均无残留；原有 4 个容器继续运行 |

运行中的元数据快照核验八个容器的固定 image ID、CPU／内存／PID 限制、无宿主端口及内部网络，当次未观察到 OOM；后端、driver、sampler 正常退出。这些观测不是长时容量或并发峰值结论。

13 项探针 unittest 全部通过，覆盖固定镜像、来源许可、失败清理、缺省关闭匹配及新增身份回执约束；Ruff 检查与格式检查、差异和文档本地链接检查通过。本次只修改隔离验收入口与记录，没有改动应用算法，因此复用上述已构建应用镜像，没有以挂载源码替代制品验证。

复验使用 `deploy/aliyun/run_voiceprint_rtc_probe.py`，指定上述后端／sampler／encoder／LiveKit 完整 image ID、固定 encoder pack 和仓库外私有诊断目录，并显式传入两个选项。该入口会生成随机凭据和一次性数据库，测试完成后自动回收；不复用本次已销毁的数据库或样本。

首轮扩展运行 `vp-full-rtc-cfeefe9d8e` 的真实身份任务、候选建议及人工确认均成功，但 `/finish` 的 fixture 错将查询数固定为 3，实际 producer 选出 5 个片段，导致总回执失败。该轮不计作整链路通过。修复只修改验收入口：核验 3～12 个查询、9,000～30,000 ms 有效语音，以及查询临时目录为空；增加针对五段查询、未完成确认、越界输入及清理残留的回归。未修改应用分段算法或放宽真实匹配门限，旧失败产物保留。

## 验收边界与后续

本地 ASR 只提供固定单说话人及时间戳响应；私有存储是内存对象的 HEAD／GET 协议 fixture，只核验预期路径及签名凭据前缀，不提供完整 S3 签名鉴权或真实 OSS 运行证明。上传／转写结果作为预发布来源 fixture 提供，不声称验收了真实上传和云端转写服务全流程。

合成信号可验证工程连通、队列、授权和人工决策约束，不能证明多人真人识别 precision／未知 FAR／设备覆盖／污染率。生产业务开关继续默认关闭。ECS 完整链路、真实 ASR、Web／Android 物理终端、WSS／TURN／E2EE／CNI 与端到端 P95，按[交付准入](voiceprint-delivery-audit-2026-10-11.md)后补；监控延期不取消发布准入。

私有原始产物位于工作区 `work/voiceprint-local-acceptance-rtc-2026-10-11/` 和 `work/voiceprint-local-acceptance-identity-2026-10-11/`，不纳入 Git；文档及回执不包含连接凭据、Cookie、音频、向量或真人姓名。
