# Work 单账号受控联调候选（2026-10-07）

本候选随后已按单账号授权执行；任务因预算守卫失败，入口关闭并完成镜像回退。实际结果见 [2026-10-08 回执](work-account-cohort-release-2026-10-08.md)。以下内容保留候选准备时的状态。

状态：候选镜像及验证已准备，尚未更新生产工作负载或打开功能开关。此前授权清单要求四个新功能开关保持关闭；本清单的单账号开放阶段需另行确认。

源码提交 `e92f9eec4540a9b16dc107a421523beefc87f681`，Release guard [37644693656](https://github.com/John-Shao/we-meet/actions/runs/37644693656) 成功。候选从干净 git archive 构建，target 为 backend-production，amd64、root 与现有业务运行方式一致：

```text
jusi-cn-guangzhou.cr.volces.com/we-meet/meet-backend@sha256:e80b10e82eebea449076901453cf0669838fbd33aaae5afd176f6ab44b948e61
```

Registry digest 与构建元数据一致。实际生产镜像中的 Python 源码及 uv.lock/pyproject.toml 与源码 archive 一致，revision label 匹配。隔离 PostgreSQL 上验证默认关闭、名单账号与其他账号区分、远程排队/原设备领取，以及名单撤销后的停止回报；不挂载业务源码替换镜像内容。使用 Build 配置进行隔离 ORM/API 验证，未把缺少开发依赖的生产镜像视为 pytest 运行环境。本地 Work 回归 106 项通过、6 项 opt-in 跳过，发布验证 52 项通过。没有真实模型调用。

用户指定演示账号已完成真实 HTTPS OTP 登录与数据库 UUID 匹配，仅保存不含凭据的结果。公开回执只保存该 UUID 的 SHA-256，实际手机号、UUID、OTP 和 token 不写入本清单。不存在创建新生产测试账号或获取其他用户会话的步骤。

## 执行范围

1. 再次核对生产 7 个消费者的 UID 和完整 spec 哈希、实际演示账号状态、现有 Work 0007 和候选 digest。完整工作负载快照保存在服务器 root-only 目录；保留上一轮数据库备份。本批无模型/迁移变化，不执行数据库迁移 Job。
2. 对 5 个 Deployment、2 个 CronJob 顺序更新候选镜像，全部四个新开关保持 False，准入模式 closed、名单空。逐项使用当前 resourceVersion 和完整 spec 检查；等待正常调度窗口，不改资源申请、不重启 K3s、不绕过调度器。验证双 API 心跳、Celery、实际 imageID 和关闭能力后再继续。
3. 将名单限制到已核验的唯一演示账号 UUID，模式 allowlist。仅 WORK_LOCAL_AGENT_ENABLED 和 WORK_REMOTE_AGENT_ENABLED 设为 True；WORK_AGENT_ENABLED 与 WORK_REVIEW_ENABLED 保持 False。只调整 Agent 专属预算 WORK_AGENT_MAX_CALLS=5、WORK_AGENT_TOKEN_BUDGET=20000，不改普通 communication 的模型、每日预算或输出设置。私有准入配置写入服务器 values.work-cohort.yaml，包含账号 UUID，不包含模型密钥。
4. 只执行 1 条合成材料任务，手机派发、桌面审阅后领取，目录限本机新建的本轮临时文件夹。每次命令和文件修改仍通过现有审批；原始输入不得修改，只有明确选中的成果主动同步。DeepSeek 最多 5 次调用、总预算 20000 tokens，单次输出沿用服务器上限且不超过 4096。不得在额度用尽后自动重试新任务，不调用 Pi/Qwen 或云端执行 Gateway，不使用真实业务文件。
5. 验证状态、成果 SHA-256、取消、撤销名单后的拒绝和本机停止。关闭本轮 local/remote 入口并将准入恢复 closed，其他账号全程不可提交新 Agent 任务。保存不含凭据的回执，关闭测试会话，保留服务器回退快照。任何开放验收失败先关闭入口，再按原快照回退镜像；不回退 Work 0007，不使用旧 Helm rollback。

不改变独立 Gateway 的 image/UID、PVC、TLS、Secret、Ingress、节点 PID 配置或其他业务模块。生产 Helm 当前历史与现场镜像配置已有差异，本批仍采用有范围的顺序更新；私有配置用于后续受审发布，不声称已完成 Helm 历史对齐。实际更新前源码与操作清单的 CI 必须成功。

## 验收边界

已有真实 OTP 验证是 HTTP 认证入口验证，现有两端联合验收使用过隔离身份；本轮受控任务尚未执行。Android/Electron 的真人原生登录、目录选择 UX、干净 Windows VM、正式 Authenticode 和正式更新信任根仍不在本候选的已通过声明内。当前没有 Windows 代码签名证书，候选客户端只用于已说明的内部验收。
