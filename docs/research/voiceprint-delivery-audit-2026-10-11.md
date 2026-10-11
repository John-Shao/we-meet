# 声纹身份识别交付走查与当前验收边界

日期：2026-10-11（Asia/Shanghai）。对应[实施方案](../plan/speaker-identity-voiceprint-plan-2026-10-09.md)。本报告集中记录当前代码、合成工程验证及尚缺的发布证据；各阶段报告中的“剩余工作”描述保留其历史上下文。

审核输入：`we-meet` 功能分支 `7aa0f226daa1ae7b24b34566354533f56ddf86e2`、本次合入的 `aliyun-dev` 提交 `c72b6d0abd5bbb7458d00c4b5c27d30dbff47567`；Android 功能分支 `d5782b3218a8e7f4cefeed622fc44ff60c838ac1`。仅更新功能分支，正式发布与生产采集仍需完成下述准入。

## 本轮发现及修复

最新基线新增拍图问答路由，与功能分支的审批导入及声纹采样路由发生合并冲突。解决后同时保留 `AiCallPhotoView`、审批路由、独立采样许可及组织运行状态入口，避免遗漏功能或重复导入 `DirectAIAllocationView`。基线新增的 `AI_CALL_PHOTO_MODEL` 设置一并保留。

基线另有 `0200_photo_qa_prompts` 迁移，而声纹迁移链延伸至 `0221_voiceprint_sampling_control_fence`。新增空操作汇合迁移 `0222_merge_photo_qa_voiceprint`，依赖两条链的叶节点；既有编号和历史迁移不改写。独立 PostgreSQL 数据库完整迁移成功，图中核心应用只剩汇合迁移一个叶节点，无模型漂移。

合并在隔离工作树中完成；原分支的完整回归使用固定源码。后续合并回归使用单独数据库，实际 Qwen／FFmpeg 补验在另一数据库运行，避免相互清理测试数据。

## 本轮验证记录

| 范围 | 结果与实际覆盖 | 限制 |
|---|---|---|
| 完整后端专项 | 收集 1,446 项，1,399 通过、47 跳过，耗时 1,444.05 秒 | 外部 Qwen／FFmpeg 配置及 Windows 符号链接能力导致跳过；另行补验见下一行 |
| 合并后的实际模型／媒体补验 | 120 项通过，无跳过，耗时 210.70 秒：实际 Qwen RPC、私有来源到持久化建议、查询片段及 FFmpeg 解码／重采样 | 使用合成信号和本地 ASR 协议 fixture，身份准确率未测 |
| 合并影响回归 | 186 项通过，无跳过，耗时 293.79 秒：拍图、AI 通话、审批、提示词、组织运行状态、采样连接／调度 | 测试数据库与完整回归独立 |
| Web | 原专项 129 项通过；合并后声纹及全局搜索共 136 项通过；`tsc -b` 通过 | HTTP／组件 fixture，不替代真实终端验收 |
| Android | 9 个 JVM 套件、110 项通过，无失败／错误／跳过 | 本轮未新增物理设备验收；此前模拟器报告仍单独保留 |
| 独立采样 agent | 31 项 unittest 通过 | 合成 PCM／SDK 行为测试 |
| Qwen encoder | 固定实际 encoder pack 的 84 项通过，无跳过 | 加载、向量及进程错误契约，未使用真人 |
| Helm | 29 项部署模板 unittest 通过 | 渲染与约束检查，未安装到目标集群 |
| 迁移／系统 | 完整迁移、无模型漂移、迁移后 `manage check`、改动 Ruff 检查通过 | 隔离本地数据库 |
| 合并后的发布镜像 | UID 10001，非 root／只读／断网静态检查通过；拍图、审批、采样、运行状态路由及唯一迁移叶节点通过 | 检查仅覆盖 models／urls；未声称网络、数据库健康验收通过 |
| ECS 实际 Qwen／模型卷 | [独立 Job 资源走查](voiceprint-ecs-resource-review-2026-10-11.md)：只读 PVC、UID 10001、2 CPU／2 GiB 实际限额；首轮 16 次、补验 3／5／10 秒与 1／2 Torch 线程共 186 次合成提取通过，覆盖每长度 30 次预热的经验 P95，测试资源清理通过 | 现有请求占 3.65／4 CPU，短期探针采用 250m 请求；经验编码器 P95 不替代端到端 SLA，完整生产部署、并发及真人效果仍未准入 |
| 匹配核心模板规模 | [本地 Linux 生产镜像基准](voiceprint-matching-resource-review-2026-10-11.md)：1／10／50 人、1／5 设备组、3／12 查询段共 372 次通过，上限组合经验 P95 约 1.32 秒 | 合成向量、断网、开关关闭；不含授权／解密／持久化／排队，不提供真人效果或端到端容量结论 |

本轮完整回归的警告主要涉及测试静态目录及既有依赖行为，未出现测试失败。补验计数与完整回归存在重叠，不相加为“独立测试总数”。

最终本地后端镜像：`we-meet-backend:voiceprint-integration-20261011`；本机镜像 ID 为 `sha256:a070f009869de175f9d8f8b8ad8f4a313ea644c81215f980fdf7788f48280c84`。镜像内 `core/urls.py`、`meet/settings.py`、组织运行状态服务及汇合迁移四个文件的 SHA-256 与工作树逐一一致。镜像未上传 registry。

私有原始产物保存在工作区 `work/`：`voiceprint-completion-backend-2026-10-11.log`、`voiceprint-integration-{backend,media,web,image,image-check,migrate,check}-2026-10-11.log`、`voiceprint-completion-{encoder,android-jvm}-2026-10-11.log`。真实双库备份／恢复、完整 RTC 及容量产物见对应阶段报告。该目录不纳入 Git。

## 方案要求与现有证据

| 要求 | 当前实现／工程证据 | 仍需验收 |
|---|---|---|
| D1／D4：首期人工确认，自动不覆盖人工 | 最终姓名由人工决定；成员与自定义标签互斥，revision 冲突拒绝；采样候选逐次本人确认；[人工决定及建议走查](voiceprint-identity-review-fixes-2026-10-10.md) | 真人污染／纠错效果、实际跨端操作 |
| D2／D3／D8：组织隔离、独立授权、候选边界 | 主动登记、匹配、通话采样三项授权独立；候选最多 50 人；读取、任务完成及入库重新授权；[授权生命周期](voiceprint-consent-lifecycle-2026-10-10.md)、[候选与匹配](voiceprint-matching-core-review-2026-10-10.md) | 目标组织角色、真实多账号和共享设备 |
| D5：Qwen 优先 | 固定 Qwen3-TTS Base 的 speaker encoder、许可与制品哈希；[模型技术探测](voiceprint-qwen-technical-probe-2026-10-10.md)、[Linux encoder](voiceprint-linux-encoder-review-2026-10-11.md) | 获授权真人的实名匹配效果与门限校准；尚无切换 CAM++ 的效果结论 |
| D6／D7：候选／模板保留、仅文字门禁 | 候选 24 小时、确认后音频清理、12 个月未更新模板暂停；文字模式不入库；临时媒体与来源生命周期约束 | 目标存储、备份及删除传播实测 |
| P1：基础与导入 | 登记、加密、模板证明、worker、导入预检与身份建议；Web／Android 通讯录与标签；[导入预检](voiceprint-import-preflight-review-2026-10-10.md)、[Android 导入](voiceprint-import-android-review-2026-10-10.md) | 导入真人多人文件与物理终端验收 |
| P2：独立通话积累 | agent 先获许可再订阅，连接默认不自动订阅；暂停、静音、换轨、重连、配额及本人确认；[强制日志下完整 RTC](voiceprint-journal-rtc-review-2026-10-11.md) | 目标 LiveKit 房间／E2EE、真实麦克风、设备变更和多端同账号 |
| P3：录音后识别 | 结束后分人 generation、字词安全投影、时间范围与来源证明；搜索／引用／分享历史不回写旧姓名；[身份搜索](voiceprint-identity-search-review-2026-10-11.md)、[纪要历史](voiceprint-summary-identity-history-review-2026-10-11.md) | 真实 ASR 字词时间戳与多人分人效果、整体回放／导出 |
| D11：撤销／删除／恢复 | 在线来源清理、周期重扫、独立日志提交前门禁及旧备份重放；[周期擦除](voiceprint-scope-erasure-review-2026-10-11.md)、[日志门禁](voiceprint-journal-gate-review-2026-10-11.md)；本轮核验现有 OSS 备份 30 天过期规则 | 生产增长预算、日志 HA／自身恢复／可信最新头、密钥管理、物理到期时限及声纹生产恢复 |
| 第 18 节：运行状态与资源 | 三类隔离消费者／配额／超时、组织只读汇总；[运行状态入口](voiceprint-operations-review-2026-10-11.md)、[容量测量](voiceprint-journal-capacity-review-2026-10-11.md) | 目标查询成本、长期并发、告警及清理时限；当前 P95 包含排队，不是身份建议 SLA |
| D9／D12：效果与授权准入 | [离线评测结果报告](voiceprint-evaluation-report-2026-10-11.md)提供汇总契约；`release_ready` 始终为 false | 目前暂无获授权真人样本或参与者，真实效果准入尚未通过 |

P0 的真实媒体／授权真人／门限部分尚未结束，P1～P3 已有代码与合成工程证据，不据此宣布各阶段生产验收通过。P4 自动更新／自动最终归属与 P5 实时身份为另行评审的后续阶段。

## 用户提供 ECS 的只读核验

2026-10-11 核验用户提供的 `36.151.142.132`，登录成功。账户凭据只用于连接，不写入仓库或本报告。

| 项目 | 实际读到的情况 |
|---|---|
| 系统／计算 | Ubuntu Linux 6.8.0-53，4 个逻辑 CPU；内存约 15,989 MiB、当次 available 8,661 MiB；无 swap |
| 磁盘 | 根盘约 99 GB，已用 65 GB、可用 30 GB；`/opt`、`/srv` 同盘 |
| 集群 | 单节点 k3s `v1.36.2+k3s1`；allocatable CPU 4、内存 16,373,008 KiB；未看到 GPU allocatable 项 |
| 当次负载 | `kubectl top nodes` 读到 1,182m CPU（29%）、7,471 MiB 内存（46%）；只是一时采样，不是容量保证 |
| 现有业务 | `meet` namespace 中已有后端、Web、各类 agent／Celery、LiveKit、PostgreSQL、Redis；另有 work review 工作负载 |
| 主要版本 | LiveKit `v1.12.0`；PostgreSQL 镜像 16.4.0；Redis 镜像 7.4.1；后端为 `a327e9e4f`、Web 为 `cd18782df`，尚非本声纹制品 |
| 存储／网络 | `local-path` StorageClass，回收策略 Delete；读到 PostgreSQL／Redis 及 work review 的 NetworkPolicy，未据此认定声纹隔离已配置 |

该主机已进一步完成[独立 namespace 中的 CPU Qwen／只读模型卷验证](voiceprint-ecs-resource-review-2026-10-11.md)，测试资源已清理。初次资源概况为只读查询；后续短期测试采用独立 namespace 与合成信号，未修改现有工作负载。实际剩余调度额度只有约 350m CPU，完整链路测试与生产部署预算仍需明确，不能按整机 4 核／16 GB 全部供声纹使用。

后续隔离测试需使用独立数据库、Redis／对象前缀、模型制品、独立日志及测试账号；采用合成音频，ASR fixture 与真实 provider 验收分开记录。单节点测试能验证故障关闭与重放流程，不能证明生产 HA。E2EE、房间服务准入、真实音轨身份、备份物理到期及密钥删除仍需目标环境核验。

### 现有备份的实际配置与元数据

2026-10-11 12:08（Asia/Shanghai）继续只读核验备份定时器、当前部署脚本、OSS 控制配置及对象元数据。连接凭据仅在服务端进程内读取；没有下载备份载荷、解密数据或修改生命周期／对象。

- `meet-backup.timer` 与 `meet-backup-check.timer` 均 active；最近服务执行 `Result=success`、`ExecMainStatus=0`。当前 `/opt/meet-backup/backup.py` 的 SHA-256 为 `2f2280cf97781cdadf98fb9cdf57423aab46be7c33dbed74b1132c0ccfb60ca1`，与本分支 `deploy/backup/backup.py` 完全一致。
- OSS 生命周期返回一条启用规则，前缀覆盖实际配置的备份前缀；筛选仅为 Prefix，没有标签／大小条件，Expiration Days 为 30。桶版本控制返回未启用，因此本次无需另追踪历史版本规则。
- 桶与最新归档对象的 ACL 均仅授予所有者。最新本地成功回执完成于 `2026-10-10T22:18:08.306740Z`；核验时距今约 5.83 小时，归档对象为 `.age`、38,915,743 字节，HEAD 大小及 SHA-256 元数据与成功回执一致。这是元数据一致性验证，未重新读回整个对象。
- 配置前缀下共 84 个 `.age` 对象、889,929,300 字节；最早更新时间为 2026-10-06，当前没有超过 30 天的对象。归档历史尚不足 30 天，不能用“没有超期对象”证明生命周期执行的物理删除时限。

私有原始结果：`work/voiceprint-ecs-oss-inventory-2026-10-11.json` 与备份定时器元数据 `work/voiceprint-ecs-backup-inventory-2026-10-11.json`。早期非特权目录遍历没有读取 root 私有目录的权限，其空结果不作为“目录无文件”的证据。Home 下的部署副本同样不作为当前运行源码依据。

该核验补齐“现有备份保留 30 天是否真的配置”的事实，尚未验证满期清除，也未覆盖尚未部署的声纹主库／独立日志及其恢复切换。备份包的当前撤销信息不能替代独立可信最新头；正式接入仍按日志门禁与恢复流程验收。

## 首期发布尚缺的证据

1. 授权真人队列与会话隔离的数据集，Qwen precision／未知 FAR／设备覆盖、污染和分人评测，以及有版本的校准门限；不能拿合成信号替代。
2. 目标环境的独立端到端链路、Web／Android 物理终端与设备／角色矩阵；真实 ASR 完成到建议可见的 P95 测量。
3. 独立日志、主库与对象存储的生产容量、增长／保留、备份恢复、密钥轮换与可用性方案及告警。当前超限拒绝不能替代“立即撤销”的容量保障。

三项业务开关继续默认关闭；人工通讯录／标签归属可独立使用。取得新的授权与验收证据后更新本报告，不把测试服务器连接成功记为功能发布完成。
