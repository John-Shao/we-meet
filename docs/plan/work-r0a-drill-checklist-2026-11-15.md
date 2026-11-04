# 11-15/16 演练清单（C03+C22 四项 + C13 轮换 + C28 开关 + #31 双形状条件项）

> 状态：**待执行**。U3 九项已于 2026-10-27 全部确认；本清单把原 `work-r0a-c03-u3-drills-2026-10-27.md` §2–§3 展开为可逐步执行的步骤，并挂入 C13 主密钥轮换、C28 租户开关、#31 契约扁平后的双形状过渡。
> 现场证据落位：[assets/.../drill-2026-11-15/](assets/work-r0a-ops-2026-10-25/drill-2026-11-15/README.md)（步号与本清单一致，含 `verdict.json` 模板）。
>
> **RB-05 边界**：本轮只验数据层与基础设施（PG、Temporal、Content Store、角色/密钥、配额、开关）；经 API/编排/Runtime 的端到端项移出本轮。
>
> 关联控制：C03 (start, blocking) / C22 (pilot, blocking) / C13 (pilot, blocking) / C28 (pilot, blocking)。  
> 关联文档：[D3 设计](work-r0a-orchestration-design-2026-10-25.md)、[运维 Runbook](work-operations-runbook-2026-10-25.md)、[U3 原清单](work-r0a-c03-u3-drills-2026-10-27.md)、[C03 签收条件](work-r0a-start-gate-disposition-2026-10-27.md) §C03。

## 0. 前置条件（11-06 环境预检通过 + 11-10 彩排）

| # | 条件 | 验证方式 | 负责人 | 截止 |
|---|---|---|---|---|
| P1 | Temporal ≥2 副本、namespace `work-r0a` 隔离 | `kubectl get pods -n temporal` 显示 ≥2 Ready | SRE | 11-06 |
| P2 | Temporal 独立 PG + 专用角色，与 Work 业务库分离 | 连接串 `host` 不同、角色名不含 `work_api` | DBA | 11-06 |
| P3 | mTLS 7233 仅内网可达 | `openssl s_client -connect :7233` 成功；外网 22.22 不通 | SRE | 11-06 |
| P4 | 配额可调（D4 用） | `temporal operator namespace update -rd` 能改 retention/rate | SRE | 11-06 |
| P5 | Content Store 独立演练桶 + 最小权限凭证 | `ls` 桶内演练前缀可写、其他前缀拒绝 | 后端 | 11-06 |
| P6 | Kill switch 可操作（D3-N06） | 以授权角色 psql 调 `SELECT work.apply_execution_entitlement(...)`（SQL 函数，非 CLI）可改 `work.org.operator_suspended`；先按签名试算确认可执行 | 后端 | 11-06 |
| P7 | 两个 Worker 版本镜像（D2） | registry tag `worker:v1-s2` / `worker:v2-s2` 存在 | 平台 | 11-06 |
| P8 | `WORK_CONTENT_MASTER_KEY` 环境变量注入通道就绪（C13）——**2026-11-04：按 A，本项不再是演练前置**，主密钥不换、不注入新 key；保留本行只作 11-06 预检时的现状确认（当前 key 可读、文件不入库） | 进程 env 可读，文件不入库 | 后端 | 11-06 |
| P9 | 租户开通/停用的**已接线**闸门可操作（C28）——**2026-11-04 #46=A 裁定**：目录同步按 Host 报的 `status=active` 自动置 `execution_enabled=true` **即设计**，不加 Work 侧独立开关；试点期以「首批组织开通时人工确认 `status` 三列现值」作过渡控制（本行判据含此项） | `work.org` 的 `status/execution_enabled/operator_suspended` 三列可读可改（`tenant_access` 列无代码消费者，不作判据） | SQL 读值 | 后端 | 11-10 |
| P10 | 在途 Run 种子：1 个 waiting + 1 个 running（**2026-11-04 #51 已裁 A：机制与时点定如下**——用主机上的 `work-e2e-seed -org <org> -actor <active owner subject> -goal <文本>` 造，它走与 `POST /work/v1/tasks` 相同的领域函数、不绕过授权；**在演练当天上午现造现演现清**，不在 11-10 彩排后把 held 预留挂多日，#11 那类 stale run 正是这样积起来的。两条实测前提：该二进制只在 `/usr/local/bin`、**不在发布包内**（任务 #54）；`quota_account` 目前只有 `2026-10` 周期行，当天要确认新周期行是首笔预留时懒建还是缺建） | `SELECT run_id, state FROM work.run WHERE ...` ≥2 | 后端 | 11-10 彩排后；造 Run 在 11-15 上午。**#54=B（2026-11-04）seed 的可重放步骤**：演练前一天在仓库根构建`(cd src/work && go build -o /tmp/work-e2e-seed ./cmd/work-e2e-seed)`，`sha256sum` 记入 `verdict.json` 的 `P10.evidence`，经 meet 侧跳板上传到 Work 机 `/usr/local/bin/work-e2e-seed`（主机那份是历史手工件、**不在发布包内**，见 #54），演练后**保留**并在 `notes` 记明保留理由；不接受「主机上有一个来路不明的二进制」作为演练前置通过。
| P11 | 五席 + SRE/DBA 真名确认 | 填 §附录 A 表 | 平台 | 11-06 |

任一 P 未通过 → 改期并通知 DR2。

## 1. 11-15 上午 09:30–12:00 · D1 多节点拓扑滚动重启 server

**目标**：Temporal server ≥2 副本下滚动重启，验证在途 workflow 无重复派发、无第二个 Run。

| 步 | 动作 | 通过判据 | 证据 |
|---|---|---|---|
| D1-1 | 确认 Temporal 2 副本 `Running`，记录 pod name/IP | 两副本 Ready，namespace=work-r0a | `kubectl get pods -o wide` 截图 |
| D1-2 | 提交种子 Run（模板 A），状态转 `running` | `work.run.state='running'`，Temporal history 有 WorkflowExecutionStarted | psql + temporal CLI |
| D1-3 | 滚动重启 replica-1（delete pod → 等重建 → Ready） | pod 重建后 `temporal operator cluster health` 绿 | `kubectl logs --previous` |
| D1-4 | 观察 `work.run` 状态变化 | 无新 Run 被创建、原 Run `running` 不跳 `failed`；`work.operation` 无重复行 | 以 superuser（`runuser -u postgres -- psql -d work`）**或已 `SET app.org_id` 的会话**执行 `SELECT count(*) FROM work.run WHERE ...` 不变——`work.run` 是 FORCE RLS 表，不设租户就直接数到 0 |
| D1-5 | 滚动重启 replica-2 | 同 D1-3 | logs 截图 |
| D1-6 | 等待种子 Run 自然结束或 cancel | Run 终态 `succeeded`/`cancelled` 可读可取消 | Run detail 查询 |
| D1-7 | 核对 dispatching 计数 | `work.outbox` 内该 Run 事件不重复、`claimed_by` 最多一次 `completed` | SQL + 时间戳 |

**失败处理**：若出现重复派发 → 记录到 `verdict.md`【落点已对齐：模板实际落点是本目录 `verdict.json` 的对应步行（`verdict`/`ts`/`evidence`/`notes`）加 `attachments/<step-id>-<kind>.<ext>`；§10 里 `drills/2026-11-15-*/verdict.md` 那棵树从未创建】 为 **D1 FAIL**；不阻塞下午 D2，但 C03 不签。

**关联控制**：C22 S1 多节点 / C03 A1 承诺验证。

## 2. 11-15 下午 14:00–17:00 · D2 Worker drain → 版本切换 → 恢复

**目标**：drain 旧 worker → 部署新版本 → 验证旧 workflow 行为不变、新 Run 走新版本、无丢活动。

| 步 | 动作 | 通过判据 | 证据 |
|---|---|---|---|
| D2-1 | 确认当前 worker 版本 tag（v1），在途 Run 种子正在执行 activity | Run state=running，activity 进度可读 | worker 日志 |
| D2-2 | Drain worker v1：停止领取新 task，等已领取 activity 完成（窗口 ≥15 min） | `temporal taskqueue describe` pending=0；无新 activity 被 v1 领取 | drain 日志 + taskqueue describe 截图 |
| D2-3 | 部署 worker v2（同 namespace、同 task queue） | v2 pod Ready，日志显示 polling | `kubectl logs` |
| D2-4 | 验证在途 Run（v1 启动的 workflow）继续完成 | 该 Run 使用 v1 版本行为完成（对比 workflow type/version pinning）；activity 不丢失 | Run history + `work.operation` 逐条核对 |
| D2-5 | 提交新种子 Run B | 被 v2 worker 领取，日志含 v2 tag | worker 日志 + Run state |
| D2-6 | 恢复 drain 关闭（v1 若仍存在需确认不领取新任务） | v1 不再领取新 workflow | taskqueue describe |
| D2-7 | 核对 v1→v2 切换期间无 lost activity | `work.operation` 中无 `unknown` 状态超过 15 min；无 orphan dispatch | SQL + 时间戳 |

**关联控制**：C22 worker drain/版本切换 / C03 A5 维护窗口。

## 3. 11-15 17:00–18:00 · S1-R06 多节点在途 server 重启（补跑）

**目标**：复用 D1 环境，验证 `systemctl restart` 级别（单进程崩溃）的 Temporal server 重启，在途 workflow 正确恢复。

| 步 | 动作 | 通过判据 | 证据 |
|---|---|---|---|
| S1-1 | 提交种子 Run C，确认 Temporal history 有 WorkflowExecutionStarted + activity started | 同 D1-2 | temporal CLI |
| S1-2 | `kill -9` 一个 Temporal server 进程（模拟 crash） | 进程消失、systemd restart 拉起 | `journalctl -u temporal` |
| S1-3 | 等待 Run C 恢复或完成 | Run C 终态正确（succeeded / cancelled）；无第二个 Run | `work.run` 查询 |
| S1-4 | 对比 file-backed dev 的 R06 结论 | 行为一致：已完成 workflow 不重放 | 记录差异 |

**关联控制**：C22 S1-R06 / C03 关闭条件 §4(4)。

## 4. 11-16 上午 09:30–12:00 · D3 Temporal PG 故障/恢复

**目标**：杀死 Temporal 的 PG → 观察 relay 积压 → 恢复 PG → 按租约继续 → 业务账本不变。

| 步 | 动作 | 通过判据 | 证据 |
|---|---|---|---|
| D3-1 | 记录当前 `work.outbox` 未投递计数 | `SELECT count(*) WHERE delivered_at IS NULL` → 基线值 N | SQL |
| D3-2 | `systemctl stop temporal-postgresql`（或 kill PG） | Temporal 开始报错（frontend health 变红） | PG 日志 + Temporal 日志 |
| D3-3 | 等待 2–5 min，观察 Work outbox 积压增长 | 积压 > N 但 `work.run.state` 不变（无新派发成功也无丢失） | relay 日志 + outbox 曲线 |
| D3-4 | `systemctl start temporal-postgresql` | Temporal 恢复 health 绿 | PG 日志 |
| D3-5 | 等待 relay 追赶积压 | outbox 未投递数回到 ≤N 或继续正常投递 | SQL + 时间戳 |
| D3-6 | 核对业务账本 | `work.run` / `work.operation` / `work.task_event` 无新增异常行；`work.quota_account` held 值不变 | 逐表 count + checksum |

**关联控制**：C22 Temporal PG 故障 / C03 A2/A4。

## 5. 11-16 下午 14:00–15:30 · D4 配额打满 + D3-N06 开关

**目标**：namespace 配额饱和 → 新提交受控失败 → 已有 Run 不被误杀 → kill switch 操作 → 义务不停。

| 步 | 动作 | 通过判据 | 证据 |
|---|---|---|---|
| D4-1 | 记录当前 namespace 配额值 | `temporal operator namespace describe` 输出 | CLI 截图 |
| D4-2 | 降低配额（rate limit / concurrent workflows）至种子 Run 数 -1 | 配额调低成功 | CLI |
| D4-3 | 提交新 Run → 应受控失败 | 返回错误码为已定义的 `quota_exhausted`（`run_cap_exceeded`→`quota_exhausted` 映射）或 `rate_limited`；不产生 `work.run` 新行。**注：`outbox_backlog` 不是错误码目录里的码（取证：contracts/error-codes.json 无此码），勿写进判据** | API 响应 + SQL |
| D4-4 | 已有 Run 不被误杀 | 种子 Run 仍 running/succeeded | `work.run.state` |
| D4-5 | 恢复配额 | namespace describe 恢复原值 | CLI |
| D4-6a | 执行 kill switch：以授权角色经 **psql SQL** 调 `SELECT work.apply_execution_entitlement(...)`（0023/0027 定义的 SQL 函数，非 CLI、无 `--suspend` 标志；R0a 无对应 admin 端点，演练按签名直接 SQL 调用） | `work.org.operator_suspended = true`（列在 **org** 表，非 org_policy）；新导出请求 409 `org_operator_suspended`；管理读面仍 200 | psql SQL + API |
| D4-6b | 验证义务不停：到期清扫仍运行，relay 仍投递 `content_shred` | 日志显示 `expire_due_inputs` / `shred_due_audit_exports` 各处理 1；relay 投递 | relay 日志 |
| D4-6c | 解除开关，验证恢复 | `operator_suspended = false`；后续导出恢复 | SQL + API |

**关联控制**：C22 / C03 §3 D3-N06 / D4 配额承诺。

## 6. 11-16 下午 15:30–16:30 · C13 主密钥（按 A：只跑 C13-0 前置审计，其余移出本次演练）

**目标**：在真实环境执行 Content Store 主密钥轮换，验证双版本读取窗口与全量重加密。（2026-11-03 裁定 A 后本节实际只执行 C13-0 审计；原目标保留不删，供重开时恢复。）

> **按代码取证修正（2026-11-03，勿照旧步骤空跑）**：`internal/content/local.go` 的 `deriveKey(l.master, orgID)` **只用当前主密钥**解密；ref 里的 `?v=<keyVersion>` 只是元数据（`Get` 对版本不符也照常返回明文，不尝试另一把 master），且 `content.NewLocal(..., 1)` 固定 keyVersion、全仓无 bump 驱动。`credentials.go` 亦为"单 master + 离线重加密"。**结论：不存在在线双 master 读取窗口**——先在配置里换成新 `WORK_CONTENT_MASTER_KEY` 再重加密，会让所有既有 Content Store 对象 GCM auth-tag 失败。因此 C13 主密钥轮换是**维护窗口内的离线重加密**，不是注入 `WORK_CONTENT_MASTER_KEY_NEXT` 的热切换（旧步骤里这个 env 名代码根本不读，已删）。
>
> **前置判定（已按代码取证，非推测）**：主密钥轮换驱动**未实现**。证据：① 8 个 `content.NewLocal(key, dir, 1)` 调用方（work-api/content-proxy/e2e-seed/egress/export/reconcile/relay/worker）全部硬编码 keyVersion=1，无一处传不同版本；② `cmd/` 内无任何 content 重加密命令；③ `local.go:144` 的 `if version != l.keyVersion` 两条分支都 `return plaintext, nil`，且解密恒用 `deriveKey(l.master, orgID)`——所谓"双版本读取窗口"既不是跨 master 读、也没有驱动它换版本的入口。结论：不存在安全的主密钥轮换路径；先换新 `WORK_CONTENT_MASTER_KEY` 会让全部既有对象 GCM 解密失败。
>
> **裁定 A（2026-11-03，John）：R0a 试点期不执行主密钥轮换。** 权威记录在 `pilot-checklist.json` C13 note 与 task #40：试点期用单主密钥，"密钥轮换/重加密驱动"移出 R0a 退出门、记为带重开条件的范围例外；重开条件＝>3 组织/规模化前、疑似主密钥泄露需轮换、接入对象存储后端时。因此本次 11-16 下午不演练 C13：C13-2..C13-8 移出清单（不"记 blocked"、也不空跑），只保留 C13-0 作为审计确认（"驱动不存在"→ 与 A 一致：不需要）。
>
> **2026-11-04 消歧（不改上面原文）**：上面点名 `C13-2..C13-8`，本节标题与 [drill README:37](assets/work-r0a-ops-2026-10-25/drill-2026-11-15/README.md) 取 `C13-1..C13-8`——差的 C13-1 是轮换流程的指纹步，A 下同样没有执行理由。**以「只执行 C13-0、其余不执行」为准**，下表逐行标注；`verdict.json` 的 `excluded_by_ruling_A` 已按这一读法记账，删行不做是为了保住与 drill 目录的步号对齐（README:3 承诺）。

| 步 | 动作 | 通过判据 | 证据 |
|---|---|---|---|
| C13-0 | 前置判定：是否存在主密钥离线重加密驱动（命令/工具），若无则本演练记 blocked（**2026-11-04 按 A 修正**：判定取「无」即与裁定一致，**不记 blocked**，改记带重开条件的范围例外——见上面裁定段与 `pilot-checklist.json` C13 note、drill README:37） | 有可执行的旧读→新写重加密入口 / 无（当前代码事实：无） | 代码检索结论 + `verdict.md`【落点已对齐：模板实际落点是本目录 `verdict.json` 的对应步行（`verdict`/`ts`/`evidence`/`notes`）加 `attachments/<step-id>-<kind>.<ext>`；§10 里 `drills/2026-11-15-*/verdict.md` 那棵树从未创建】 |
| C13-1 | **不执行（按 A 移出）**——记录当前 `WORK_CONTENT_MASTER_KEY` 指纹（SHA-256 前 8 字节），不输出密钥本身 | 不跑，无判据 | `verdict.json` 的 `excluded_by_ruling_A` |
| C13-2 | **不执行（按 A 移出）**——生成新主密钥（32 字节），暂存 root-only 文件，**不改运行配置** | 不跑，无判据 | `verdict.json` 的 `excluded_by_ruling_A` |
| C13-3 | **不执行（按 A 移出）**——在旧 key 仍生效时，逐 org 把 Content Store 对象旧读→以新 key 重加密落盘；逐 org `work-provider-setup rotate` 重加密 `work.provider_credential` | 不跑，无判据（且无驱动可跑，见上面取证段） | `verdict.json` 的 `excluded_by_ruling_A` |
| C13-4 | **不执行（按 A 移出）**——切换 `WORK_CONTENT_MASTER_KEY` → 新密钥；`systemctl restart work-api`、`work-directory-sync`、`work-relay` | 不跑，无判据（先换 key 会让既有对象 GCM 解密失败） | `verdict.json` 的 `excluded_by_ruling_A` |
| C13-5 | **不执行（按 A 移出）**——全量读校验：所有在册 Content Store 对象与凭据在**新 key 下**可解（证明重加密完整、无孤儿对象） | 不跑，无判据 | `verdict.json` 的 `excluded_by_ruling_A` |
| C13-6 | **不执行（按 A 移出）**——安全边界：确认旧 key 已无法解密新写入对象（GCM tag mismatch） | 不跑，无判据 | `verdict.json` 的 `excluded_by_ruling_A` |
| C13-7 | **不执行（按 A 移出）**——回归：一次 provider call 成功 + usage 结算 + artifact 发布读回哈希一致 | 不跑，无判据（日常 Run 回归由 D1/D2 段覆盖） | `verdict.json` 的 `excluded_by_ruling_A` |
| C13-8 | **不执行（按 A 移出）**——销毁旧 key 离线文件 | 不跑，无判据（无新 key 产生，无旧 key 文件待销毁） | `verdict.json` 的 `excluded_by_ruling_A` |

**边界说明**：D-03 B 定为静态单层加密、不用云 KMS/HSM；本演练覆盖其**主密钥离线重加密**流程（先账本/内容重加密、后换运行 key），非热切换。provider credential 的 `key_version` 是同一 master 下的重加密标签，2026-10-31 已单独演过（Runbook §5.15），本步是 master 层面。

**关联控制**：若 C13-0 判定无重加密驱动 → C13 演练 blocked，note 从"密钥轮换未在真实环境演练"更正为"主密钥轮换驱动未实现（仅单 key 读写）"，残余不止"对象存储后端/规模化擦除"。**（2026-11-04：这一分支已经落地，但走向不是本段写的 blocked——2026-11-03 取证判定「无驱动」，John 随即裁 A 把轮换移出 R0a 退出门，note 记的是带重开条件的范围例外、`C13.status` 保持 `partial`；本段原句保留供追溯，执行当天按上面裁定段与 drill README:37 办。）**

## 7. 11-16 下午 16:30–17:00 · C28 租户开关切换演练

**目标**：在生产环境启用 tenant-access org flag → 验证 cutover → 验证 legacy notice → 验证 rollback。（**2026-11-04 就地提示，勿只读这行**：下面 2026-11-03 的取证更正才是当前事实——`tenant_access` 有列但 `internal/`/`cmd/` 无任何 Go 代码读取，拿它判「新租户可访问」是空跑。本节实际执行的是 C28-1..7：按 `work.org.status` + `execution_enabled` + `operator_suspended` 三列演开通/停用/计时/回滚，legacy notice 那一步仍按原样验。「按 status 自动置 `execution_enabled` 是否符合 tenant-access 的意图」正是 #46 待裁的问题，裁前不改变本节动作。）

| 步 | 动作 | 通过判据 | 证据 |
|---|---|---|---|
> **取证更正**：`tenant_access` 在 schema 里有列，但**无任何 Go 代码读取**（`internal/`/`cmd/` grep 零命中），切换它对访问控制无效果——原 C28 步骤凭它判"新租户可访问"是空跑。R0a 真正的租户开通/停用闸门是 `work.org.status` + `execution_enabled` + `operator_suspended`，且已被 `audit_export_gate_pg_test.go` 钉死（execution_enabled=false→403 `org_execution_unavailable`；operator_suspended=true→409 `org_operator_suspended`；status≠active→403）。C28 演练据此改造。

| 步 | 动作 | 通过判据 | 证据 |
|---|---|---|---|
| C28-1 | 记录目标 org 的 `status / execution_enabled / operator_suspended` 现值 | 三列值明确（演练后须复原） | SQL `SELECT ... FROM work.org WHERE id=...` |
| C28-2 | 开通：置 `status='active' AND execution_enabled=true AND operator_suspended=false` | bootstrap 200、`/work/` 路由可用、可 submit 得 202 | HTTP + `work.run` |
| C28-3 | 旧链接验证 legacy notice | `GET /work?task=<old-id>` → 302 到 `/work/archive?legacyTask=...` → 只读 notice 页 | 浏览器截图 |
| C28-4 | 停用：置 `execution_enabled=false` | 新写路径 403 `org_execution_unavailable`；已有 Run 可读取 | HTTP + SQL |
| C28-5 | 计时 cutover 端到端（开通→可用；停用→拒） | 单向往返 ≤ 15 min（含 systemd/缓存生效） | 时间戳记录 |
| C28-6 | Rollback：恢复 C28-1 记录的原值 | 行为回到演练前；旧链接仍走 legacy notice | SQL + HTTP |
| C28-7 | 复原并核对三列与 C28-1 一致 | 与初始值相同 | SQL |

**关联控制**：C28 关闭条件「flag 未在生产启用、无端到端切换计时」。本演练改用**已接线的** org 执行开关验证翻转与回滚（`tenant_access` 若将来要做租户准入，须先补代码消费者，另记）。

## 8. 11-16 下午 17:00–17:30 · #31 双形状过渡验证（条件项）

**触发条件**：仅当 #31（preview/submit 请求体扁平化）在 11-15/16 前有未发布到生产的新版本时执行；若生产已是扁平形状则跳过并记录「不适用」。

**目标**：滚动部署期间新旧形状共存不导致请求失败或数据不一致。

| 步 | 动作 | 通过判据 | 证据 |
|---|---|---|---|
| T-31-1 | 确认生产 `work-api` 已部署 #31 后的扁平 schema（或待部署的 staging 版本） | `GET /openapi.json` 的 input/preview schema 无 `intent` 嵌套 | curl + jq |
| T-31-2 | 用旧形状（嵌套 intent）提交 preview | 应 400 拒绝（不产生脏数据）或兼容层正常解析 — 取决于 #31 的 A 案决定：已删 R0aIntent → 400 | HTTP 响应码 |
| T-31-3 | 用新扁平形状提交 preview → submit | 202 + Run 正常创建 | HTTP 响应 + `work.run` |
| T-31-4 | 滚动重启一个 API 实例 | 无 in-flight 请求 5xx | API 日志 |
| T-31-5 | 若 T-31-2 返回 400 → 记录为「预期拒绝，客户端已对齐」；若返回 202 → 记录为「兼容窗口仍开放」 | 判定写入 `verdict.md`【落点已对齐：模板实际落点是本目录 `verdict.json` 的对应步行（`verdict`/`ts`/`evidence`/`notes`）加 `attachments/<step-id>-<kind>.<ext>`；§10 里 `drills/2026-11-15-*/verdict.md` 那棵树从未创建】 | — |

**RB-05 边界**：本步只验数据层（请求是否能正确入库），不验经编排/Runtime 的端到端路径。API 层的 OpenAPI 契约测试（字段级门禁 `ops-model.test.mjs`）已在 CI 覆盖。

**关联控制**：#31 已执行，无 C 编号；挂本清单为过渡安全网。若生产已完全对齐则本步跳过。

## 9. 11-16 17:30–18:00 · D3-N01/N03 进程级 kill 复跑

**目标**：在真实 Content Store 桶环境复跑已在测试层验证的崩溃用例，补上「部署环境」维度。

| 步 | 动作 | 通过判据 | 证据 |
|---|---|---|---|
| N01-1 | 启动 relay 进程，投递 `content_shred` 事件 | relay 正常处理 1 笔后 SIGKILL（两笔之间） | `kill -9` + 时间戳 |
| N01-2 | 验证副本接管 | 租约活着时副本拿 0 事件；`claimed_until` 到期后重领并一次投递 | relay 日志 + SQL |
| N01-3 | 验证重投递容忍已消失的对象 | `ErrNotExist` 不产生 `content_delete_failed` | 日志 |
| N03-1 | 启动 export worker，写完文件后 SIGKILL | 旧持有者 `audit_export_lease_lost`；单 content_ref、无重复对象 | 桶内文件数 + audit 表 |

**与测试层的关系**：测试层已在 2026-11-02 验证通过（`lease_crash_test.go`、`cmd/work-export/lease_crash_test.go`），本步是在**真实 systemd/容器进程 + 真实 Content Store 桶**下复跑同等断言，补的是「部署形态」证据。

**关联控制**：C03 §4(3) D3-N01/N03 真实环境注入。

## 10. 证据落盘

每场演练目录结构（按已有约定）：

```
docs/plan/assets/work-r0a-ops-2026-10-25/drills/
├── 2026-11-15-d1/
│   ├── timeline.md        # 时间线（精确到秒）
│   ├── commands.log       # 执行的命令（脱敏）
│   ├── metrics/           # 截图 / SQL 输出 / 日志片段
│   └── verdict.md         # PASS / FAIL / GAP 判定
├── 2026-11-15-d2/
├── 2026-11-15-s1r06/
├── 2026-11-16-d3/
├── 2026-11-16-d4-n06/
├── 2026-11-16-c13/
├── 2026-11-16-c28/
├── 2026-11-16-dual-shape/  # 若执行
└── 2026-11-16-n01n03/
```

> 【落点已对齐：§10 落点与交付模板对齐（2026-11-04）】上面这棵 `drills/2026-11-15-*`／`verdict.md` 的树是 2026-10-27 定的旧约定，**从未创建**。本次演练的实际载体是 [drill-2026-11-15](assets/work-r0a-ops-2026-10-25/drill-2026-11-15/README.md)：结果填 `verdict.json` 的 69 个步行（含本轮补入的 `T-31-1..5`），截图/日志/SQL 片段按 `attachments/<step-id>-<kind>.<ext>` 命名放 `attachments/`，`evidence` 里只写相对路径；环境快照与结论写在该 README 的两节里。时间线、命令与脱敏要求照旧适用于这些附件（下面的 S18 规则不变）。若演练当天仍要另建 `drills/` 树，先把它加进 `verdict.json` 的 `evidence` 路径，别让两处证据各写一半。

脱敏规则（S18）：不含密钥正文、不含客户数据、不含 `WORK_CONTENT_MASTER_KEY` 值本身；只允许指纹前 8 字节。

## 11. 关闭条件与回写

| 条件 | 满足后操作 |
|---|---|
| D1 + D2 + S1-R06 全 PASS | C22 evidence 添加「多节点拓扑、在途重启、worker drain 实测 2026-11-15」 |
| D3 + D4 全 PASS | C22 evidence 添加「Temporal PG 故障恢复、配额饱和实测 2026-11-16」；C22 status → `done` |
| D3-N01/N03/N06 真实环境 PASS | C03 §4(3) 满足 |
| C13-0 判定驱动存在 → C13-1..8 全 PASS | **（2026-11-04 按 A 标为不适用）**本行原为「C13 note 更新：『主密钥轮换已于真实环境演练通过』；残余改为对象存储后端」——2026-11-03 取证判定驱动不存在且不存在安全轮换路径，裁定 A 又把轮换移出 R0a 退出门，故这一支路本次演练不可能走到 |
| C13-0 判定驱动不存在（当前证据） | **（2026-11-04 更正）**本行原文写「C13 演 **blocked**，不签『演练通过』；按 #40 走 A/B/C 决策后再定 C13 定性」。#40 已于 2026-11-03 裁 A 定案：不跑 C13-1..8、**不记 blocked**，`pilot-checklist.json` C13 记带重开条件的范围例外、`status` 保持 `partial`；演练当天只把 C13-0 的审计结论落进 `verdict.json` |
| C28-1 至 C28-7 全 PASS 且 ≤15 min | C28 evidence 添加计时记录；note 改为「flag 已验证翻转与回滚」 |
| 第 8 节 `T-31-*` 触发且 T-31-2 判定完成（条件项：仅当 #31 有未发布到生产的新版本） | 判定写入 `verdict.json` 的 `T-31-5.notes`；不触发则五格全填 `na` 并记「生产已是扁平形状，不适用」——**2026-11-04 补**：这五行原本不存在，`T-31-1..5` 只在第 8 节有步骤表、回写映射与模板都没有落点 |
| §4 全部满足（U3 + D1–D4 + N01/N03 + S1） | C03 status → `done`，DR2 签收 |

签收后回写：[U3 单](work-r0a-temporal-hosting-decision-request-2026-10-26.md) §9、[D3 §4.1](work-r0a-orchestration-design-2026-10-25.md)、[work-project](work-project.md) §3.3、`pilot-checklist.json`。

## 附录 A：五席 + 到场角色

| 日期 | 时段 | 场景 | 指挥 | 驱动 A | 驱动 B | 记录员 | 证据员 | SRE | DBA |
|---|---|---|---|---|---|---|---|---|---|
| 11-15 | 09:30–12:00 | D1 | | | | | | ✓ | |
| 11-15 | 14:00–17:00 | D2 | | | | | | ✓ | |
| 11-15 | 17:00–18:00 | S1-R06 | | | | | | ✓ | |
| 11-16 | 09:30–12:00 | D3 | | | | | | | ✓ |
| 11-16 | 14:00–15:30 | D4+N06 | | | | | | ✓ | |
| 11-16 | 15:30–16:30 | C13（按 A：只做 C13-0 审计，其余时段还给 D4/N 复跑） | | | | | | | |
| 11-16 | 16:30–17:00 | C28 | | | | | | | |
| 11-16 | 17:00–17:30 | #31 双形状（条件） | | | | | | | |
| 11-16 | 17:30–18:00 | N01/N03 | | | | | | | |

## 附录 B：失败影响矩阵

| 场景 | 失败后果 | 是否阻塞 C03 | 补救路径 |
|---|---|---|---|
| D1 重复派发 | 故障矩阵 §4.2 假设不成立 | **是** | 排查 Temporal sticky cache / outbox 去重逻辑；改期重跑 |
| D2 丢活动 | Activity 在 drain 窗口丢失 | **是** | 排查 worker graceful shutdown 顺序；改期重跑 |
| S1-R06 重启失败 | 单节点恢复不成立 | **是** | C03 延到 DR4 前补签 |
| D3 账本变化 | 业务数据完整性受损 | **是** | 紧急回滚 + DBA 核对；记录事件 |
| D4 已有 Run 被杀 | 配额实现有误杀 bug | **是** | 修 namespace 配置 / Temporal bug；改期重跑 |
| C13 轮换后解密失败 | 凭据/Content Store 不可用 | 否（只影响 C13） | **2026-11-04：本行已不可触发**——按 A 不执行轮换，这一失败模式不在本次演练路径内（原补救「恢复旧密钥文件；排查派生逻辑」保留，供重开轮换时参考；重开条件见 `pilot-checklist.json` C13 note） |
| C28 切换超时 >15 min | 试点 SLA 无依据 | 否（只影响 C28） | 记录实际耗时为约束基线 |
| N01/N03 与测试层结果不一致 | 部署环境有额外因素 | **是**（C03 §4(3)） | 对比测试层与部署层配置差异 |

## 附录 C：生产 DB/Temporal 升级步骤（作为 D2 版本切换的框架参考）

Runbook §2.1–§2.3 的滚动升级流程在演练中的映射：

| Runbook 步骤 | 演练映射 |
|---|---|
| §2.1 发布前 golden tasks | D2-1 的 Run 种子即简化版 golden task |
| §2.1 DB expand/contract | D3 恢复后核对 schema 不变（§2.1 禁止破坏性迁移） |
| §2.2 步骤 1 暂停新 Run 调度 | D2-2 drain 期间的入口暂停 |
| §2.2 步骤 2 排空旧 Worker | D2-2 核心 |
| §2.2 步骤 3 部署新镜像 canary | D2-3 部署 v2 |
| §2.2 步骤 4 恢复调度 + 锁定旧队列 | D2-5 + D2-6 |
| §2.3 回滚 | C28-6 rollback 路径 |

生产 Temporal 升级（如 1.25→1.26）作为独立窗口安排，不在本轮演练范围；D2 的 worker 版本切换已验证「不迁移半轮状态」的原则。
