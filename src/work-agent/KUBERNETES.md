# K3s 任务执行

用户选定沿用现有单节点 K3s。新增 `--execution kubernetes` 和独立 chart `src/helm/work-agent-k8s`，业务仍通过 `work-agent/v1` 提交、查询、取消；dsh/Pi SDK 不进入业务镜像。桌面本地工作空间继续使用 `work-local/v1`，不受此执行器影响。

Gateway 使用独立 namespace 和持久 PVC。每个任务创建一个固定镜像的 Pod：非 root、只读根目录、临时工作目录、无宿主机挂载、无 Docker socket、无 ServiceAccount token。任务通过验证私有 CA 的 HTTPS 一次性领取材料，再通过 ModelBroker 调用模型并回传成果。供应商 key 只在 Gateway；任务 namespace 只放公共 CA 和必要的镜像拉取凭据。

创建只发一次 POST；应答丢失后按原 UUID、Pod UID 和启动凭据摘要确认已有 Pod，绝不换 UUID 再执行。Pod `restartPolicy: Never`，不使用 Job 重试控制器。取消、超时、关闭及重启先撤销任务与模型凭据，再按 UID 删除所属 Pod；未知任务不自动重放。节点失联时 Pod 还有独立 deadline，无法撤销已经发往供应商的请求，用量仍按未知预留处理。

## 独立部署准备

复制 `src/helm/env.d/aliyun-prod/values.work-review-k8s.yaml.dist` 到 Git 忽略的本地候选文件，保持 Gateway 和业务开关关闭。先准备可审查候选，再执行生产发布：

1. 构建 `kubernetes-gateway` 和 `pi`/`dsh` Docker target，发布到集群可访问的 registry，使用完整 `repository@sha256`。Gateway target 不包含 Docker CLI。
2. 使用三个独立 namespace：业务 `meet`、Gateway `meet-work-review`、任务 `meet-work-review-tasks`。Gateway 不授予集群级权限，只有任务 namespace 中 Pod 的 create/get/list/delete。任务 namespace 必须保持 Pod Security restricted；不得放业务或供应商 Secret。
3. 在 Gateway namespace 预先准备 TLS Secret（含 `tls.crt/tls.key/ca.crt`）、Gateway token Secret、供应商 Secret。Qwen 复用现有百炼账号，只复制必要的 `DASHSCOPE_API_KEY` 到受限 Secret，不能把整个业务 Secret 或 `values.secrets.yaml` 传入 agent Helm release。证书 SAN 必须包含 Gateway Service 全名。
4. 在业务 namespace 只准备同一 Gateway token 和公共 CA 的两个客户端 Secret，使用 `tls.clientCASecret` 引用 CA。业务不持有 Gateway 私钥或供应商 key。
5. 指定已备份的独立 PVC；首次创建空状态必须显式设置 `newStateAcknowledged: true`。PVC 默认保留，不通过卸载删除历史。填写真实 API server IPv4 `/32` 与端口，验证 CNI 的实际 NetworkPolicy 执行；Helm 渲染不能证明网络隔离。
6. Gateway 默认 requests 100m/128Mi、limits 1CPU/512Mi；每任务 requests 100m/128Mi、limits 1CPU/1Gi。任务配额最多 2 个 Pod，单 Gateway worker 串行执行，预留一个清理/检查槽位。上线前检查现有 requests、实际负载、磁盘和备份，不能据此宣称单节点具有强资源隔离。

`check-work-agent.py` 根据 `runtime.execution` 选择 chart，并对 API server `/32`、固定镜像和跨 namespace 客户端引用做离线检查。`preflight-work-k3s.py --context EXPLICIT_CONTEXT` 只读检查共用节点、三个 namespace、CPU requests 余量与不大于 512 的 Pod PID 上限；未知或无限上限拒绝放行。节点修改与回退见 [PID 变更候选](../../deploy/aliyun/WORK_K3S_PID_CHANGE.md)。旧 `preflight-work-review.py` 的专用 Docker 节点验收仍用于旧 chart；K3s 候选不使用该节点结论。

独立 Gateway 验收通过后再开启业务 `WORK_REVIEW_ENABLED`。回退先关闭业务开关、取消/清理任务、确认没有活动 Pod，再回退 Gateway/worker 镜像及配置。镜像变更会使旧排队任务返回 `deployment_changed`，不会静默重放。不要直接跨版本回滚 SQLite 状态；备份与旧版本兼容性必须另行验证。

## 本地真实集群验收

仓库提供可重复的本机 Docker Desktop/WSL2 隔离 K3s 夹具，使用固定 K3s `v1.36.2+k3s1` 镜像及候选 kubelet PID 配置。它仅在专属 bridge、volume、registry 中运行，不读取现有 kubeconfig，不操作已有集群。临时控制面为 privileged 容器，生产 task Pod 无此权限。

从仓库根目录执行，`python` 使用带 PyYAML/cryptography 的测试环境；先构建三个 target 并通过 `docker image inspect` 取得完整源 digest。夹具的 registry 仅映射 Windows loopback；保存并重打包镜像 manifest 后重新固定 digest，核对 RootFS diff IDs，不能把该内部地址当作生产 registry。

```powershell
python deploy/aliyun/work-k3s-fixture.py setup `
  --state-directory .work-acceptance/k3s-check `
  --gateway-image 'GATEWAY_REPOSITORY@sha256:FULL_DIGEST' `
  --worker-image 'pi=PI_REPOSITORY@sha256:FULL_DIGEST' `
  --worker-image 'dsh=DSH_REPOSITORY@sha256:FULL_DIGEST'
$env:WORK_K3S_FIXTURE_STATE=(Resolve-Path .work-acceptance/k3s-check/state.json).Path
python -m unittest discover -s deploy/aliyun -p test_work_kubernetes_live.py -v
python deploy/aliyun/work-k3s-fixture.py cleanup --state-directory .work-acceptance/k3s-check
```

真实测试覆盖 HTTPS 材料/成果交付、取消、超时、Gateway 重启、UID 清理、RBAC、无任务 API token、实际网络阻断，并在传入 worker 镜像时覆盖真实 Pi/dsh SDK 到 ModelBroker 的 TLS 链路。模型响应使用本地 SSE fixture，不读取真实供应商 key，不调用付费模型。回执保存在 Git 忽略目录，仅包含公开验收摘要。

正常离线回归：`python -m unittest discover -s src/work-agent/tests`（需设置对应 PYTHONPATH）以及 `python -m unittest discover -s deploy/aliyun -p test_work_kubernetes_delivery.py`。未显式提供隔离夹具时，真实集群测试跳过；跳过不能当作验收成功。
