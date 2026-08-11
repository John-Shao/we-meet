# 阿里云日常发布 Runbook（改代码后上线）

面向**已经部署好**的生产环境（aliyun-sjy，命名空间 `meet`，镜像 tag = `latest`）。
首次安装见 [`aliyun.md`](./aliyun.md);这份只讲「改完代码怎么安全上线」。

拓扑约定:
- **构建机**:WSL / PC，仓库在 `/mnt/d/workspace/we-meet/we-meet`,build + push 镜像到火山 CR。
- **生产 ECS**(aliyun-sjy):仓库在 `/opt/we-meet`,跑 `git pull` + `helm upgrade` + `kubectl rollout`。
- 生产 values 用 `src/helm/env.d/aliyun-prod/values.meet.yaml`,里面 `image.tag: "latest"` + `pullPolicy: Always`。

---

## 先判断:这次改动属于哪种?

| 改了什么 | 要不要 build 镜像 | 要不要 `helm upgrade` | 要不要 `rollout restart` | 要不要 `migrate` |
|---|---|---|---|---|
| 仅前端代码 | frontend | 否 | ✅ frontend | 否 |
| 仅后端代码(无新迁移) | backend | 否 | ✅ backend | 否 |
| 后端**有新迁移** | backend | ✅ **必须**(触发 migrate hook) | ✅ backend | ✅ hook 自动(附手动兜底) |
| 改了 helm **values / 模板**(新增 CronJob、env、资源等) | 视情况 | ✅ **必须** | 若同时改了代码则 ✅ | 视情况 |

> ⚠️ **关键坑**:因为生产是 `tag: latest`,`helm upgrade` **不会**因为镜像内容变了就重建 Deployment(tag 没变)。所以:
> - **代码变更** → 必须 `rollout restart` 才能拉到新推的 `latest` 镜像。
> - **values/模板变更**(如新增 CronJob)→ 必须 `helm upgrade` 才会生效,`rollout` 不会创建新对象。
> - **有数据库迁移** → 必须 `helm upgrade`:迁移靠 chart 的 **migrate hook** 触发,而 helm hook **每次 `helm upgrade` 都会跑**(不是只在 values 变化时)。hook 的 Job 用 `latest` 标签 → 拉到刚推的新镜像跑迁移。只 `rollout` 不 `helm upgrade` 会漏迁移,访问相关表报 `relation "…" does not exist` 500。
> - 顺序:**先 `helm upgrade`(迁移先跑)再 `rollout restart`(新代码才服务)** —— 保证迁移早于新代码,避免新代码查无表。

---

## 阶段 A — 构建机:build + push

```bash
cd /mnt/d/workspace/we-meet/we-meet
git pull origin aliyun-dev
# 按需选模块:frontend / backend / summary / agents,或全部
bash deploy/aliyun/build-and-push.sh frontend backend
```
> Apple Silicon 需先 `export BUILDX_DEFAULT_PLATFORM=linux/amd64`(生产 ECS 是 x86_64)。

## 阶段 B — 生产 ECS:pull → (helm upgrade) → rollout

```bash
cd /opt/we-meet && git pull origin aliyun-dev

# 仅当改了 values/模板时执行(如新增/开启 CronJob):
helm upgrade --install meet ./src/helm/meet \
  -n meet \
  -f ./src/helm/env.d/common.yaml.gotmpl \
  -f ./src/helm/env.d/aliyun-prod/values.meet.yaml \
  -f ./src/helm/env.d/aliyun-prod/values.secrets.yaml \
  --wait --timeout 15m

# 拉新 latest 镜像(按本次实际改动的模块选)
kubectl -n meet rollout restart deploy/meet-frontend deploy/meet-backend
kubectl -n meet rollout status  deploy/meet-frontend --timeout=120s
kubectl -n meet rollout status  deploy/meet-backend  --timeout=120s
```

### 若本次有新迁移(必读)
迁移由上面的 **`helm upgrade` migrate hook 自动跑**(每次 upgrade 都触发,用 latest 新镜像)。所以有迁移时,阶段 B 的 `helm upgrade` 不是可选而是**必须**,且要排在 `rollout` 之前。

跑完 upgrade + rollout 后,**确认迁移已落**:
```bash
kubectl -n meet exec deploy/meet-backend -- python manage.py showmigrations core | tail -5
#   期望目标迁移显示 [X];若仍是 [ ],说明 hook 没跑成,手动兜底:
kubectl -n meet exec deploy/meet-backend -- python manage.py migrate --no-input
```
> 手动兜底要在**新后端 pod 就绪后**(pod 里已是含该迁移的新代码)执行 —— 所以兜底命令放在 rollout 之后。切勿在 `helm upgrade` 前用旧 pod 跑 migrate(旧代码没有该迁移文件)。

### 日历 P1（迁移 0091）部署顺序

按 **backend + `0091_calendar_recurrence_source_backfill` → frontend → Android** 发布。0091 只给来源为空、父事件来源非空的物化子场次补值，不覆盖非空来源；同时把已过触发点且未处理的提醒静默标记为已处理（outcome 留空），未来提醒保持待发送，因此迁移完成后不会集中补发迟到提醒。

```bash
kubectl -n meet exec deploy/meet-backend -- python manage.py showmigrations core | grep 0091
# 期望: [X] 0091_calendar_recurrence_source_backfill
```

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
