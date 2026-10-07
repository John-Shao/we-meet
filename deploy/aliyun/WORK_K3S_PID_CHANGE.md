# 共用 K3s 节点的 PID 上限候选

生产只读观测：kubelet `podPidsLimit=-1`；一次 Pod cgroup 进程数快照最大值 147，未在 K3s ExecStart 中发现显式 `pod-max-pids` 参数。该快照不能代表峰值，变更前仍需确认长任务/会议等场景的进程需求。

候选为 [kubelet-work-pids.conf](kubelet-work-pids.conf)，只设置 `podPidsLimit: 512`。写入目标为 `/var/lib/rancher/k3s/agent/etc/kubelet.conf.d/90-work-agent-pids.conf`，不替换 `00-k3s-defaults.conf` 或原 K3s 配置。K3s v1.36 支持这种 kubelet drop-in；若现有自定义 config-dir 或 CLI 参数覆盖它，必须停止并重新审查。[K3s 配置说明](https://docs.k3s.io/installation/configuration)、[Kubernetes PID 限制](https://kubernetes.io/docs/concepts/policy/pid-limiting/)。

这是节点级设置，会作用于该节点上的业务 Pod，需要重启 K3s，可能短暂影响管理面、调度与现有业务。生产执行需要单独授权并确定维护窗口。本轮代码准备不执行以下操作。

经授权后的步骤：

1. 记录节点 Ready/pressure、Pod 状态、业务健康、长任务和当前 PID 快照；保存现有 K3s/kubelet 配置和状态备份。若 Pod 已接近 512 或备份无法确认，停止。
2. 确认目标文件不存在。若已存在，不能覆盖；先读取并审查原配置。通过受控文件传输把候选放入 root 私有暂存目录，验证 SHA-256；用 `install -o root -g root -m 0600` 写入唯一目标。
3. 只执行 `systemctl restart k3s`，不执行卸载、killall 或整机重启。确认 API、节点 Ready、既有业务健康恢复，并从节点 `configz` 验证 `podPidsLimit=512`。
4. 验证实际新建合成任务 Pod 的 cgroup `pids.max=512`，再继续独立 Gateway 部署准备。PID 修改通过不代表 TLS、模型 key、registry 或业务 Agent 已验收。

回退：确认目标仍为本次候选的 SHA-256，仅删除这个新建文件，重启 K3s，再确认 configz 恢复变更前值、节点及业务健康。保留其他配置和备份；若文件内容变化或未恢复，停止后续发布并报告。不得为回退删除业务 Pod、数据卷或改变供应商 key。

本地使用同一候选文件只读挂载到隔离 K3s 的目标路径，验收不仅读取 configz，还读取真实任务 Pod 的 cgroup 上限，并覆盖 Pi/dsh SDK、取消、超时、重启和 NetworkPolicy。生产预检使用 `preflight-work-k3s.py --context EXPLICIT_CONTEXT`，只执行 Kubernetes get；它拒绝无限/未知 PID 上限、不可调度节点及不足 CPU requests 余量，不读取 Secret 值。基础预检即使全部通过，也明确保留 `deployment_ready: false`，直到后续独立部署验收完成。
