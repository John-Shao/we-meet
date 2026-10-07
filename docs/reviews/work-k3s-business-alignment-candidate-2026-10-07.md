# Work 业务版本对齐发布候选

独立 Pi/Qwen Gateway 已发布，见[服务回执](work-k3s-gateway-release-2026-10-07.md)。本批修复旧版本在升级后无法创建 Work 任务的问题，完成本地验证，并在用户明确授权后按以下清单完成生产对齐：**数据库到 Work 0007，5 个 Deployment 和 2 个 CronJob 模板使用同一候选 digest，四个新功能开关保持关闭。** 本批模型调用为 0，没有下载生产凭据或用户材料。最终结果见[生产发布回执](work-k3s-business-alignment-release-2026-10-07.md)。下文保留执行前审查依据。

候选源码提交为 `41dd33f0a923abd889612e9ac3baa30823a44ddc`，镜像 tag 为 `work-align-41dd33f0a`。已推送并从 registry 核实的发布引用：

```text
jusi-cn-guangzhou.cr.volces.com/we-meet/meet-backend@sha256:5ff2640ff755c22d02ccb4453541a976aba9330c1ecc19e177331eb8e231648d
```

镜像从干净 Git archive 构建，使用 backend-production target 和 DOCKER_USER=root，与现有镜像的默认用户一致。打包的 Python 文件及依赖清单哈希匹配源码，依赖锁与生产 API 镜像相同；核对不覆盖生成的邮件和静态资源，不宣称整个构建可逐字节复现。

## 基线与变更范围

只读 SQL 确认数据库为 PostgreSQL 16.4，迁移记录 220 条，Core 到 0196，Work 到 0002。生产保留退役的 core.0136_task_saved_view 记录，对应表已由 0139 删除。精确旧镜像建立的新库只有 219 条记录；联测在隔离库补入已核实的这条历史记录，使基线匹配，没有修改生产历史。

| 镜像使用方 | 当前基线 | 对齐范围 |
| --- | --- | --- |
| meet-backend、meet-backend-ai | digest 05589638… | Work agent、本地成果、设备/工作空间、远程任务与 Pi 审查；Core API 生产代码差异仅为导入顺序，另有关闭状态的配置与定时任务 |
| meet-celery-backend、meet-celery-beat、meet-celery-work | digest 56741fb4… | 还对齐当前 API 镜像已有的通话、转写和路由代码 |
| meet-backend-docs-profiles、meet-backend-reminders | tag d7478257e，本次解析为 digest 61ac48ce… | 还对齐模型 HTTP 客户端、嵌入、转写和摘要来源；不追改已有 Job |

完整来源差异、资源 UID、镜像及条件 Patch 快照见[发布清单](work-k3s-business-alignment-candidate-2026-10-07.json)。不能将完整镜像替换描述为仅有 Work 变化；CronJob tag 本次解析也不代表历史 Job 实际使用的镜像。

## 修复与验证

最初回归复现了 Work 0006 下旧 ORM INSERT 的 WorkTask.kind 非空约束错误。0007 为 14 个新增非空字段增加数据库默认值，保留 0003—0006 历史迁移。旧任务仍是 communication/cloud，不会被 agent 领取。

升级使用候选镜像打包的专用命令：

```sh
python manage.py migrate_work_upgrade          # 只检查计划
python manage.py migrate_work_upgrade --apply  # 一个 PostgreSQL 事务提交 0003—0007
```

命令限定 Work 0002 基线、完整依赖历史及迁移计划，取得事务级 advisory lock 后重查。DDL 和迁移记录一起提交或回滚，避免旧进程看到缺少默认值的中间版本；锁等待上限 3 秒、每条 SQL 上限 60 秒。锁期间请求可能等待，超时则停止。已有 0007 时重复执行不变更。**不能用通用 manage.py migrate 代替本次命令**，否则各迁移之间会暴露不兼容窗口。

本地 WSL 使用无外网、无发布端口的 Docker internal network、PostgreSQL 16、Redis 7 和合成材料。[验收回执](work-k3s-business-upgrade-acceptance-2026-10-07.json)记录：

- Work 回归 78 项通过、2 项 SDK opt-in 集成测试跳过，覆盖中途故障时 DDL/迁移记录回滚、旧数据保留、旧 ORM 写入和桌面成果 HTTP 审查交付。
- 原有通话与翻译 API 110 项通过；初次失败是隔离环境缺少 OIDC 配置，补齐离线配置后通过。
- 为较旧 Celery/CronJob 补跑的转写、嵌入、流式/非流式模型与 HTTP 客户端回归 73 项通过。
- 实际候选生产镜像的 plan 不修改数据库，apply 升级一次，重复 apply 为 no-op。实际旧 API、Celery、本次解析的 CronJob 镜像与候选镜像均通过升级后的上传、创建任务及历史读取；旧成功记录和成果保留。
- Ruff、迁移漂移与 Git diff 检查通过。总计 **261 项通过、2 项跳过**，供应商调用为 0。

本轮没有重跑真实 dsh/Pi SDK。生产已完成一致性备份、归档目录及完整数据读取校验，未做完整数据库恢复演练；本地兼容验证不能替代生产运行验收。

## 执行顺序与回退

1. 此前明确授权的是新增独立生产服务；本清单涉及现有数据库及 7 个业务工作负载，执行前已取得用户“授权按清单执行”的明确确认。
2. 重读节点、数据库历史、Helm 状态、全部消费者和调度余量，核对 UID、镜像及配置。Patch 快照中的 resourceVersion 会变化，须取得新版本并检查基线；不能直接沿用旧快照。单节点容量紧张，逐项执行，不改变资源申请或绕过调度器。
3. 在生产主机私有目录保存回退配置及一致性数据库备份，记录校验值、容量与恢复路径。备份、凭据和完整 manifest 留在主机；备份验证未完成时不迁移。
4. 使用候选镜像执行一次专用迁移任务，先 plan 后 apply。仅引用数据库和必要 Django 配置，关闭四个新功能开关，不引入模型/Gateway 凭据；正常调度、关闭 ServiceAccount token 自动挂载、deadline 180 秒、backoffLimit 0。完成后核对到 0007，保留 Core 历史。
5. 顺序更新 5 个 Deployment、2 个 CronJob 的未来 Job 模板。每项以 UID、最新 resourceVersion、容器名及原镜像为条件，只更新镜像和四个关闭开关。保留 DB/Redis、队列、材料存储、资源及其他配置；每个 Deployment 等待 Ready 并检查错误后才继续。
6. 显式设置 WORK_AGENT_ENABLED、WORK_LOCAL_AGENT_ENABLED、WORK_REMOTE_AGENT_ENABLED、WORK_REVIEW_ENABLED 为 False，保留普通 Work 材料及 communication 原有开关。本次不注入审查连接凭据、不开启新任务入口、不重放任务；完成后核验旧业务并输出回执。
7. 失败则停止后续更新，恢复各自原 API/Celery digest；CronJob 回退到本次核实的旧 digest，避免移动 tag。保留向前升级的 0007，不自动反向迁移或恢复数据库覆盖新写入。回退也须重新检查当前候选镜像和 resourceVersion。本轮旧镜像兼容结论只适用于新任务类型仍关闭的阶段。

拟采用有限范围的条件 Patch，避免通用 tag-only 发布脚本处理现有 digest 时失败或 Helm 默认值/hook 改动无关模块。这样会产生 Helm 保存模板与现场的差异，须记录；后续 Helm 发布前必须对齐 7 个镜像、关闭开关和迁移 hook。不能直接运行旧发布脚本或 helm rollback 覆盖现场。

对齐验收后，再准备服务端准入限制、受控账号和单批合成材料预算，连接已有 Gateway。全局开关本身不提供账号灰度隔离；本批不声称端到端产品功能已经开放。
