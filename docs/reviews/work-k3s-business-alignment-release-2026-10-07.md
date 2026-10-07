# Work 生产业务版本对齐回执

用户明确授权按[发布清单](work-k3s-business-alignment-candidate-2026-10-07.md)执行后，已完成一致性数据库备份、Work 0002→0007 原子迁移及 7 个镜像使用方的顺序更新。[机器回执](work-k3s-business-alignment-release-2026-10-07.json)记录资源 UID、校验值和健康结果。

| 项目 | 结果 |
| --- | --- |
| 业务源码 | 41dd33f0a923abd889612e9ac3baa30823a44ddc |
| 业务 OCI digest | sha256:5ff2640ff755c22d02ccb4453541a976aba9330c1ecc19e177331eb8e231648d |
| 数据库 | Work 0003—0007 同一事务提交，其他应用迁移记录不变 |
| Deployment | backend、backend-ai、celery-backend、celery-beat、celery-work 均已更新、Ready |
| CronJob | docs-profiles、reminders 的未来 Job 模板已更新，历史 Job 未追改 |
| API 心跳 | 两个 API Deployment 的 /__heartbeat__ 和 /__lbheartbeat__ 均为 200 |
| Celery | 两个当前 worker 的 ping 均返回 pong |
| 开关 | agent、本地执行、远程派发、review 在全部 7 个模板中显式关闭；API 运行时核实为 False |
| 最终状态 | 集群 30 个非 Job Pod 全部 Ready，业务命名空间 22 个非 Job Pod Ready，5 个新业务 Pod 重启数为 0 |
| 独立 Gateway | UID 和镜像未变，继续 Ready |
| 清理 | 临时迁移 Job 及 Pod 已按 UID 条件清理，PostgreSQL 临时校验副本已删除 |
| 调用/回退 | 本次发布未调用供应商模型，未创建生产测试账号或用户任务，未执行回退 |

备份为 1,900,669 字节，SHA256 为 6c7401037376f60afdb2a355ced8010defa88590e8a4637918ed73fa61d63699，保留在生产主机 /var/lib/we-meet-work-maintenance/business-align-41dd33f0a/database-before.dump。目录权限 0700、备份权限 0600，均属于 root；含凭据的原始资源快照也仅保留在此私有目录，没有下载或入库。

首次尝试中，PostgreSQL 容器挂载的管理员密码未通过认证，业务数据库连接正常。备份改用当前业务实际连接凭据，仅在生产主机/容器内存与 stdin 间传递，没有修改数据库角色、密码或 Secret。归档通过 stdin 校验两次超时，均发生在迁移前；随后在 PostgreSQL 容器私有临时目录中核对副本 SHA256，运行 pg_restore --list 和完整 pg_restore --file=/dev/null，完成后清理。该结果证明归档可完整读取，不等于已演练数据库恢复。

第一次镜像更新因暂时 CPU 余量不足而在 Patch 前停止，未改变工作负载。重新盘点的安静窗口为 3650m/4000m；后续更新等待正常调度窗口，没有改变资源申请、并发更新全部服务或设置 nodeName 绕过调度器。每项更新按资源 UID、当前 resourceVersion 和完整原 spec 检查，只改变镜像与四个关闭开关，其他配置保持一致。

本地应用回归 261 项通过、2 项 SDK opt-in 测试跳过；生产发布保护逻辑 8 项通过。发布前旧镜像与候选镜像在升级后 PostgreSQL 上的上传、任务创建和历史读取均通过，原成功记录及成果保留。真实 dsh/Pi SDK 集成未重跑，账户灰度及桌面→服务端审查的新功能仍未开放。

业务 Helm release 仍为 revision 457/deployed，本次没有执行通用 Helm 升级。有限范围 Patch 已形成新的现场镜像/关闭开关状态，与 Helm 保存模板存在差异；后续 Helm 发布必须先对齐这些状态和迁移 hook，不能用旧 tag-only 脚本或 helm rollback 覆盖。回退保留 Work 0007，仅恢复各自旧镜像，并重新检查 UID/resourceVersion；新任务类型启用后，本轮旧镜像兼容结论需要重新评估。
