# dsh + Pi 生产验证及架构走查执行范围

用户于 2026-10-08 要求依次完成双 Agent 生产部署/功能验证、架构审视修复、代码走查修复，并明确在该范围内自主执行，无需再次征询授权。本清单承接这一新授权；先前单条任务授权及临时关闭清单保留为历史记录。

主执行器仍为桌面独立运行环境 0.3.2 / dsh 0.1.5rc1，业务不引入上游 SDK。服务端 Pi 1.0.4 / 百炼 `qwen3.8-flash` 只复核明确同步和选择的成果，不执行本机命令或修改原任务。Android 使用生产接口派发桌面任务，并查看原成果和复核报告。

本轮原 7 个 UID/spec 再次核验一致，使用新 root-only 快照 `cohort-e92f9eec4-retest-032`。候选业务镜像仍为 `sha256:e80b10e82eebea449076901453cf0669838fbd33aaae5afd176f6ab44b948e61`；已在全部入口关闭时顺序更新，验证健康后仅向原演示账号开启 local/remote。dsh 本轮真实任务已成功：3 次调用、5234 tokens、2 次逐项命令审批、显式同步与 Android 预览通过；没有修改原始输入。

接下来补齐 Pi 的业务端连接配置：现有 `meet-work-review-client/WORK_AGENT_TOKEN`、`meet-work-review-client-ca/ca.crt` Secret 引用，私有 HTTPS 地址与固定模型，复核上限 1 次调用/20000 tokens。先在业务 Pod 内验证 TLS、鉴权及契约，再按完整 spec/UID/resourceVersion 围栏顺序接入 5 个 Deployment 和 2 个 CronJob。独立 Gateway、供应商凭据和数据库 schema 不改变。

真实复核使用 dsh 同一条成功任务中已经显式同步的 `report.md`，在桌面界面再次选择文件并给予发送授权后才启动。每个尝试在点击前保存回执，响应不确定仅查询原记录，不自动创建第二次收费复核。核验 Pi 用量、报告结构和来源证据、原成果哈希不变，并使用专用 Android fixture 读取报告与原文件。必要修复与补验保留失败证据，单个 dsh 任务仍最多 5 次调用/20000 tokens，单个 Pi 复核最多 1 次调用/20000 tokens。

首次复核采用 8000 tokens，Gateway 在供应商请求前返回 `budget_exceeded`；数据库确认 `model_calls=0`。生产 Gateway 尚未包含较新本地运行时的自适应输出预占，完整 Pi 请求的字节预占超过该配置。入口已关闭并验证七个工作负载健康。将独立复核预算修正为 20000，不降低输入预占、不重跑成功 dsh 任务；新尝试保留原失败记录，并再次通过界面选择及授权。

联调结束先临时关闭全部入口，验证关闭后的派发/重领拒绝，登出并清理本次 profile、工作区、fixture 包和 ADB reverse。成功后可恢复已验证的**单演示账号灰度**：local/remote/review 开启，云端通用 Agent 保持关闭，其他账号不获准入。失败则优先关闭、取消本次活动执行，再依快照恢复镜像；不回退 schema，不通用 Helm rollback。私有 `values.work-dual.yaml` 保存完整 Agent 配置与 Secret 引用，不含模型密钥；后续发布必须显式携带并检查。

随后按顺序审视业务/执行器契约、任务所有权与租约、计量/未知状态、身份/密钥边界、桌面审批、发布/回退与 Helm 现场差异；再走查相应代码，修复有证据的问题并完成离线回归。正式签名、干净 Windows VM 和真实用户材料的规模质量评估继续单独记录，不计作本轮合成样本的已通过结果。

执行结果见 [生产记录](work-dual-agent-production-release-2026-10-08.md)、[架构整改](work-agent-architecture-review-2026-10-08.md) 和 [代码走查](work-agent-code-review-2026-10-08.md)。上文是初始范围与过程中预算修正的记录；随后发现结构化引用、诊断及材料不足时的结论问题，已按本轮自主修复授权独立升级 Gateway 至 0.3.5，保留各版数据库备份与 spec。业务数据库 schema 和供应商凭据始终未改。
