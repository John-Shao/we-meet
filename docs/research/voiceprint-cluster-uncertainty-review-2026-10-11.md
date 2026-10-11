# 声纹评测按人／会话区间走查

日期：2026-10-11。分支：`feature/speaker-identity-voiceprint`。

方案第 15 节要求按人／会话报告不确定性，原报告只有分组样本量、率范围／等权均值和独立二项 Wilson 区间。现新增分别按真人标识、实际会话标识整组重采样的区间，供独立数据审查使用。这里的验证数据全部是程序生成的协议结果与正弦信号，没有新增真人录音或身份准确率结论。

## 方法与输出边界

在每个指标的 `by_person.cluster_bootstrap95`、`by_session.cluster_bootstrap95` 增加方法、名义水平、区间、完整查询队列的组数／该指标非零分母组数、有效／零分母重复数、固定种子、预算、状态及假设。原查询加权率、分子／分母、分组描述和 `wilson95_iid` 保留，schema_version 仍为 1，字段增量添加。

每次从完整测试查询队列的 G 个组中等概率、有放回抽取 G 组，保留组内所有查询对应的指标分子／分母，计算合计分子／合计分母。它不逐查询或逐向量重采样，也不平均组内比例。没有建议的人仍在精确率重采样队列中，相关组对分子／分母的贡献为零；未知 FAR、近场／远场覆盖各自使用正确的分母筛选，不删除失败查询。

整组重采样的依据见 [Cameron 与 Miller 原文第 II.F 节](https://cameron.econ.ucdavis.edu/research/Cameron_Miller_JHR_2015.pdf)。论文同时讨论少组、组间相关及不平衡组的局限；该方法不保证本项目真人数据满足假设。百分位区间属于 [R boot 官方文档所列的 bootstrap 区间类别](https://stat.ethz.ch/R-manual/R-devel/library/boot/html/boot.ci.html)；本实现用经验分位的线性插值，不声称逐位复制 R 的端点算法。

实现固定 999 次重复、种子 20261011；先按各组聚合计数排序，人员 token 改名或输入次序改变不影响结果。输出 2.5%／97.5% 经验分位。每个维度最多 1,000 个队列组；指标非零分母至少 30 组才尝试计算。**30 是工程拒绝边界，不是统计有效性的定理或生产准入标准**。大于预算时不裁剪人员，保持主指标并注明区间未计算。

| 状态 | 处理 |
|---|---|
| `no_denominator` | 指标没有可用分母，interval=null |
| `too_few_metric_clusters` | 少于 30 个该指标非零分母组，interval=null |
| `cohort_cluster_budget_exceeded` | 完整队列超过 1,000 组，不进行重采样，interval=null |
| `no_observed_cluster_variation` | 各非零分母组的比例完全相同，包括全零错误／全部正确，interval=null |
| `unstable_bootstrap_denominator` | 有效重复不足请求次数的 95%，不根据剩余重复宣称区间 |
| `degenerate_bootstrap_percentiles` | 两个经验分位相同，不输出零宽区间 |
| `estimated_under_declared_assumptions` | 给出名义 95% 的经验百分位区间，同时保留假设 |

这两种区间分别假定对应维度的组间独立，不能合并为同时控制“同人、同会话交叉相关性”的联合区间，也不覆盖新设备／场景的分布漂移。零观测错误不能产生“真实错误风险为零”的结论；独立二项 Wilson 上界仍带有其独立假设，不用它替代相关性分析。少组、极度不平衡或少数错误组的实际数据还需审查完整重采样分布与研究设计。两个维度不同的端点范围不能简单取并集后宣称联合 95% 覆盖。

报告不输出人员／会话标识或重采样索引；不读取数据库、写门限、触发 CAM++ 切换或改变 Qwen 匹配打分。校准选参仍仅使用 calibration，区间在冻结研究参数后的 test 阶段生成，`release_ready=false`。执行器补上统计完成后的总时限检查，超时不发布报告；它仍是阶段边界限额，不是可中断的硬墙钟计时。

## 验证与制品

- Windows 与隔离 Linux 各 15 项标准库报告测试通过，其中六项新增验证：整人重复查询不虚增独立样本、会话维度／匿名重排确定性、零错误／少组／资源拒绝、组大小不等的查询加权率、保留无建议队列成员及分母契约拒绝。
- 执行器 23 项回归通过，新增统计阶段超时后禁止报告发布；沿用原校准／测试隔离和 PCM／授权声明门禁。不重复声称上一轮 173 项关联回归在新镜像全部重跑。
- 新发布镜像内纯报告 CLI 完成 30 个合成人标识、30 个合成 test 会话、90 个查询，四项指标的人／会话两类区间均生成，输出 0600、匿名标识不泄漏、发布门禁保持 false。CLI 约 28.25 ms；1 万条合成查询、每维度 1,000 组、两类区间约 216.32 ms，是单次有界统计测量，不含编码或业务链路。
- 新镜像 Production 配置继续通过真实 Qwen HTTPS：15 次十秒合成提取、禁止数据库连接、冻结参数后测试、聚合输出及默认关闭。该小样例只有两个人标识、一个 test 会话，新增区间正确为 null，没有伪造可信度。Qwen 的数据集、校准摘要和研究策略摘要与上一轮一致，匹配／向量源文件未变。临时容器、网络及六个凭证文件全部清理。
- 新镜像评测执行／汇总、匹配／向量及管理命令五个文件的 SHA-256 与最终工作树一致。改动 Ruff、格式和差异空白检查通过。

最终后端镜像 `we-meet-backend:cluster-evaluation-20261011`，本机 ID `sha256:789ec902ea0247d842aa786f7e0cf10d9beb25e09ebe07d366cb2ecc8a32fadc`。标准 Dockerfile 的 backend-voiceprint target、UID 10001；纯报告探针使用只读根／断网／2 CPU／2 GiB／64 MiB 临时目录，Qwen 联调用独立 internal 网络、caller 和 encoder 各限 2 CPU／2 GiB。镜像未上传 registry 或安装到 ECS。

当前汇总源码 SHA-256：`865b4218cc399827a8079bd1a5c05b6aa2d932738d859cc2fd5d3828252d1583`；执行器：`475387f142938d41cef2ca2dcec80768eb6a3b0bb3263f3e3d126a77eabb8023`。私有工作区产物：`work/voiceprint-cluster-report-result-2026-10-11.json`、`voiceprint-cluster-{unit,runtime}-2026-10-11.log`、`voiceprint-dataset-cluster{,-image}-result-2026-10-11.json` 与 Qwen 联调日志。纯报告探针摘要 `ce183de62592b5007c30dd7d733d84723ea948ee69d739e1a4455a0d08455934`，Qwen 探针 `ec8c3f84b69a8fa71082ebb06d71b0dd71b38283767c1553147077af8254b9f9`。产物不纳入 Git。

尚缺授权真人、独立人员／会话设计、联合相关性／真实未知风险、污染／分人和实际设备／完整链路准入。区间工具补齐报告能力，不替代上述验收。
