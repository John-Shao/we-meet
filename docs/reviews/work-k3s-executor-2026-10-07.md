# Work K3s 执行器验收

按用户选择，新增现有 K3s 主机上的任务 Pod 执行路径，不再依赖专用 Docker runner。业务仍使用 `work-agent/v1`；桌面本地工作空间及旧 Docker 路径保留。新增独立 chart、禁用状态的生产 profile、运行与回退说明，见 [K3s 交付说明](../../src/work-agent/KUBERNETES.md)。本批未发布或修改生产资源。

## 真实本地验收

在本机 WSL2/Docker Desktop 创建固定 K3s `v1.36.2+k3s1` 的专属临时集群，未使用现有 kubectl context。使用实际 Helm 渲染部署 Gateway/PVC、任务 RBAC、restricted Pod Security、ResourceQuota 和 NetworkPolicy；任务无宿主机目录、Docker socket、供应商 key 或 API token。

实际通过：

- 一次性 HTTPS 材料领取、独立 Pod 执行、成果回传与 SHA-256 校验。
- 取消、deadline、Gateway 重启后未知任务清理，任务不自动重放。
- Gateway 可创建任务 namespace 的 Pod，不能创建业务 Pod或读取 Secret；任务账号无 Secret 权限。
- 任务可验证私有 CA 并访问 Broker，未授权调用返回 401；不能连接业务 Pod、Gateway 业务端口及内部 registry。业务侧先确认目标可连接，排除 DNS/目标不可用造成的假通过。
- 真实 Pi `1.0.4`、dsh SDK/runtime `0.1.5rc1` 通过 K3s Pod 中的 TLS ModelBroker 完成任务。Pi 使用 Qwen `qwen3.8-flash` 配置；dsh 使用 DeepSeek 配置。各观察到 1 次模拟模型调用、100 输入/30 输出 tokens，成果和记账成功。供应商模型调用数 **0**。

镜像使用固定源 digest，经仅本机 loopback 的夹具 registry 交付，核对 RootFS diff IDs 后重新固定 manifest digest。源及夹具 digest、任务 UUID、模拟用量和测试结果保存在 [公开回执](work-k3s-executor-2026-10-07.json)。临时集群、registry、数据卷、网络和当前夹具标签已清理，所有所属资源 label 查询为空。

Gateway/agent 全套离线测试 78 项：73 通过、5 项按显式 opt-in 跳过；补充凭据 lease 回归后 Kubernetes 10 项全部通过。旧部署测试 20 项：19 通过、1 项镜像 opt-in 跳过；新 chart 5 项全部通过；真实 K3s 验收 1 项通过。Ruff、Helm lint 和 diff 检查通过。真实验收使用 [可重复脚本](../../deploy/aliyun/work-k3s-fixture.py) 和 [测试](../../deploy/aliyun/test_work_kubernetes_live.py)。

## 生产只读结果与剩余工作

当前生产为单节点 K3s，4CPU、16,373,008 KiB 可分配内存；常规容器 CPU requests 快照合计约 3,600m，不含 init/Pod overhead。一次实际负载快照为 CPU 1,252m（31%）、内存 7,172Mi（44%）。发现 99 条包含 NetworkPolicy chain 标识的 iptables 记录，这只能确认规则存在，不能代替生产网络探测。

Gateway 与单个 worker 各请求 100m CPU；仍需验证持续负载、磁盘、实际调度余量和节点 PID 上限。Pod CPU/内存/临时存储已有上限，PID 上限需要 kubelet 配置，不能把当前 K3s 隔离能力等同于原 Docker 的 `--pids-limit=128`。未确认生产 TLS/供应商 Secret、registry 交付、状态备份或生产 CNI 的实际阻断，因此生产 profile 和业务开关保持关闭。下一批先补 K3s 专用生产预检和可审查发布候选，再处理实际部署。
