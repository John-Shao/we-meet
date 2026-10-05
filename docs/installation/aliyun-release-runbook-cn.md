# 阿里云日常发布 Runbook（改代码后上线）

面向已有生产环境（aliyun-sjy，命名空间 `meet`）。首次安装见 [`aliyun.md`](./aliyun.md)。
日常发布统一使用 `deploy/aliyun/release-meet.sh`，镜像 tag 取完整 commit SHA 的前 9 位。
values 中的 `latest` 只是默认占位；发布脚本拒绝它，并显式保留未选择模块的运行中标签。

## 构建与发布

1. 提交并推送到 `aliyun-dev`，等待该提交的 **Release guard** 完整通过。
2. 构建机在同一提交执行 `bash deploy/aliyun/build-and-push.sh backend`（按需选模块）。
3. 生产 ECS 安装 `python3`、`gh`，让 `gh` 可读取仓库的 Actions。凭据通过主机认证或环境管理，不写入仓库。
4. 在 `/opt/we-meet` 运行发布脚本。首次引入 AI HTTP 池必须包含本批次 `backend` 镜像。

```bash
cd /opt/we-meet
# 只检查：仍会读取集群中现有标签，但不执行升级
bash deploy/aliyun/release-meet.sh --dry-run --ci-check --image-check backend
# 发布：自动更新分支、校验 CI、执行 Helm 迁移 hook、等待 rollout
bash deploy/aliyun/release-meet.sh backend
```

无模块参数会发布全部模块。每次发布都会执行 Helm，使迁移、路由和镜像一起更新；不再以
`latest` + 手工 `rollout restart` 作为日常发布路径。本地 secrets / Work overlay 继续由脚本加载。

## CI 门禁

真实发布无 CI 跳过选项。`--dry-run` 默认离线跳过 CI；`--ci-check` 可显式启用查询。
发布前要求 tracked 工作区干净，并校验当前 chart 提交、镜像标签解析出的完整提交，以及实际使用的
backend 提交。仅接受同一 origin 仓库的 `push` 或 `workflow_dispatch` 记录，最新运行必须完成且成功；
其当前 attempt 的 `backend-boundaries`、`frontend-artifact`、`deployment-boundaries` 必须全部成功。
较早的绿色记录、PR 合成提交、跳过的 job、查询失败均不能放行；失败重跑请选择 **Re-run all jobs**。
脚本只读 CI 状态，不触发工作流。Jobs 查询使用 GitHub 的[指定 attempt 接口](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt)。

回滚 `--tag <sha>` 同样需要目标提交的完整门禁。没有这三项检查的历史提交不能直接通过新脚本；
应把需要恢复的代码作为新回退提交并完整跑 CI。早于 AI 池的 backend 不能配合本批 chart，
脚本会在 Helm 前拒绝，防止仅发布 frontend 时用旧 backend 启动不存在的 WSGI 入口。
使用历史 chart 的回退另按对应版本流程处理，并核对数据库兼容性。

## 本批架构变更的部署与验收

- 新增迁移 `0196_legacy_summary_run`。Helm 的 pre-upgrade hook 必须先完成，再启用新 backend / Celery。
- 新增 `meet-backend-ai` Deployment、Service 和 `meet-ai` Ingress，与 backend 共享镜像、认证配置和 Secret 引用。
  生产启用 `aiBackend.enabled`；通用 chart 默认关闭。路由依赖 ingress-nginx 的正则支持。
- 每个 AI Pod 为 2 个 gthread 进程、每进程 4 线程，接纳上限每进程 2 个长请求，即每 Pod 最多 4 个。
  这是进程本地容量限制，负载不均时可能提前返回 503；调整上限时须保留处理健康检查/拒绝请求的线程。
  超限返回 `Retry-After: 5`，Ingress 不自动向其他上游重试模型请求。
- 独立 Pod 新增资源请求 100m CPU / 256Mi 内存，上限 1 CPU / 1Gi 内存；发布前确认节点可调度，
  rollout 期间还需容纳临时副本。隔离的是 HTTP 工作进程，数据库、Redis、节点和模型供应商仍共享。
- 分流路径覆盖个人/房间/全局同步问答与 SSE、资料提问及助手纪要。内部直连 `meet-backend` 的调用仍走普通池。
  生产验收应同时压测 SSE 与普通 API，观察 API 延迟、AI 503、数据库连接数、Pod 内存及客户端断连后的容量恢复。

```bash
kubectl -n meet exec deploy/meet-backend -- python manage.py showmigrations core
kubectl -n meet rollout status deploy/meet-backend-ai --timeout=10m
kubectl -n meet get ingress meet-ai
```

旧纪要通过短事务领取 `LegacySummaryRun`，在事务外调用模型、Docs 和 IM，再用 token、10 分钟租约及来源状态
校验写回。生成期间资料被删除、移入回收站、切换版本化纪要或租约过期时，不接受迟到结果。
自动事件不重放已经失败或结果不确定的付费尝试；需人工检查后通过原重新生成入口或
`python manage.py generate_summary <session-id>` 显式重试。版本化资料仍使用版本化生成入口，不能强制回到旧链路。
Docs/IM 保持尽力投递：投递失败不回滚已保存纪要；外部成功但本地确认前崩溃仍可能存在不确定状态，
本批不承诺跨系统 exactly-once 投递。升级期间应让旧 Celery 任务排空，避免旧代码不识别新领取记录。

以下保留历史专项迁移说明；涉及删除数据的迁移按各自顺序处理。


### 三方日历同步删除（迁移 0098）部署顺序

`0098_remove_external_calendar_sync` 会删除本地同步账号、令牌、镜像日历/日程和同步
Schema，属于破坏性迁移，不能套用本页默认的“迁移先于 rollout”顺序。必须先更新
backend 和 `meet-celery-backend`，确认旧同步代码已退出，再执行 `0098`，最后发布
`helm upgrade` 应用统一日历/分享/导出开关并发布 frontend 和 Android。迁移前必须
完成 PostgreSQL 全量备份；迁移后回滚需要同时恢复数据库与旧镜像，不能只执行
`migrate core 0097`。

完整命令、Schema 验收、云端 OAuth 收口与回滚步骤见
[三方日历同步删除 — 部署步骤](../extensions/三方日历同步删除_部署步骤.md)。

### 日历 P1（迁移 0091）部署顺序

按 **backend + `0091_calendar_recurrence_source_backfill` → frontend → Android** 发布。0091 只给来源为空、父事件来源非空的物化子场次补值，不覆盖非空来源；同时把已过触发点且未处理的提醒静默标记为已处理（outcome 留空），未来提醒保持待发送，因此迁移完成后不会集中补发迟到提醒。

```bash
kubectl -n meet exec deploy/meet-backend -- python manage.py showmigrations core | grep 0091
# 期望: [X] 0091_calendar_recurrence_source_backfill
```

### 日历 P1-8 与外部联系人部署顺序

完整设计、身份边界和已知限制见 [P1b 外部联系人](../phases/p1b-external-contacts.md)。

按 **backend → frontend → Android** 发布。后端先提供 ``attendee_entries``、
``details_redacted`` 和组织者 RSVP 限制；新字段均为加法兼容，旧客户端继续使用
``attendee_ids``。外部联系人闭环新增迁移 ``0092_external_contacts``，必须先完成后端
迁移，再发布移除日历邮箱直邀入口的 Web/Android 客户端。``EventAttendee.email``
仅保留历史数据读取能力，新写请求必须提交真实用户 ``user_id``；手机号/邮箱搜索、
好友申请与接受操作统一收口到通讯录模块。

旧 Web/App 若仍显示“外部邮箱参与人”，在新后端提交该字段会收到 400；这是移除
email-only 错误身份模型的刻意不兼容。三端发布窗口应尽量缩短，并在 Android 发版
完成前保留明确的升级提示。

```bash
kubectl -n meet exec deploy/meet-backend -- python manage.py showmigrations core | grep 0092
# 期望: [X] 0092_external_contacts
```

### 日历 P1-8b 公开范围与个人日历共享部署顺序

完整权限模型见 [P1-8b：日程公开范围与个人日历共享权限](../phases/p2b-calendar-visibility-sharing.md)。发布顺序固定为 **backend + `0093_calendar_sharing_visibility` → Web → Android**。迁移会创建个人日历、点对点授权和订阅表，为有效组织成员回填默认 `free_busy` 的个人日历，并给 `CalendarEvent.visibility` 增加 `public`；不会复制或改写历史日程。

双端依赖新的个人日历 API，不能先于迁移发布。协议为加法兼容：旧客户端不能选择 `public`；旧客户端编辑已有 `public` 日程时，即使隐式提交 `visibility=default`，后端也会保留 `public`。新客户端主动切回默认范围时会发送只写标记 `visibility_explicit=true`。

```bash
kubectl -n meet exec deploy/meet-backend -- python manage.py showmigrations core | grep 0093
# 期望: [X] 0093_calendar_sharing_visibility
```

迁移后先验证后端：无权用户凭 event id 读取 `default/public/private` 均返回 404；拥有 `free_busy/details` 权限且已订阅的用户按矩阵获得忙碌投影或完整详情；私密日程参与者仍能读取详情。再发布 Web/Android，并验证三态选择、共享授权、订阅和撤销外部联系人后的即时失权。

### 日历 P1-9 全天日期与跨设备时区部署顺序

完整时间模型见 [P1-9：全天日期语义与跨设备时区](../phases/p2c-calendar-all-day-timezone.md)。发布顺序固定为 **backend + `0094_calendar_all_day_preferences` → Web → Android**。

迁移会为历史全天日程按各自已保存的事件时区回填半开 `start_date/end_date`，再添加一致性约束，并创建账号级 `CalendarPreference` 表。它不修改原有 `start_at/end_at` 锚点，也不批量创建偏好行。无效时区、非午夜锚点或非正跨度会产生后端告警；部署后需检查迁移日志，按事件核对异常，禁止把全部历史全天日程统一平移。

```bash
kubectl -n meet exec deploy/meet-backend -- python manage.py showmigrations core | grep 0094
# 期望: [X] 0094_calendar_all_day_preferences
```

双端依赖新增的日期字段、`date_start/date_end` 查询参数和 `/calendar-preferences/me/`。读取协议是加法兼容；旧客户端仍可读取全天日程、创建日程和编辑标题等普通字段，但不能只用 UTC 锚点移动一个已有规范全天日程，否则后端返回 400 `all_day_dates_required`。因此双端发布窗口应尽量缩短。

迁移后至少验证：上海/洛杉矶/UTC 查看同一全天日程不跨日；跨 DST 的全天重复场次保持当地午夜；Web 修改固定时区后 Android 同步；自动模式分别跟随各设备；并发设置修改返回 409 而不互相覆盖。

---

## 已归档的实例:2026-07-02「假完成坑」三项(commit 29634218)

一次同时涉及 **前端 + 后端 + helm values** 的发布,可作模板参考。

改动:
1. **日历提醒 CronJob(values)**:`aliyun-prod/values.meet.yaml` 开启 `backend.reminders.enabled: true` —— 之前 CronJob 模板在、但默认关且生产没开,`send_due_reminders` 从不触发。
2. **建日程 description(前端)**:`CreateEventDialog` 补描述输入并入参。
3. **审批 needs_assignment 恢复(后端,无迁移)**:`approval.retry_assignment()` + `ApprovalInstanceAdmin` 动作「重试审批人解析」。

发布:阶段 A `build-and-push.sh frontend backend` → 阶段 B `helm upgrade`(建 reminders CronJob)+ `rollout restart` 两个 deploy;**无 migrate**。

验证:
```bash
# 提醒 CronJob 已创建
kubectl -n meet get cronjob | grep reminders     # 期望 meet-backend-reminders  * * * * *

# 手动触发一次验证命令可跑(不必等 5 分钟)
kubectl -n meet create job --from=cronjob/meet-backend-reminders reminders-manual-1
kubectl -n meet logs job/reminders-manual-1       # 期望正常退出、无 traceback
kubectl -n meet delete job reminders-manual-1     # 验完清理
```
页面:日历新建日程能填/看描述;建「~6 分钟后开始、提前 5 分钟提醒」的日程,等下个整点 CronJob 跑过收到「🔔 即将开始」;Django admin → Approval instances → 选 `needs_assignment` 实例 → 动作「重试审批人解析」(先补好部门主管/角色)。

---

## 已归档的实例:2026-07-03 审批催办 + 委托(commit 21b64040,**含迁移**)

一次 **前端 + 后端 + 迁移(0048)** 的发布,是「有迁移」路径的样板。

改动:
1. **催办(前端 + 后端)**:`POST /approvals/{id}/urge/` + 前端「我发起的」卡片「催办」按钮。
2. **委托(后端 + 迁移)**:新模型 `ApprovalDelegation`(迁移 `0048_approvaldelegation`)+ `resolve_approver` 委托替换 + `ApprovalDelegationAdmin`。

发布(**有迁移 → helm upgrade 必须,且排在 rollout 前**):
```bash
# 构建机
bash deploy/aliyun/build-and-push.sh frontend backend
# ECS
cd /opt/we-meet && git pull origin aliyun-dev
helm upgrade --install meet ./src/helm/meet -n meet \
  -f ./src/helm/env.d/common.yaml.gotmpl \
  -f ./src/helm/env.d/aliyun-prod/values.meet.yaml \
  -f ./src/helm/env.d/aliyun-prod/values.secrets.yaml --wait --timeout 15m
kubectl -n meet rollout restart deploy/meet-frontend deploy/meet-backend
kubectl -n meet rollout status  deploy/meet-backend --timeout=120s
```
验证:
```bash
kubectl -n meet exec deploy/meet-backend -- python manage.py showmigrations core | grep 0048
#   期望:[X] 0048_approvaldelegation  ;若为 [ ] 则手动 migrate 兜底(见上)
```
页面:审批「我发起的」pending 卡片有「催办」按钮,点后当前审批人 IM 收「⏰ 催办」;Django admin → Approval delegations 建一条有效委托 → 该主管作审批人的新申请任务落到受托人。
