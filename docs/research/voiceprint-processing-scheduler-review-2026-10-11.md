# 声纹持续处理调度走查

日期：2026-10-11（Asia/Shanghai）。在 `feature/speaker-identity-voiceprint` 接通持续处理定义、生产 Celery 注册和身份命令的私有媒体配置。没有生产部署、真人录音或收费服务调用。

## 最终行为

此前登记编码、单人质检、模板与身份识别均有数据库租约和手动命令，但没有完整的持续消费定义。新增两个无参数周期任务，执行时选择当前数据库对象，不将对象身份、向量、音频、配置或密钥放入定时消息。

| 队列 | 工作 | 周期／期限 |
|---|---|---|
| `voiceprint` | 现有来源清理、候选回收、采样派发／恢复和分人恢复扫描 | 保持现有周期与期限，功能关闭后仍可清理 |
| `voiceprint-processing` | 一个批次依次检查模板、质检、编码，各最多一个对象 | 每 15 秒；消息 30 秒过期；软期限 105 秒、硬期限 120 秒 |
| `voiceprint-identity` | 一次身份匹配批次，以及原有较长的录音分人处理 | 身份批次每 15 秒，消息 30 秒过期；软期限 850 秒、硬期限 900 秒 |

模板、质检与编码共用一个有界批次，避免独立消息过期时，先到的慢任务持续占用队列而饿死其他阶段。模板先执行；两个原生 RPC 各有既有 35 秒内部上限。批次按 monotonic 时间保留 100 秒执行预算，开始每个阶段前至少留出 40 秒；预算不足时只返回固定状态，等待下一次新扫描。顶层软期限继续传播，不能被通用错误处理吞掉后启动下一个阶段。

普通配置或单阶段异常不会阻止其他阶段运行；日志只包含固定阶段名和固定失败分类，没有异常文本／堆栈、文件路径、令牌或正文。周期任务不保存 Celery 结果；返回值仅为固定分类和聚合计数。所有阶段继续使用原命令中的运行时开关、授权／generation／有效来源、数据库租约、最多三次尝试、可终止子进程及写入复核；不会替代用户确认、校准门槛或人工决定。

将 `process_capture_diarization` 从 `voiceprint` 移到 `voiceprint-identity`，使较慢的媒体／云端处理不占用撤销和回收的消费者。对应扫描和私有输入清理仍走原控制队列，任务名和已有数据库操作不变。

`identify_speakers` 未提供 CLI 路径时，读取既有 `MEETING_VOICEPRINT_MEDIA_CONFIG_FILE`。文件必须为绝对路径、1–8192 字节、精确 JSON 字段 `ffmpeg`／`ffprobe`，程序路径必须为绝对路径且存在。走查修复该共享读取器先 stat 再无界读取的问题：现在只读至 8193 字节后判定，文件轮换不能绕过大小上限；导入预检共用这一修复。仍允许完整 CLI 覆盖；仅提供一个程序路径时拒绝配置，不混合两种来源。

## 验证证据

- 最终调度、注册与导入预检共 **69 项通过**（20 项调度专项、2 项模块发现、1 项独立进程注册／路由、46 项导入预检），23.05 秒：默认／分阶段关闭不查询私有数据，单次上限，活租约不重放，过期租约恢复，撤权后不发布特征，质检补建，未确认不建模板，模板公平轮转，错误脱敏，私有媒体配置／轮换读取上限，以及阶段预算／软期限／其他阶段继续推进。
- 登记、质检、模板、身份、回收、来源删除和采样恢复的组合回归 **292 项通过，2 项因未指定本地模型／媒体环境而跳过**，237.69 秒。这次组合验证先于最终批次协调调整；调整及配置读取修复后执行了上述 69 项验证，未改变各服务的租约／写入逻辑。
- 之后指定已有审计模型包、CPU Python 环境和 FFmpeg 9.0.2，补跑内部、公开 API、**定时入口**三条真实私有媒体→FFmpeg→Qwen→数据库链路：**3 项全部通过**，70.97 秒。ASR／对象存储为本地 HTTP 契约，输入为合成信号；每条均实际提取三个片段、持久化建议、清理临时媒体，且不自动写入说话人身份。这些结果单独记录，不与组合回归直接相加。
- `CELERY_ENABLED=True` 的独立进程实际执行 `app.autodiscover_tasks(force=True)`，验证两个新增任务是 Celery Task，路由、软／硬期限和不保存结果配置正确；录音分人移至新队列，维护保持旧队列。仅检查注册／路由，发布消息数为 0。
- Django `check`、变更 Python lint／格式和差异检查通过；无数据模型／迁移变化。现有 Django 过渡设置和本地静态目录提示未扩大。

上面的真实媒体链路在 Windows 本地受控环境运行；新增周期任务尚未由 Linux prefork worker 通过实际 broker 消费。上一轮[Linux 编码器证据](voiceprint-linux-encoder-review-2026-10-11.md)证明编码器容器运行，不能替代本轮业务消费者的部署／恢复验收。

## 部署接入要求

下一阶段必须接入三个独立消费者及唯一 Beat。`CELERY_ENABLED=true`，关闭 eager 执行，消费者和 API 使用同一数据库、私有配置与业务开关；新队列不会由普通 `meet-backend` 消费者自动接管。功能仍默认关闭，基础任务注册不授权采样或收费处理。

消费命令形式如下，实际镜像、Secret、存储、资源与进程恢复由后续 Helm 阶段接入：

```sh
celery -A meet.celery_app worker -Q voiceprint -c 1 --prefetch-multiplier=1 -n voiceprint-control@%h
celery -A meet.celery_app worker -Q voiceprint-processing -c 1 --prefetch-multiplier=1 -n voiceprint-processing@%h
celery -A meet.celery_app worker -Q voiceprint-identity -c 1 --prefetch-multiplier=1 -n voiceprint-identity@%h
```

生产使用支持期限的 prefork，限制并发／预取，并验证 TERM／硬退出时原生后代回收与数据库租约恢复；线程／solo 消费验证不能证明这些生产行为。参见 [Celery worker 官方说明](https://docs.celeryq.dev/en/stable/userguide/workers.html#time-limits)。Beat 应保持一个活动调度实例，避免重复周期派发，参见 [Celery 周期任务说明](https://docs.celeryq.dev/en/stable/userguide/periodic-tasks.html#introduction)。过期旧消息不能替代持久任务清理；恢复依靠新的数据库扫描。

若已有功能部署，升级时先启动新消费者，再切换／排空旧 `voiceprint` 队列中的录音分人消息，避免遗留消息占用清理预算。当前 feature 未部署生产，本轮未修改任何实际 broker、集群或用户开关。

## 剩余完整范围

持续处理定义已完成，消费者 Helm／私有配置、采样 agent、后端 ffmpeg／ffprobe 镜像、本地临时文件回收、Linux 实际消费／终止恢复及生产监控仍须接入和验收。真实 RTC／设备、历史版本／搜索、外部可信墓碑备份恢复和获授权真人效果也继续推进；完整目标尚未完成，Qwen 优先路线不变。
