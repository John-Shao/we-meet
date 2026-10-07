# Work 业务版本对齐候选

独立 Pi/Qwen Gateway 已发布，见 [服务回执](work-k3s-gateway-release-2026-10-07.md)。随后对现有业务容器做了只读检查，结果见 [镜像盘点](work-k3s-business-alignment-candidate-2026-10-07.json)。本候选没有更新业务 Deployment、数据库或业务开关，没有调用模型、读取用户材料或创建测试账号。

生产业务 Deployment UID 为 `81e49171-7fe4-4cb1-b7ab-d969b02675d7`，实际镜像是 `jusi-cn-guangzhou.cr.volces.com/we-meet/meet-backend@sha256:05589638d0cee8c9fe6daa2424dbcf0408d3a183d7820c6c8367ce608d13d8d6`。`WORK_ENABLED=True`，agent 和 review 开关未设置。这个镜像有基础 Work 包，但没有 `review_runs.py`、`review_contract.py`、`agent_client.py`；只打包 `0001`、`0002` 迁移文件。因此当前服务回执证明独立 Gateway 可用，不能宣称业务接口已接通。

| 待对齐项 | 当前仓库 | 生产镜像 |
| --- | --- | --- |
| agent 客户端与持久任务状态 | `agent_client.py`，迁移 `0003` | 未包含客户端 |
| 本地成果与执行目标 | 迁移 `0004` | 未打包该迁移 |
| 设备、工作空间、远程派发 | 迁移 `0005` | 未打包该迁移 |
| 只读 Pi 审查 | `review_runs.py`、`review_contract.py`、迁移 `0006` | 未包含接口实现和该迁移 |

盘点仅列出镜像内迁移文件，未查询实际数据库的迁移应用历史。业务发布前必须确认数据库当前版本、备份与恢复路径；不得根据文件列表推断数据库状态，也不能单独复制 Python 文件进运行容器替代镜像发布。

下一批工作顺序：

1. 从当前仓库准备完整 backend 不可变镜像，记录构建 commit 与 registry digest；审查与现有业务版本的整体差异，不能把一次镜像替换描述为只有 Work 变化。
2. 在本地 WSL 验证当前生产 schema 到目标 `0006` 的迁移、旧 API 回归、桌面成果上报和 Pi 审查交付。明确向前迁移与镜像回退的兼容关系；必要时恢复数据库，而非盲目反向执行迁移。
3. 准备业务 release 候选，初始 agent/review 开关保持关闭；只引用已创建的 `meet-work-review-client` token 和 `meet-work-review-client-ca` 公共 CA。模型与 Gateway 地址固定，不允许移动端指定模型入口、本机路径或供应商 key。
4. 指定受控测试账号、仅使用合成材料、给出单批调用预算和服务端准入限制。当前全局开关本身不是账号灰度；确认准入实现前不得称为“仅测试账号可用”。保留桌面执行与服务端审查的独立 opt-in、文件 checksum 和所有权检查。
5. 镜像、迁移、配置和关闭步骤都可审查后，进行业务发布及受控联调；不重放未知任务，不把本轮剩余模型调用额度自动带入新批次。

生产本轮明确授权的是新增独立服务，部署时约定业务开关保持关闭。这里准备后续现有业务升级的证据和范围，尚未形成可直接执行的业务发布包；当前无需更改现有服务来完成独立 Gateway 发布。
