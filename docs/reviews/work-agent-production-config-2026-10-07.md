# Work agent 生产配置准备与本机验收

日期：2026-10-07（Asia/Shanghai）。本轮完成本机配置与交付代码验证，未连接生产集群、发布镜像或启用真实生产任务。

## 已完成

- 在 Git 忽略的 `src/helm/env.d/aliyun-prod/values.secrets.yaml` 增加独立 `workAgent.secrets` 子树，生成随机鉴权 token；业务原有 secrets 保留。生产模型 key 为 `REPLACE_PRODUCTION_DEEPSEEK_API_KEY`，没有复制本地 PoC key。
- 准备 Git 忽略的 `values.work-agent.yaml`；Gateway 和业务 agent 执行开关均关闭，节点、镜像等待正式配置。
- 增加独立 chart `src/helm/work-agent` 和 Gateway Docker target。只支持明确确认的专用 Docker 节点、固定 hostname、同路径持久 Inbox、单副本 Recreate、digest 镜像与 HTTPS。
- agent Secret 含模型 key 和服务鉴权 token；client Secret 仅含 token。Job API 支持受控 CA 且保留证书链/服务名校验，不走机器 HTTP(S) 代理。Docker 执行和 ModelBroker 仍使用原有 v1 契约。
- 发布前按 release 过滤 values：业务 release 排除 `workAgent` 凭据，agent release 排除 DB/OIDC/S3 等业务凭据。独立 agent 的未完成节点/镜像准备不会阻塞未启用客户端的业务升级。
- 提供已有 Secret 引用模式，供以后接外部密钥同步 operator；没有安装具体云密钥服务或证书系统。

## 验证结果

| 范围 | 结果 |
| --- | --- |
| 交付/配置/TLS 测试 | 16 个离线测试通过；容器测试单独 opt-in 通过，总计覆盖 17 个测试 |
| HTTPS 边界 | 真实 fixture 任务交付、CA/主机名/错误 token 拒绝、空闲 TLS 握手不阻塞、代理配置不改变私有连接、远程明文拒绝 |
| Gateway 镜像 | 本地成功构建；只读根 + 无 capabilities 下完成 HTTPS 合成任务、真实 readiness、Docker CLI 28.5.1；SIGTERM exit 0，未 OOM；测试容器已删除 |
| 现有 Work 部署 | 23 个测试通过 |
| 独立 adapter | 37 个通过、4 个明确 opt-in 跳过；没有本轮真实模型调用 |
| 后端任务对接 | 隔离 PostgreSQL 16：10 个通过、1 个真实模型 opt-in 跳过；临时数据库容器已停止并自动删除 |
| 静态检查 | 两个 chart Helm lint、相关 Ruff、release-meet Bash 语法和 git diff --check 通过 |
| 本地默认配置 | 校验器渲染 0 个资源，两个执行开关为 false；这只证明关闭状态，没有宣称生产运行条件已满足 |
| 密钥边界 | 生产 secrets/profile 与 PoC `.env` 均未跟踪且 Git 忽略；本轮 Git 可见改动未包含真实模型 key 或新生成的 token |

Gateway 镜像仅保存在本机：`we-meet-work-agent-gateway:helm-integration`。Dockerfile 的 Python 和 Docker CLI 基础镜像使用固定 digest；它是测试构建，没有发布到生产镜像仓库。

## 上线前仍需完成

1. 运维创建并填写生产专用 DeepSeek key。
2. 配置/验收专用 Docker runner 节点、固定 Inbox 目录、镜像预拉取及主机入站/出站控制。Docker socket 提供 runner 主机级权限，普通 Pod 限制不能消除该权限；hostNetwork 不依赖普通 Pod NetworkPolicy 保证隔离。
3. 提供包含 Service DNS SAN 的服务器证书、私钥及可信 CA Secret。本轮证书仅为测试生成的临时 CA，不能用于生产。
4. 在专用节点完成真实 Docker worker → ModelBroker 的合成材料验收，再明确启用 Gateway 与业务客户端。当前容器 smoke 使用 fixture driver，没有宣称完成 K3s 节点上真实 dsh 执行。

发布、轮换、排空与回退流程见 [部署说明](../../src/work-agent/DEPLOYMENT.md)。
