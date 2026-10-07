# K3s 生产预检与 PID 候选验收

此报告保留变更前只读基线。随后用户授权 PID 变更和 K3s 重启，实际执行、回退及最终结果见 [生产维护回执](work-k3s-pid-maintenance-2026-10-07.md)。

K3s 执行器已提交推送 `c1a6a4994`，随后继续本批生产准备。通过交互 SSH/sudo 在生产直接以内存代码执行 [只读预检](../../deploy/aliyun/preflight-work-k3s.py)，只调用 Kubernetes get，未复制脚本到生产、未读取 Secret 数据、未部署或修改节点。预检和其他只读快照的公开结果见 [生产回执](work-k3s-production-preflight-2026-10-07.json)。

本次 CPU requests 保守合计 3,550m，新增 Gateway 和单个任务请求共 200m，基础余量检查通过；10 个容器未声明 CPU requests，不能据此保证实际容量。节点 Ready，但 Gateway/任务 namespace 尚未创建，restricted 标签也未配置。真实 kubelet `podPidsLimit=-1`，因此预检拒绝放行。即使基础项通过，报告仍保持 `deployment_ready:false`，需要完成镜像、TLS、状态备份、实际 CNI 探测和合成任务验收。

已准备 [每 Pod 512 PID 的实际配置](../../deploy/aliyun/kubelet-work-pids.conf) 和 [生产变更/回退步骤](../../deploy/aliyun/WORK_K3S_PID_CHANGE.md)。生产一次 Pod cgroup 进程数快照最大值 147，ExecStart 未发现显式 `pod-max-pids` 参数；这不能替代峰值评估或授权。设置会作用于现有业务 Pod，且需要重启 K3s，生产执行需确定维护时间并单独批准。

在全新隔离 K3s 中，将同一候选文件挂载到建议的 kubelet drop-in 路径。configz 返回 512，真实任务 Pod 的 cgroup `pids.max` 也为 512；测试兼容 cgroupfs 的 UUID 路径和 systemd 的转义路径。完整任务交付、取消、deadline、Gateway 重启、RBAC、实际 NetworkPolicy 阻断、Pi/dsh SDK 的 TLS/模拟记账均通过，供应商调用数 0。真实集群测试 1 项通过，预检回归 5 项通过，Ruff 与 diff 检查通过；[候选验收回执](work-k3s-pids-2026-10-07.json) 包含文件 SHA-256。

所属临时集群、registry、volume、bridge 与夹具镜像别名已清理，资源 label 查询为空。生产 Gateway 和业务开关未开启，生产配置未写入；下一步待批准节点 PID 变更，再继续独立 Gateway 发布准备。
