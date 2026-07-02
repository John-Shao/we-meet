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
| 后端**有新迁移** | backend | 否 | ✅ backend | ✅ 见下 |
| 改了 helm **values / 模板**(新增 CronJob、env、资源等) | 视情况 | ✅ **必须** | 若同时改了代码则 ✅ | 视情况 |

> ⚠️ **关键坑**:因为生产是 `tag: latest`,`helm upgrade` **不会**因为镜像内容变了就重建 Deployment(tag 没变)。所以:
> - **代码变更** → 必须 `rollout restart` 才能拉到新推的 `latest` 镜像。
> - **values/模板变更**(如新增 CronJob)→ 必须 `helm upgrade` 才会生效,`rollout` 不会创建新对象。
> - 两者都改 → **先 `helm upgrade` 再 `rollout restart`**。

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

### 若本次有新迁移
```bash
kubectl -n meet exec deploy/meet-backend -- python manage.py migrate --no-input
kubectl -n meet exec deploy/meet-backend -- python manage.py showmigrations core | tail -5
```
> 迁移随后端镜像走;`helm upgrade` 的 migrate hook 只在 chart/values 触发时跑,日常 latest 发布下**手动执行更稳**(参见记忆:只换镜像不触发 migrate hook 会漏迁移报 relation does not exist)。

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
kubectl -n meet get cronjob | grep reminders     # 期望 meet-backend-reminders  */5 * * * *

# 手动触发一次验证命令可跑(不必等 5 分钟)
kubectl -n meet create job --from=cronjob/meet-backend-reminders reminders-manual-1
kubectl -n meet logs job/reminders-manual-1       # 期望正常退出、无 traceback
kubectl -n meet delete job reminders-manual-1     # 验完清理
```
页面:日历新建日程能填/看描述;建「~6 分钟后开始、提前 5 分钟提醒」的日程,等下个整点 CronJob 跑过收到「🔔 即将开始」;Django admin → Approval instances → 选 `needs_assignment` 实例 → 动作「重试审批人解析」(先补好部门主管/角色)。
