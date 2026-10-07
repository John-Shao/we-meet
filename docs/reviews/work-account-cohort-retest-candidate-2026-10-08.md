# Work 0.3.2 单账号成果复验候选（2026-10-08）

状态：候选已准备，未重新开放生产入口，未创建第二条任务或追加模型调用。上一轮唯一任务以 `budget_exceeded` 失败，关闭并回退的结果见 [执行回执](work-account-cohort-release-2026-10-08.md)。本清单需要额外一条合成任务的明确授权。

客户端执行器 0.3.2 已构建为自包含 Windows 环境，manifest SHA-256 为 `6e7c9bc1f446d4ef2d11b8f8cd3bbdb55418e0ae9b11d5a8d90214d3ac18736f`。85 项离线 Agent 测试中 80 项通过、5 项 opt-in 跳过；内置环境 26 项 broker 测试通过，241 个产物文件校验通过。修复在锁内缩减可用输出额度，保留完整输入字节预留及未知用量占用；仍限制调用次数和累计预算。失败请求未留存，尚不能凭离线结果断言真实任务一定成功。

Android 候选为 `5116140dc92b71dc05d5866ae4170e82e85d5034`。专用 `.fixturecohort` App/测试 APK 已构建，生产 API 地址经 BuildConfig 核验；产物及哈希保存在本机忽略的验收目录和候选 JSON 中，未安装或运行真实联调用例。常规 debug/测试 APK 已重新构建，输出恢复 `com.we.meet`。运行前可按验收说明重新构建专用包，并要求哈希与候选相符；若构建产物变化，重新核验后更新清单，不直接执行。

服务端沿用已验证的候选镜像，不包含本轮客户端预算修改：

```text
jusi-cn-guangzhou.cr.volces.com/we-meet/meet-backend@sha256:e80b10e82eebea449076901453cf0669838fbd33aaae5afd176f6ab44b948e61
```

候选源码为 `e92f9eec4540a9b16dc107a421523beefc87f681`，原候选镜像验证及 CI 证据继续适用。客户端修复提交 `9db9d2f71b395d5548301a54716c81a0edafa1a0` 的 [发布检查 37652070078](https://github.com/John-Shao/we-meet/actions/runs/37652070078) 已成功；新的操作助手、清单及 Android 修复在执行前也必须通过各自 CI。

2026-10-08 00:37（北京时间）的只读检查确认：原 7 个消费者的 UID 未变，全部为原镜像、四个开关 False、closed/空名单；5 个 Deployment 就绪。Work 0007、迁移记录、单节点身份、独立 Gateway spec、Helm 457/deployed 与回退状态一致。已重新核对每个完整 spec 哈希，见 [候选 JSON](work-account-cohort-retest-candidate-2026-10-08.json)。本检查没有写入生产工作负载、创建快照或模型调用。

## 授权后执行顺序

1. 使用 `--release-id cohort-e92f9eec4-retest-032`，在全新 root-only 目录准备完整快照及私有账号信息；7 个 UID/spec 与候选 JSON 必须逐项一致。历史 `cohort-e92f9eec4` 目录和旧回执保留。新操作代码放在独立 root-only runtime 目录，通过源文件 SHA-256 固定，不覆盖历史操作代码。任何现场漂移均停止，不自动接受新基线。
2. 依旧按 workers、CronJobs、API 的顺序更新 5 个 Deployment 和 2 个 CronJob 到候选镜像。四个开关先保持关闭，closed/空名单；每项使用 UID、实时 resourceVersion 和完整 spec 的 JSON Patch 围栏。等待正常资源调度，验证心跳、Celery、实际 imageID、schema 和 Gateway。
3. 仅对原已核验的一个演示账号开启 local/remote，cloud Agent 与 Pi 审查全程关闭。上限仍为 5 次 DeepSeek 调用、累计 20000 tokens、单次输出最多 3000 tokens。不改普通业务模型、每日预算、Secret 或模型密钥。
4. 使用 0.3.2、专用 Android fixture 包及全新的本机私有验收目录，只派发 **1 条额外合成任务**。Android 选择本次桌面返回的 workspace UUID；桌面通过产品界面审阅领取。每条命令/文件写入分别批准，仅限本轮新建合成目录，禁止修改原始输入。0.3.2 的离线调整不允许越过预算或自动创建替代任务。
5. 检查终态、完整用量、输入哈希；只显式同步选中的 `report.md`，由 Android 校验成果 SHA-256 和预览内容。验证终态取消幂等，停用本次 workspace 别名。关闭全体入口、清空名单后，验证新派发与原设备重领被拒绝。
6. **成功或失败均恢复 7 个消费者到本轮快照中的原镜像，全部入口继续关闭**，再验证健康、schema、Gateway 和真实账号拒绝能力。失败时优先停止本次任务、关闭入口，再回退；不等待客户端成果检查完成才关闭。登出、移除本次 fixture 包/ADB reverse、清理临时加密 profile 和工作区，恢复普通 Android APK 输出包名。保留无凭据回执和服务器私有快照。

新状态目录为 `/var/lib/we-meet-work-maintenance/cohort-e92f9eec4-retest-032`；它在上述只读检查时不存在，快照将在新授权后创建。新目录中的私有 `values.work-cohort.yaml` 最终为 closed/空名单，后续受审发布需显式选择，不声称已对齐 Helm 历史。

本轮无数据库迁移、不回退 schema、不做通用 Helm upgrade/rollback，也不修改 K3s/PID、Gateway、PVC、TLS、Ingress 或其他业务模块。原生登录/目录选择 UX、正式签名、干净 Windows VM 验收及运行中取消/撤销生产验收仍不在本条成果复验的通过声明内。执行入口和各阶段检查参见 [验收脚本说明](../deployment/work-account-cohort-acceptance.md)。
