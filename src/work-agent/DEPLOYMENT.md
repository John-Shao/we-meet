# 独立 Work agent 生产配置

2026-10-07 增加独立 chart `src/helm/work-agent`，release 名建议 `work-agent`。它不是 `meet` 子 chart；业务发布脚本不升级它。Gateway 镜像使用 Dockerfile 的 `gateway` target，只含自有 HTTP/SQLite/ModelBroker 代码和 Docker CLI，不安装 dsh/Pi。每任务执行镜像分别使用 `dsh` / `pi` target，仍通过 `work-agent/v1` 与业务系统通信。

本次只在本机准备配置、渲染模板和离线验证，未连接生产集群、发布镜像或启用任务。默认 `workAgent.enabled=false`、`WORK_AGENT_ENABLED=False`，本次没有调整桌面和 Android 开关。

## 密钥与发布范围

`src/helm/env.d/aliyun-prod/values.secrets.yaml` 已被 Git 忽略，可作为现阶段的运维输入。在新 `workAgent.secrets` 下填写：

- `gatewayToken`：独立随机鉴权 token，至少 24 字符；准备脚本生成一次，重复运行保留原值。
- `deepseekApiKey`：生产专用 DeepSeek key。脚本保留 `REPLACE_PRODUCTION_DEEPSEEK_API_KEY` 占位，不复制 `src/work-agent/.env` 的 PoC key。
- `create=true` 时，agent chart 创建两个 Secret：`meet-work-agent-gateway` 含模型 key 与鉴权 token；`meet-work-agent-client` 只含同一个鉴权 token。

Gateway Pod 只引用 gateway Secret 的两个键；后端、Work Celery 与 Beat 通过 `secretKeyRef` 引用 client token。桌面继续从本机配置读取模型 key，Android 不配置模型凭据。

不能直接将整份生产 secrets 文件传给独立 agent release：Helm 会保留输入的 values，即使模板没有使用它们。`check-work-agent.py --export-values` 只导出 `workAgent` 子树；常规 `release-meet.sh` 始终先导出删除该子树的业务 secrets，存在 agent profile 时再加入过滤后的业务 overlay。这样两个 release 的 values 也按职责分开。业务导出不校验未启用客户端的 agent 节点/镜像准备情况，避免其阻塞常规业务升级；开启客户端时仍校验 endpoint、token/CA 引用与非 optional 要求。导出文件只有运维身份可读，在仓库内必须是 Git 忽略且未跟踪的路径；切勿把 `helm template` / `helm get values` 的机密结果写入公开日志。

准备配置（运维 Python 环境需要 PyYAML；Linux 写入/导出使用 0600，Windows 应将配置目录 ACL 限制到运维身份）：

```powershell
src/backend/.venv/Scripts/python.exe deploy/aliyun/prepare-work-agent.py --namespace meet
src/backend/.venv/Scripts/python.exe deploy/aliyun/check-work-agent.py --namespace meet
```

脚本将新 profile 写到 Git 忽略的 `values.work-agent.yaml`，保留已有业务 secrets 字段及文件内容，只修改新的 `workAgent` 子树。它不会覆盖已有 profile，不启用开关，也不访问集群。校验器只输出资源数量或通用错误，不输出 YAML 解析诊断、密钥或渲染内容。默认关闭时成功渲染 0 个资源，不表示生产运行条件已齐备。

## 运行节点与 HTTPS

当前 Gateway 通过 Docker CLI 创建隔离任务容器，K3s 的 containerd socket 不适配。此 chart 明确支持一个**独立 Docker runner 节点**，并固定 `kubernetes.io/hostname` 与 `work-agent=dedicated` 标签，默认不创建部署。该节点不得运行业务服务；在确认独占用途后才能设 `runtime.dedicatedNodeAcknowledged=true`。建议给节点加 `work-agent=dedicated:NoSchedule` 污点，并确保其他业务工作负载不容忍它。

Gateway 有 Docker socket 权限，因此拥有该 runner 的主机级执行能力；Pod 的只读根目录、capabilities 限制不能消除这种权限。chart 不创建 Docker daemon，不挂载 K3s socket；也不承诺 OS 级多租户隔离。每任务容器仍只挂载当前任务目录，不获得 Docker socket、TLS 私钥、供应商真实 key 或业务数据库凭据。

先在专用节点准备 `/var/lib/we-meet-work-agent` 持久目录，并预拉取并验证执行镜像。Gateway 与节点 Docker 必须使用**同一个绝对状态路径**，否则 Docker bind mount 读取不到请求；不能用容器内私有目录代替它。目录以 `hostPath.type=Directory` 挂载，不自动创建新的空 Inbox。单副本 + `Recreate` 避免同时写 SQLite，迁移节点前先停止服务、备份整个目录，再手工迁移；不会自动漂移到另一节点重放未知付费任务。

`hostNetwork=true` 保留现有 Docker worker → `host.docker.internal` → ModelBroker 的路由。8443 只允许业务节点/Pod 网段和运维入口访问，随机 ModelBroker 端口只向本机 Docker 任务网络放行，其他入站由 runner 防火墙拦截；hostNetwork 场景不能假设普通 Pod NetworkPolicy 已覆盖主机流量。正式开放敏感材料前还需落实节点出站控制；本轮未验证生产网络隔离。

准备命名空间内的 TLS Secret `meet-work-agent-tls`，包含 `tls.crt`、`tls.key`、`ca.crt`。使用受控 CA 签发服务器证书，SAN 必须包含 `meet-work-agent.meet.svc.cluster.local`（namespace/fullname 变化时同步调整）。私钥只挂载 Gateway；业务环境引用 `ca.crt` 作为 `WORK_AGENT_CA_PEM`，在默认系统信任基础上增加此 CA，仍验证证书链和服务名。Job API 直接连接私有 Gateway，不继承机器 HTTP(S) 代理；没有关闭证书验证。HTTP 只允许本机 PoC 的 loopback 地址，远程监听必须配置 TLS。

Readiness 使用真实 HTTPS、CA、服务名和 token 调用 capabilities，直接连接 loopback 避免 Service 无 ready endpoints 的启动循环。首次启动探针有 120 秒窗口；运行后的暂时不就绪只移出流量，不用 liveness 强制重启付费调用。SIGTERM 进入清理流程，未知执行不自动重放。

## 镜像和发布顺序

```bash
docker build --target gateway -t <gateway-repository>:<immutable-commit> src/work-agent
docker build --target dsh -t <worker-repository>:<immutable-commit> src/work-agent
# 由现有发布流程推送、验证，并在专用 Docker 节点预拉取 worker 镜像。
```

在 profile 填入 Gateway repository + `sha256:` digest、执行镜像 `repo@sha256:` digest、专用节点名和 TLS Secret。启用时 chart 拒绝缺失的隔离确认、节点、镜像 digest、证书引用或生产密钥占位；不会回退到 `latest`。Gateway 启动时仍校验节点上的执行镜像并冻结为 image ID。

发布顺序为：

1. 在忽略的 secrets 文件填写生产专用 key；配置节点、证书及镜像。设置 `workAgent.enabled=true`，业务 `WORK_AGENT_ENABLED` 仍保持 False。
2. 在受限临时目录导出 agent 专属 values，再手工部署独立 release：

   ```bash
   render_dir=$(mktemp -d)
   python3 deploy/aliyun/check-work-agent.py --export-values "$render_dir/agent.local.yaml"
   helm upgrade --install work-agent src/helm/work-agent -n meet \
     -f "$render_dir/agent.local.yaml" --wait --timeout 5m
   rm -f -- "$render_dir/agent.local.yaml"
   rmdir -- "$render_dir"
   ```

3. 验证私有 HTTPS、鉴权、Inbox 持久目录、Docker 镜像及合成材料任务。当前本机验证不能替代这项专用节点验收。
4. 确认现有 `values.work.yaml` 已启用 Work、材料、Work worker 和 Beat；将 agent profile 的 `WORK_AGENT_ENABLED` 改成 True，token 与 CA 的 `secretKeyRef.optional` 都改成 false。运行校验器后通过常规 backend 发布接入；`release-meet.sh` 自动加入过滤后的 profile，继续使用原业务镜像配置。它不会升级 agent release。

若只升级 dsh、Pi 或 Gateway：先在业务入口暂停新任务受理并等待现有队列清空，保持现有执行/轮询开关可用，再备份状态和替换对应 digest；不要把关闭 `WORK_AGENT_ENABLED` 当作排空，它会使现有运行被终结/取消。恢复后先验收 capabilities 与合成任务。回退使用先前验证的 chart/镜像、保留原状态目录；不可删除 Inbox 或创建新 UUID 自动重试未知执行。

Secret 是环境变量注入，TLS 证书也在启动时加载，轮换不会自动热生效。排空后更新相应 Secret，增加 `workAgent.credentialsRevision` 触发 Gateway 重建，并重新发布/滚动后端、Work worker 和 Beat 以加载 client token/CA；token 必须在双方同步。外部 Secret 模式也使用相同流程。

## 后续外部密钥管理

平台具备外部密钥服务与同步 operator 后，将 `workAgent.secrets.create=false`，移除/清空两个 literal 字段，只保留两个已有 Secret 名称。外部同步需创建相同的 gateway/client Secret，并保持 token 相同；chart 不创建或接管这些 Secret，也不会安装 operator。CA/TLS 同样由独立证书流程管理。本轮只提供该接入模式和模板测试，未配置具体云密钥服务。

Kubernetes Secret 的 base64 不等于加密，生产还应配置 etcd 静态加密和最小权限。参考 [Kubernetes Secret 文档](https://kubernetes.io/docs/concepts/configuration/secret/) 与 [Docker daemon 文档](https://docs.docker.com/reference/cli/dockerd/)。

## 本机验证入口

```powershell
src/backend/.venv/Scripts/python.exe -m unittest discover -s deploy/aliyun -p test_work_agent_delivery.py -v
# 已构建 gateway 镜像时可额外执行真实容器的 HTTPS/CLI/只读根/SIGTERM 验证：
$env:WORK_AGENT_GATEWAY_TEST_IMAGE='we-meet-work-agent-gateway:helm-integration'
src/backend/.venv/Scripts/python.exe -m unittest discover -s deploy/aliyun -p test_work_agent_delivery.py -v
```

测试使用抛弃式 CA、合成凭据和 fixture driver，无真实供应商调用、业务数据库迁移或集群变更。
