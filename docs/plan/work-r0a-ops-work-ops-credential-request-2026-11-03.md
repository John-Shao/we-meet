# 运维身份 work_ops 生产凭据 · 签收单（2026-11-03）

**状态**：待自决落地 · **关联门**：`pilot-checklist.json` C35（pilot, blocking）· **不解锁**：#34 自动 reconcile 写路径（另行裁定，本单不涉及）、Temporal mTLS（属 #36）

## 1. 为什么这是硬前置

`work_ops` 是设计里唯一能执行 `ops_cancel_run` 与 `work-reconcile`（含 `-scan` 只读巡检）的角色。当前生产库**没有它的可登录身份**，等价于：

- 已上线的只读孤儿巡检 timer（`#34` 观测面）能触发但**无人看结果**——发现孤儿后没有运维入口；
- 试点期间任何 Temporal 端孤儿 run 只能人工进 Temporal 干预，绕开 Work 侧审计与幂等；
- #36 演练的 D3-N06（运维开关下的投影同步）与 C28（租户开关翻转）都预设"运维有手"。

## 2. 签收项（每项独立，勾上才计）

- [ ] **①** 角色 `work_ops` 已建：`CREATE ROLE work_ops LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT PASSWORD '<via secret>'`；仅 `GRANT USAGE, EXECUTE` 到既有 definer 中介入口，不给任何 `SELECT/UPDATE/DELETE` on 业务表。
- [ ] **②** 口令走秘密通道注入 ECS 上 `we-meet-work-api`/`work-reconcile` 的运行环境（`systemd` drop-in 的 `EnvironmentFile=` 指向 root-only 文件；**不入 repo、不入 CI secret**，与 `meet-production-release` 的 image.credentials 隔离）。
- [ ] **③** 值班侧接入就绪：运维机 `~/.pgpass` 或等价的 600 权限注入；写入本单 §8 的"值班入口"里。
- [ ] **④** 只读巡检跑通：`work-reconcile -scan -org <试点 org>` 在真库返一次非零返回码集合（可空集），日志含 `Temporal DescribeWorkflowStatus` 结论行。
- [ ] **⑤** 运维写路径跑通一次：对一条人为制造的孤儿 run 调 `ops_cancel_run`，返回 200/成功取消；范围**严格限这一条命令**，不越到 #34 的 reconcile 自动写路径。
- [ ] **⑥** 审计落库：`audit_event` 出现 `actor='work_ops'` 的两条记录（对应 ④⑤）；含 `client_request_id`。

## 3. 负责人 / 独立复核

- **决策与执行**：John。
- **独立复核人**：无（Lily 2026-11-01 离队）。按仓库既有口径，答复方缺失时**降级为自决日志 + 延迟复评**——本单不虚构外部签字；⑥ 的审计行是唯一的独立可查物。

## 4. 截止 / 复评

**2026-11-08 复评**。到期未闭：把 C35 记 `blocked` 或另开例外单（后者需明确"试点期无运维入口"的可接受边界）。

## 5. 证据边界（判绿充要条件）

只认 **④⑤⑥ 三条真跑** 的产物（命令 stdout 截图 + `audit_event` 查询行）；**不认**"能连上"或"角色存在"这种弱信号——`work_owner` 成员可绕过（memory 已钉），只有 work_ops 登陆后跑通的两条命令 + 审计落库，才证明"值班手到位"。

## 6. 后果分档

| 触发条件 | 后果 |
|---|---|
| 拖延未闭 | 孤儿 run 只能人工进 Temporal 干预；#36 D3-N06/C28 演练推不下去；pilot gate 保持 blocking |
| 口令泄露 | 轮换一次 `work_ops` 密码即可；**不触发**主密钥例外（#40-A 独立） |
| 直接不做（记例外） | pilot 门不能绿；试点"能看能改"承诺不成立，需把 C35 从 blocking 降级并写明边界 |

## 7. 明确不在本单范围

- #34 的自动 reconcile **写**路径（未裁，另办）。
- Content Store 主密钥轮换（#40-A 记范围例外，重开条件在 pilot-checklist C13 note）。
- D-04 provisioning / 生产环境部署凭据（另一线，与 `we-meet-postgresql` 无关）。
- Temporal mTLS 客户端证书（属 #36 演练）。

## 8. 值班入口（占位，执行时填）

- 运维机：`jd-ecs`（见 memory `work-jd-ecs-environment`）。
- 环境文件：`/etc/we-meet/work-ops.env`（root:root, 0600）。
- 常用命令模板：
  - `work-reconcile -scan -org <org_id>` （只读，走 §2①）
  - `psql "postgres://work_ops@<host>:<port>/work?sslmode=require" -c "SELECT work.ops_cancel_run(...)"`（§2⑤ 限定）

## 9. 关闭判据

§2 六项全勾 + §5 三条真跑产物附本目录 → 把 `pilot-checklist.json` C35 状态从 `partial` 改 `done`，并回写 `work-project.md` §3.3。若 §6 第三档触发，另开例外单并把 C35 记 `waived`。
