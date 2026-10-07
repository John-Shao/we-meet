# K3s 生产 PID 维护

用户明确授权 PID 配置变更及 K3s 重启。最终 kubelet `podPidsLimit=512`，新探针 Pod `02723430-4a87-4a5f-9203-443ab029b71e` 的真实 cgroup `pids.max=512`，探针已按 UID 清理。生产仍为原单节点 `lavm-emzsrnxdeh`，UID 保留，Ready=True，三种 pressure=False；29 个常驻 Pod 全部就绪、UID 保留。证据见 [公开回执](work-k3s-pid-maintenance-2026-10-07.json)。

本次并非一次无影响的重启。第一次重启发现 OS 主机名已经变为 `jd-sjy`，K3s 没有显式固定原节点名，注册了新的节点。原节点一度 Unknown，常驻容器累计重启数由 1 升至 32；误注册节点上的两个文档定时 Job Pod 失败。先通过 root 私有配置固定 K3s 原节点名，保留 OS 主机名，再由自动回退重启恢复原节点；确认原节点 Ready、新节点仅有 DaemonSet 和已终止 Job Pod 后，按新节点 UID 清理误注册记录。后续文档定时 Job 已成功完成。没有恢复数据库、删除原常驻 Pod/PVC、修改供应商 key 或启用业务开关。

第二次尝试配置和业务健康检查通过，但探针的 `Never` 拉取策略报 `ErrImageNeverPull`。虽然 `ctr` 列出了同一个 digest，CRI 没有按该策略认出它。第三次尝试改为 `IfNotPresent` 并复用现有业务 imagePullSecret 引用，变更前探针成功，但变更后被 kubelet 以 `OutOfcpu` 拒绝：100m 请求加已有 3950m 超过 4000m。两次均清理探针、自动回退 PID 文件并确认业务恢复。

最终工具先验证探针可运行，再变更配置；探针申请 10m CPU，前后采用不同名字，只使用原健康业务镜像，非 root、根目录只读、无 API token/业务环境/模型调用。最终尝试前后常驻容器重启数均为 32。共执行 4 次变更尝试、3 次自动回退、7 次 K3s restart；未执行整机重启、killall 或业务 Helm 发布。

每次修改前备份配置、K3s server token 和 SQLite 一致性快照，`quick_check=ok`。最终备份位于 `/var/lib/we-meet-work-maintenance/pid-7253c48eb70d455da41b3b2242c4c5c0`，SQLite 75,751,424 字节，目录 0700、文件 0600。公开回执只有状态、UID、模式及文件 SHA；不包含 token、数据库内容、SSH 凭据或模型 key。备份仍仅保留在生产 root 私有目录。

[受控维护工具](../../deploy/aliyun/change-work-k3s-pids.py) 与 [10 项测试](../../deploy/aliyun/test_work_k3s_pid_change.py) 已覆盖一致性备份、禁止覆盖、回退内容保护、探针 UID 清理、原业务 UID 替换拒绝、主机名漂移拒绝以及小资源探针。Ruff 和 diff 检查通过。主机名检查是在第一次漂移后补齐的，不能倒推成第一次执行前已通过。

维护后只读预检通过单节点/PID/当次 CPU 余量，独立 Gateway/任务 namespace 尚未创建，仍是 `deployment_ready:false`。CPU requests 的普通快照为 3550m，探针事件曾观测到 3950m；新增 Gateway 和真实任务请求共 200m，因此发布前必须重新检查，并让真实任务经过 scheduler，不能把 10m 探针成功当作真实 agent 容量验收。后续独立发布候选见 [Gateway 范围](work-k3s-gateway-candidate-2026-10-07.md)。
