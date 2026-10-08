# Work/Pi Broker 连接池生产发布（2026-10-08）

独立 Gateway 和 Pi worker 已更新至适配器 **0.3.6**。上游 Pi 保持 **1.0.4**，模型保持 `qwen3.8-flash`。业务镜像、数据库 schema、TLS/CA、Secret、PVC 和账号灰度范围保持原配置；此次不更新已分发的桌面内置 0.3.2 运行环境或 Android APK。

发布源为干净提交 `e46fe710f6b8c6ac779597b67e9eb1273bdcd619`，其 [CI 37724601844](https://github.com/John-Shao/we-meet/actions/runs/37724601844) 四项检查全部通过。原候选 CI 缺少新增 httpx 依赖，部署测试失败，未绕过护栏；修正为安装哈希锁定 HTTP 依赖后才发布。

| 部署组件 | 不可变镜像 |
| --- | --- |
| Gateway | `jusi-cn-guangzhou.cr.volces.com/we-meet/work-agent-gateway@sha256:3d97bb6cdda064fdf1c3c0a9ee622e36da57762827f52469dd76ac0c2ea97295` |
| Pi worker | `jusi-cn-guangzhou.cr.volces.com/we-meet/work-agent-pi@sha256:ba1d14128961b2d7e7eaa2c4d72adb4623f5ef8e0dfc9afa787152840eac3911` |

每个 Broker 独立持有 httpx 0.28.1 Client，默认总连接 16、空闲连接 8、空闲保留 60 秒；池等待最多 2 秒且不超过本次请求超时。凭证逐请求注入，拒绝 Cookie，不自动重试收费 POST 或跟随重定向；任务鉴权、预算预占及用量记账继续独立执行。JSON/SSE 保持有界读取，审批前释放上游响应，退出时停止新借用并在既有响应释放后关闭池。

发布前关闭七个业务消费者的 Work 入口，并保存操作员关闭配置。活动任务和任务 Pod 均为 0，原 Inbox 有 10 条记录。在 PVC 上保留只读 SQLite 备份，`quick_check=ok`，SHA-256 `82171d3239a89bca7d1b7256312dfcc2ca9d27a5e83506cdae32ef1f199c3471`。Gateway 使用 UID、resourceVersion 和完整 spec 的条件补丁更新镜像及 worker 引用；原部署快照和带相同约束的回退脚本保留在生产维护目录。

| 验证 | 结果 |
| --- | --- |
| Work 单元及生命周期回归 | Windows 104 项：99 通过、5 项需显式启用的测试跳过；发布 CI 的部署回归通过 |
| 发布镜像验证 | 新 Gateway 的 13 项真实 HTTP 池测试通过；实际 Pi 镜像的 RPC、合成 SSE、报告及用量测试通过，无供应商调用 |
| 真实生产调用 1 | 复核成功，输入 814 / 输出 51 tokens；用量记账完整，报告为预期 `inconclusive` |
| 真实生产调用 2 | 复核成功，输入 814 / 输出 38 tokens；用量记账完整，报告为预期 `inconclusive` |
| 实际连接复用 | Gateway 主进程已建立的 HTTPS socket 数从 0 到 1，再到 1；两次调用后保留同一 socket inode |

首次验证任务使用 30 秒启动时限，在进入模型调用前超时，供应商调用和用量均为 0；失败记录保留。之后为新验证任务使用 120 秒启动时限，每个任务仍只允许调用一次模型，总计两次收费调用、1717 tokens，没有自动重放收费请求。

最终恢复原有单演示账号灰度：local/remote/review 开启，通用云端 Agent 关闭，其他账号拒绝。七个消费者配置核验、业务及 AI 健康接口、Celery 心跳、Gateway readiness 和运行源码哈希通过；10 条历史 Inbox 记录的逐行哈希保持一致，新增三条验证记录完整保留，活动任务及剩余任务 Pod 均为 0。最终验收见[机器回执](work-broker-pool-production-2026-10-08.json)。

这两次真实调用验证发布链路、记账和连接复用，不构成高并发容量或真实材料质量承诺。后续更新继续先关闭入口、排空任务、备份 Inbox，验证新镜像后再恢复灰度；发生故障时按保留的完整 spec 回退镜像，不自动重放未知收费调用，也不覆盖现有 Inbox。
