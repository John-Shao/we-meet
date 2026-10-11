# Qwen 离线身份评测执行器与走查

日期：2026-10-11。分支：`feature/speaker-identity-voiceprint`。

原有工具只能汇总外部提供的匹配结果，本次增加 `evaluate_voiceprint_dataset` 管理命令，执行私有预处理 PCM → 真实 Qwen RPC → 登记模板 → 校准网格选参 → 冻结参数后独立测试 → 聚合报告。它直接调用生产的向量聚合与多人匹配核心，没有另一套研究打分算法。

目前没有获授权真人录音。此次验证只使用程序生成的正弦信号，证明流程和拒绝边界可运行；不能得出 Qwen 身份准确率、远场效果或切换 CAM++ 的结论。报告始终 `release_ready=false`，不会写数据库、登记真实用户或生成可供生产加载的门限文件。

## 执行环境与命令

在独立后端环境执行，三个业务开关必须全部关闭：`MEETING_VOICEPRINT_ENABLED`、`MEETING_VOICEPRINT_SAMPLING_ENABLED`、`MEETING_VOICEPRINT_MATCHING_ENABLED`。命令不回退到业务的 encoder 配置；必须显式传入专用于此次评测的私有配置。使用独立 token、permit key、CA 和 Qwen 实例，不复用生产许可缓存或额度。

从 `src/backend` 运行：

```powershell
python manage.py evaluate_voiceprint_dataset `
  --manifest D:\private-evaluation\manifest.json `
  --dataset-root D:\private-evaluation\corpus `
  --isolated-encoder-config D:\private-evaluation\encoder.json `
  --output D:\private-evaluation\report-new.json `
  --deadline-seconds 3600
```

`encoder.json` 的结构如下，示例凭据是占位值，不能直接执行：

```json
{
  "purpose": "speaker-evaluation-only",
  "url": "https://voiceprint-evaluation.test.svc.cluster.local:8093",
  "api_token": "REPLACE_WITH_INDEPENDENT_TOKEN",
  "permit_key": "REPLACE_WITH_BASE64_ENCODED_INDEPENDENT_KEY",
  "ca_bundle": "/run/evaluation/ca.crt"
}
```

URL 只允许 HTTPS 的 loopback／私有 IP 或 Kubernetes Service DNS；后端 transport 仍检查 URL、token／key 长度及 CA，并验证 TLS 主机名。此检查不证明网络隔离或 DNS 正确性，仍须独立 namespace／容器网络与出口策略。输入、音频、人工真值和凭据留在私有目录，数据集尽量只读挂载。Windows 文件继承目录 ACL，POSIX 报告文件创建权限为 `0600`。

输出必须不存在，重复执行不能覆盖报告。成功只打印 `voiceprint_research_report_written`；任何 RPC、文件变化或契约失败均中止，不用部分结果宣称准确率，也不回显私有路径、标识或异常内容。

## Manifest 契约

JSON 顶层只接受以下字段，重复／多余字段均拒绝。完整可运行的**合成**构造样例见 `core/tests/test_voiceprint_evaluation_runner.py` 的 `corpus()`，其中登记、校准、测试是三个不同源 WAV；该函数依赖测试环境，不在生产提供数据生成入口。

| 字段 | 契约 |
|---|---|
| `schema_version` | 整数 `1` |
| `origin` | `synthetic` 或 `authorized_human`；只是操作者声明 |
| `authorization` | synthetic 必须为 null；真人必须为 `{ "path": "consent-private.json", "sha256": "实际摘要" }` |
| `annotation` | `{ "path": "annotations-private.json", "sha256": "实际摘要" }`；独立保存人工真值及质量标注依据 |
| `sessions` | 3～1,000 个实际独立会话，必须包含 enrollment／calibration／test 三种 split |
| `enrollment` | 1～250 个 subject／device 组，最多 50 人、每人最多 5 组；当前合法组为 default／headset／handset／computer |
| `queries` | 2～10,000 次说话人查询，必须包含校准和测试；一次多片段匹配只计一次查询 |
| `policy_grid` | 1～32 个预先声明且不重复的 `{ "accept": 0.99, "margin": 0.05, "min_pair_cosine": 0.85 }`；三个数均须有限且在 `(0,1]` |
| `threshold_version` | 1～64 位 ASCII 字母／数字／下划线／连字符，首位必须为字母或数字；仅研究标识 |

上表参数是协议示例，**不是校准完成的门限**。subject／session／recording／query ID 使用匿名稳定 token（1～64 位 ASCII 字母、数字、下划线或连字符）；人员映射另存私有目录。

会话结构：

```json
{
  "session_id": "session01",
  "split": "enrollment",
  "subjects": ["subject01"],
  "recordings": [
    { "recording_id": "record01", "path": "session01.wav", "sha256": "实际文件摘要" }
  ]
}
```

`path` 相对于 dataset-root，禁止绝对路径、`..` 及解析后越出根目录。全部来源只接受已预处理的 mono／24 kHz／PCM16 WAV，3 秒至 2 小时；总量最多 8 GiB、1,000 个源录音。命令不解码视频、不执行 ASR／分人或从任意 URL 下载媒体。来源必须与真实会话对应，不能用同一录音的切片伪造新会话。

片段结构，登记和查询复用：

```json
{
  "recording_id": "record01",
  "start_ms": 0,
  "end_ms": 10000,
  "quality": {
    "valid_speech_ms": 10000,
    "speech_checked": true,
    "speaker_consistency_checked": true,
    "speaker_count": 1
  }
}
```

每片段 3～10 秒、每行 1～12 段，时间须落在来源内。`quality` 必须来自独立人工／已验证质检；Qwen 的 signal-only 响应不替代语音及单人真实性。合成正弦样例中的这些字段仅用于协议测试，不声明正弦信号是人类语音。

每个登记行仅含 `subject_id`、`device_group`、`clips`。登记至少三段、有效语音声明合计至少 30 秒，均须独立确认单人。每人必须有 default 基线：组内任意片段余弦须 ≥ 生产一致性门限 0.85；设备组每片段还须与基线模板余弦 ≥ 0.85；之后按生产等权聚合。0.85 是工程一致性检查，不能据此认定身份。

每个查询行仅含：`query_id`、`subject_id`、`session_id`、`recording_id`、`start_ms`、`end_ms`、`condition`、`eligible`、`candidate_subjects`、`clips`。来源只能属于 calibration 或 test；该真值人员须在对应会话声明内，片段须在同一录音的查询跨度内。`condition` 为 near／far；`eligible=true` 至少三段、9 秒有效语音声明，并已确认单人。不能以匹配成功倒推 eligible。同一录音同一真人的片段及查询跨度均不能重叠。

候选只能引用此次研究已建立模板的匿名人员，最多 50 人；空候选合法并会保持未知。候选名单由外部整理过程按授权及实际产品路径冻结，命令不读取通讯录或业务权限。未登记访客列入实际会话真值，但不补入候选。

## 校准、隔离与输出

1. 先检查所有 split 的结构、文件摘要、整体规范 PCM 重复与时间范围。每次切片对同一个打开文件前后核对 SHA-256，RPC 前后再次检查总时限。
2. 先提取登记、再提取校准向量。同一个规范 PCM 片段无论来自哪个文件／人员／split 均不得再提取，发现复制即中止；不是仅比较 WAV 元数据。此检查不等于识别变速／重编码、部分重叠或伪造会话，仍需独立来源审查。
3. 只在预先声明的网格上调用生产 `match()`。精确率／未知误接受率／近场有效覆盖率均须有分母，经验率分别达到 ≥99%／≤1%／≥80% 才成为**研究**候选。先最大化近场覆盖，再依次选择更严格的 accept／margin／min-pair，最终按原网格顺序消除并列。
4. 没有可行校准项时，报告 `no_empirically_feasible_calibration_policy`，不提取最终测试向量；有候选才冻结参数，进入 test。测试输出不会修改选参，测试数据修改也不能改变校准摘要；校准摘要绑定登记／校准来源、网格、固定特征空间、生产匹配／向量源码摘要和一致性门限。
5. 测试汇总复用原有标准库报告模块，保留各指标分子／分母、近远场、人／会话描述与 Wilson 独立二项区间。把校准候选中的人员也视为已参与校准，不能把用过的负例模板计为新人员盲测。

报告只输出聚合统计、制品／数据摘要和研究参数，不输出匿名人员／会话／查询 ID、候选名单、音频片段摘要、姓名或向量。内部 `calibrated=True` 仅用于执行受门禁约束的生产匹配函数，不输出生产 ThresholdPolicy。嵌套的三个研究参数不能作为 `MEETING_VOICEPRINT_THRESHOLD_CONFIG_FILE` 加载。

执行时限 120～86,400 秒、最多 130,000 次提取；这是阶段边界预算，不是可中断的硬墙钟时限，进行中的一次 RPC 仍受 transport 自身 30 秒限额约束。报告记录提取次数与 RPC 中位数／经验 P95／最大值、执行耗时，不包含队列、ASR、权限、解密、持久化或建议展示。授权／标注文件摘要只是可追溯声明，工具不认证其法律授权或真值。实际数据集还需独立人／会话、不确定性、污染／分人和设备验收。

## 本轮验证证据

- 22 项执行器回归通过：生产匹配、校准与测试顺序、测试不影响选参、无可行门限不读取测试音频、整体 PCM／跨来源复制片段拒绝、源变化、超时、质量／基线／设备组、路径／网格／授权、业务开关与独立 HTTPS 配置、固定错误／输出消息、报告隐私及禁止覆盖。
- 原标准库报告的 9 项单元／CLI 测试通过。原 `deploy/aliyun/voiceprint_evaluation_report.py` 保留兼容入口；实现移至 `core/services/voiceprint_evaluation_report.py`，使发布镜像无需携带仓库 deploy 目录。
- 本地 Linux 的真实 HTTPS Qwen 集成通过：非 root、只读源码／模型、独立 internal Docker 网络和临时 CA／token／key。15 次十秒合成信号提取覆盖登记三段、校准六段、最终测试六段；调用真实 EncoderClient 与生产匹配核心，数据库 `ensure_connection` 被禁止且未触发，报告权限为 0600、业务开关关闭。服务 success 指标与提取次数一致。两个测试查询的状态为 suggested／unknown，这是协议结果，**不是身份准确率样本**。
- 实际提取 RPC 的中位数约 80.46 ms、经验 P95／最大值约 174.95 ms，执行约 1.40 秒；15 次样本且先等待 ready，不含模型冷启动，不作为容量或业务 SLA。
- 初次探针采用 Test 配置，其开发专用 `drf_spectacular_sidecar` 不在发布镜像，初始化失败；保留失败回执后改用 Production 配置，通过上述集成。没有修改运行代码或安装开发依赖规避错误。
- 两个临时容器、独立网络及六个临时凭证文件均清理。此集成最初使用既有后端镜像加只读源码挂载，后续新发布制品及回归结果见补验记录；不得把旧镜像 ID 称为已包含新命令。

Qwen encoder 制品为 `we-meet-voiceprint:metrics-20261011`，本机镜像 ID `sha256:43e4b7c4b77199bc31f4352dd0d6d617e881c6d227860f67b4074a83bdd32bd7`。后端依赖镜像为 `we-meet-backend:voiceprint-integration-20261011`，ID `sha256:a070f009869de175f9d8f8b8ad8f4a313ea644c81215f980fdf7788f48280c84`。此次执行器源码 SHA-256 为 `21d66d83b9035a3bed33290b673654d22a503277ea849fa8fe31ca344f9230c4`；匹配／向量摘要均保留在私有回执。

原始产物在工作区 `work/voiceprint-dataset-integration{,-initial}-result-2026-10-11.json` 与对应日志，探针源码摘要 `c17200776620c29fb5c87fcbbec4eb13e231a9fe03c1d041544b30459b90f1b7`。这些产物不纳入 Git。仍无真人授权样本、校准生产门限和真实设备／完整业务效果验收，不发布自动身份建议。

### 发布镜像与关联回归补验

从当前工作树用标准 Dockerfile 的 `backend-voiceprint` target 构建 `we-meet-backend:evaluation-20261011`，本机镜像 ID `sha256:c7a41fd330b95dd9c214c045086804c2fcc65c74c882e5dc1c0fb36cffe6abae`，默认 UID 为 10001。没有上传 registry 或部署到 ECS。

该镜像不挂载后端源码，再次通过 Production 配置运行新命令与真实 Qwen HTTPS：15 次十秒合成提取、冻结研究参数后测试、禁止数据库连接、0600 报告、指标计数、结果隐私及默认关闭均通过。前后两轮的数据集／校准／研究策略摘要完全一致，匹配、向量、评测执行／汇总及管理命令五个镜像文件的规范换行 SHA-256 与工作树逐一相同。该轮 RPC 中位数约 78.57 ms、P95／最大值约 137.26 ms，执行约 1.33 秒；不与首轮相加成独立身份样本。

两轮均采用本地 Linux、UID 10001、只读根文件系统、cap-drop、internal Docker 网络；encoder 和 caller **各自**限 2 CPU／2 GiB，模型只读，未使用 ECS 或业务数据库／Redis／ASR。合成数据与报告仅在 caller 的 64 MiB 临时目录中生成，容器退出后清理；Windows 工作区保留的只有公开探针代码和聚合回执，六个临时凭证文件另行逐个删除。此次 packaged 探针摘要 `ec8c3f84b69a8fa71082ebb06d71b0dd71b38283767c1553147077af8254b9f9`，原始结果为 `work/voiceprint-dataset-packaged-result-2026-10-11.json` 与日志、`work/voiceprint-dataset-image-result-2026-10-11.json`。

关联回归包含执行器、生产匹配、登记模板和设备基线：173 项全部通过、无跳过，耗时 103.13 秒，使用隔离测试数据库；其中执行器的 22 项不授权数据库访问。原报告 CLI 的 9 项另行通过，不能与之前大范围回归相加成独立总数。改动文件 Ruff 检查／格式检查和 `git diff --check` 通过；没有模型或迁移变更。
