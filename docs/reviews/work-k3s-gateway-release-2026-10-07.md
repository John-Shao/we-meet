# 独立 Pi/Qwen Gateway 生产发布回执

用户授权“新增生产服务”后，在京东云 `36.151.142.132` 的现有 K3s 发布 `meet-work-review`。独立服务已 Ready；业务 `WORK_AGENT_ENABLED`、`WORK_REVIEW_ENABLED` 仍未设置，默认关闭。没有改业务 Deployment、重启 K3s 或追加节点配置变更。桌面本地 dsh 的工作空间集成保持原有边界。

结构化证据见 [公开回执](work-k3s-gateway-release-2026-10-07.json)。它保留首次验收失败、零模型调用补查和新样本的独立记录，不把修改预设标签当成一次重新通过的测试。

| 项目 | 实际发布 |
| --- | --- |
| Release / Gateway namespace | `meet-work-review` |
| Task namespace | `meet-work-review-tasks`，restricted Pod Security |
| Deployment UID | `d042e27f-608f-46a7-82d6-672ca2bc30f7` |
| 引擎 / 模型 | Pi 1.0.4 / 百炼 `qwen3.8-flash` |
| 服务入口 | `https://meet-work-review.meet-work-review.svc.cluster.local:8444` |
| Broker | 同一 Service 的 TLS 8445，仅任务 Pod 可访问 |
| 公开访问 | ClusterIP，无公网 Ingress |
| 持久化 | `meet-work-review-state`，local-path 2Gi，Bound，卸载默认保留 |
| 资源 | Gateway 100m/128Mi；串行 worker 100m/128Mi；任务配额最多 2 个 Pod |
| 业务现场 | 原有 29 个 Pod Ready，UID 和重启计数未变，合计 32；前端 HTTPS 200 |

镜像已实际推送并核对 registry digest：

- Gateway：`jusi-cn-guangzhou.cr.volces.com/we-meet/work-agent-gateway@sha256:9d0ec059f8a5dd9e70935e5c0d40ba4b2605fce4e685c202ea21e216a7958adb`
- Pi：`jusi-cn-guangzhou.cr.volces.com/we-meet/work-agent-pi@sha256:5c460c1b1ef5e5d9ce0d70ba3c274bf05f08a5bbb730865c0b68d41662b9a033`

生产复用原 `meet/meet-ai-credentials` 中的 `DASHSCOPE_API_KEY`，只在服务器内存复制这个字段到 Gateway 的 `meet-work-review-provider`。原 Secret 未修改，key 未写入 Git 或下载到开发机。注册表凭据仅复制目标 registry 的 auths 条目。任务 namespace 不含供应商或业务 Secret；任务无 API token，Gateway 无 Secret 读取和集群级权限。

私有 CA、TLS 私钥及随机 Gateway token 在服务器生成，root 私有目录和独立 Secret 保存。业务 namespace 仅新增客户端 token 和公共 CA Secret，未挂载到现有业务 Deployment。TLS SAN 校验通过，叶证书有效期至 2027-10-07 13:08:51 UTC；提前续签同一 CA 下的叶证书并重启 Gateway 即可，CA 轮换另行安排信任迁移。

## 验收结果和标签审阅

实际验证了 TLS、RBAC、预算在供应商调用前拒绝、取消先于任务提交的围栏、SQLite 备份恢复副本校验，以及 Gateway 实际重启后取消状态保留。恢复验证使用独立副本，未覆盖活动数据库；不能据此声称已演练跨版本数据库回退或整机灾难恢复。

NetworkPolicy 做了正负对照：业务可访问 Gateway 8444，任务可访问 Broker 8445 并收到未认证 401；任务访问业务 8080、Gateway 8444、百炼 443、API server 6443 均被拒绝。补查确认任务本身 8080 正在监听，而来自业务 namespace 的连接被拒绝。补查第一次出现临时探针检查失败；增加监听就绪等待后通过，两次都未增加模型调用。删除按 Pod UID 约束，最终确认无残留探针或任务 Pod。

| 合成样本 | 实际结果 | 结论 |
| --- | --- | --- |
| `2 + 2 = 4` | `no_issues` | 符合预设 |
| `2 + 2 = 5` | `needs_changes`，引用错误表达式 | 符合预设 |
| 目标要求实测证据，文件明确“尚未进行并发测试” | `needs_changes`，引用未测试声明 | 首次预设 `inconclusive` 不匹配，原始失败保留；人工审阅认为已知未完成验收条件支持 `needs_changes` |
| 文件仅有概况，问实际最大并发且禁止推断未知参数 | `inconclusive`，列出缺少的实测数据 | 使用新 UUID 单独补测，符合预设 |

累计 4 次真实供应商调用，各 1 次，输出上限均为 4096 tokens，没有供应商重试或重放旧任务。实际合计输入 2368、输出 579 tokens。所有成果 checksum 和用量记录已验证。4 个合成样本证明当前调用与交付链路可用，不代表真实业务材料的模型质量评测已经完成。

## 运维边界

首次部署使用 [provision-work-k3s.py](../../deploy/aliyun/provision-work-k3s.py)，只接受公开 chart/values 包，自动创建受限 Secret、证书和首次空状态。已有 root 状态或资源冲突必须检查回执，脚本拒绝盲目重新安装。生产公开配置和私有日志在 `/var/lib/we-meet-work-maintenance/gateway-release`；其中 `values.json` 只含公共 CA 与 Secret 引用，私钥和 token 单独存储。不要导出或提交整个目录。

[首次验收脚本](../../deploy/aliyun/accept-work-k3s-production.py) 保留本轮原始预设；`acceptance.json` 存在时拒绝再次运行，防止追加调用。[基础设施补查](../../deploy/aliyun/finalize-work-k3s-production.py) 不提交模型任务，使用独立尝试回执；[未知信息样本](../../deploy/aliyun/complete-work-k3s-model-sample.py) 要求当前计数恰为 3，并在 POST 前持久化 UUID。应答丢失后只查询原 UUID，不能删除回执重跑。

首次 release 没有旧 Helm 版本可回退。出现问题时先保持业务关闭，撤销/取消活动任务并按 UID 清理，再停止新增 Gateway；保留 PVC、原业务 Deployment、原供应商 Secret及已验证的 PID/节点身份配置。后续升级须先做状态快照和版本兼容检查，镜像/配置回退不等于数据库回退。

新增部署与验收脚本 15 项离线测试通过，Ruff 通过。单节点仍有容量限制：正常调度，不绕过 scheduler，不调整业务请求为 agent 腾空间。

下一批先完善评测样本对“未完成”和“未知”的定义，并准备业务侧受控联调候选：明确测试账号、合成材料、调用预算、业务镜像来源和关闭步骤。当前 Gateway 标记 `synthetic_materials_only`、`no_business_tools`、`no_resume`；真实用户材料和业务开关启用属于后续范围，本回执未执行这些操作。
