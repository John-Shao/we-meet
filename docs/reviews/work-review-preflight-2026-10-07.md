# Pi reviewer 部署预检

本批增加 [只读预检](../../deploy/aliyun/preflight-work-review.py) 与 8 项回归，具体运行方式见 [部署说明](../../src/work-agent/DEPLOYMENT.md)。工具把离线 Helm 校验扩展到指定 context/namespace 中的实际节点、工作负载、Secret 和 TLS 前置检查，没有自动部署、切换 context 或启用开关。

预检校验 Ready/调度状态、专用标签与污点、活动业务 Pod、声明的 TCP 主机端口及状态目录冲突；gateway/client token 匹配与 Secret 范围；模型 Secret 的键和格式；真实 TLS 证书链、SAN、有效期及私钥匹配。它只调用 `kubectl get`，错误与报告不输出响应正文、token、模型 key、TLS 私钥或 YAML 解析诊断。TLS 临时文件用后删除。

## 验证

- 新增 8 项回归通过：实际内存 TLS 握手，错误 CA、错误 SAN、过期证书、私钥不匹配、加密私钥、仅 CN 的证书均拒绝；Secret 范围、缺键/不匹配、节点隔离及端口/目录冲突、context/namespace 强制绑定、私密报告路径和诊断脱敏通过。
- 既有部署边界 19 项通过，1 项 Gateway image opt-in 跳过；包含独立 release、已有百炼 Secret 复用、业务与 agent values 隔离、外部 Secret、真实 HTTPS 与鉴权边界。
- 变更 Ruff 检查与格式检查通过。没有供应商调用或集群变更。
- 对当前关闭的 `values.work-review.yaml.dist` 执行 CLI，返回失败码 `reviewer_profile_required` 并保存报告；配置不满足时未进入 kubectl 查询。
- 用真实只读 `kubectl get` 检查现有 `kind-suite/meet`：namespace Active，唯一 `suite-control-plane` 节点 Ready；没有 `work-agent=dedicated` 标签或同名 NoSchedule 污点，可用专用节点数 **0**。本次实际库存只读取 namespace/nodes，没有读取现有 Secret。

本机库存与关闭配置拒绝回执在 gitignored `.work-acceptance/work-review-preflight-20261007/`。集群 Secret/TLS 的正向及故障测试采用合成 Kubernetes 库存，TLS 验证实际执行；没有宣称已完成目标集群全量预检。

## 待执行边界

工具通过只表示当时 Kubernetes 前置资源符合候选配置。Docker daemon、节点同路径持久目录/备份、固定 worker 镜像预拉取、registry 可拉取性和模型账号可用性未由该工具验证；部署后仍需 HTTPS health 与合成任务验收。报告明确保留这些 `not_checked` 项。

实际部署仍需用户提供目标 context/namespace、专用 Docker 节点、镜像仓库和 TLS Secret；现有本机业务 context 没有被当成已授权测试 runner。生产 reviewer 开关、既有密钥和 release 均未修改。
