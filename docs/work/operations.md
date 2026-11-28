# Work 运维手册（精简操作入口）

> 本文档是 Work 模块的精简操作入口：只保留"执行什么、按什么顺序、如何判定"。
> 详细参考仍是旧 runbook（架构、裁定史、故障注入与逐次取证都在那里，本文不复述）：
>
> - [work-operations-runbook-2026-10-25.md](ops/work-operations-runbook-2026-10-25.md)：升级/灾备/SLO/故障注入，§5.x 是各专题值班口径。
> - [work-r0a-pilot-operations-runbook-2026-10-26.md](ops/work-r0a-pilot-operations-runbook-2026-10-26.md)：试点运营（支持分级、删除、死信、切换）。
>
> 命令与本文冲突时，以仓库脚本/unit 为准：`src/work/deploy/ecs/`、`src/work/scripts/`、`deploy/aliyun/`。

## 0. 现状快照与操作纪律

现状（2026-11-27 已核实；执行任何写操作前先现场重读）：

- 现网最新包 `work-release-0062-c73adea2a`，迁移台账 `tip_version=62`。
- 已裁 rollout 包＝增量 0040–0062（39→62），已于 2026-11-24 分两步执行完成：先 `--migrations-only`，再 `--enable-advance` 换 worker／api 并落 V／W／Y；两步均 rc=0。修正版官方 verifier 已随新包复跑 rc=0；真实供应商 E2E、J39、C13 仍未闭合，详见下文与 [status.json](status.json)。
  - **2026-11-22 重切裁定（主签四项单选＝R1 甲／R2 甲／R3 乙／R4 丙，加两步排程与在途 Run 处置各甲；上条裁定内容保留，现状数字以本条与下文为准）**：包范围改为**整包 0040–0062（39→62）一次**，理由＝包尾不是可配参数（`make-release.sh:90` 从 `migrations/increments` 现读推导链尾，`verify-r0a-0027.sh:100` 已钉到 `(62,'0062_run_history_handback')`，`work-api.service:14-15` 的 `Requires=work-chain-check.service` 由 `work-migrate status -require-up-to-date` 判定"该二进制所携带链尾"），照 39→45 字面执行只能从旧 commit 出包、等于把几周前代码投放现网。**排程＝同窗口两步、依次授权**：第一步 `--migrations-only`（备份＋装 work-migrate＋跑到 62，不换 worker/api），第二步同二进制重放预检全绿后再换 work-worker＋work-api 并落 V/W/Y 三件；`rollout-r0a-0027.sh:73-80` 禁止 `--migrations-only` 与 `--enable-advance`／`--runtime-bundle` 同用，故两步不可合并成一次调用，**两笔独立生产写授权**。**在途 Run＝先 drain 到零再换 worker**（脚本 `:332` 硬要求：新 worker 不能续跑旧在途 Run）。**本节"只跑 migration 即零现网影响"有一条例外，如实记**：0060 会 `CREATE OR REPLACE work.list_content_refs(text)`，而该函数是**在跑的**出口孤儿报表读路径在用（`internal/egressservice`），变化是纯增两节 UNION 读新表 `egress_output_recovery`（新 worker 未上线前恒空）⇒ 语义安全但不是零影响。**另一条新增硬前置（§3.4 第 4 条）**：`0055:80` 是 `ALTER TABLE work.device_dispatch ADD COLUMN permit jsonb NOT NULL` 且**无 DEFAULT**，现网该表若有任意行则整链在该步 23502 失败；必须**当场实测为空集**，不得按"设备面从未部署 ⇒ 应当为空"写进包。**W 的执行边界（并窗也并不到这一段）**：本脚本会装 `work-chain-check.service`（`:438`，并在 `:303-308` 带 secrets 不可读即中止的守卫，故 V 可随窗生效）、会装并重启 `work-authz`（`:389/414/417/422/441/447`，故 Y 的热加载可随窗成立），但 `install_env` 从未点名 `work-content-backup`，脚本内也没有它的 `.service/.timer/.py` 安装步 ⇒ **卡片 W 的备份三件仍无仓库安装出处**，本轮并窗只覆盖"发布闭包＋逐名 present/MISSING 校验＋work-api 安装步骤"这一段；三件要么另批补安装步（仓库改动，须单独授权），要么继续按"不得读宽"停在手工放置状态。**本节仍只登记裁定，不构成执行授权；该裁定当时现网 tip 仍 39，2026-11-24 的执行结果见下文。**
  - **2026-11-22 同日更正（卡片 W 重开批已落仓库；上条原文逐字保留）**：上条"W 的执行边界"里"`install_env` 从未点名 `work-content-backup`、脚本内也没有它的 `.service/.timer/.py` 安装步 ⇒ 三件仍无仓库安装出处"这句自今天起过期——三件已逐字节回植并有逐名安装步与 `.bak` 保留，`enable`／`start` 各一行，判读以本条与 §5.4 的同日更正条为准。对第二步窗口的影响：V/W/Y 三件现在都有仓库安装出处，"并窗"覆盖到备份三件；但**这不改变两步排程**（`:73-80` 的互斥与 drain 要求照旧），也不构成任何执行授权。备份三件的新边界是"依赖仍在仓库外"（`/opt/meet-db-backup/backup` 模块＋`storage.json`／`recipient.txt`）与"主机哈希须现场取数"，两条都写在 §5.4。
- 八个核心 unit active；`work-directory-sync` 由 timer 驱动。
- Content Store 为本地 pilot，零真实请求；云 KMS 未接（C13 未关闭）。
- E8 试点未开始；**不允许真实客户数据**。

纪律：

- 本文命令标注 **[只读]** 或 **[生产写]**。生产写需逐项授权（主签/工单）；裁定不含执行授权。
- 人工数据操作只走 D1 领域函数（SECURITY DEFINER＋审计），禁止直接 UPDATE 业务表、禁止改 outbox payload。
- 工单可回查：`ticket_ref` 匹配 `^[A-Z][A-Z0-9]+-[0-9]+$`，理由去空格 ≥4 字符且过 `work.reason_code` 白名单；禁止占位值。
- RLS：`work` schema 全部租户表 ENABLE＋FORCE ROW LEVEL SECURITY，对 owner 同样生效（表数随迁移链增长，以 `src/work/migrations/catalogs/` 链头现读为准，不手抄）。不 `SET app.org_id` 会读到 0 行，**零行≠无数据**。特权读用 `runuser -u postgres -- psql -d work`（superuser 绕过 RLS），或先显式设 `app.org_id`。
- 工单/聊天/复盘只用 org/task/run/operation ID 与错误码，不贴正文、标题、Key。

## 1. 部署单元与发布链

### 1.1 systemd 单元清单（Work ECS）

常驻 unit 均以 `work-control` 运行，env 在 `/etc/work/<name>.env`（root:work-control 640）。
unit 权威＝`src/work/deploy/ecs/*.service`（directory-sync 两个 unit 为主机自管，仓库只有 env 模板）。

| Unit | 职责 | 监听 | env 文件 |
|---|---|---|---|
| work-api.service | 控制面 API | 127.0.0.1:8080 | work-api.env |
| work-worker.service | RunWorkflow worker | 无 | work-worker.env |
| work-relay.service | outbox 唯一消费者 | 无 | work-relay.env |
| work-authz.service | 执行授权 mTLS RPC | 127.0.0.1:8443 | work-authz.env |
| work-content-proxy.service | runtime 内容代理 | 127.0.0.1:8444 | work-content-proxy.env |
| work-egress.service | 可信模型出口 | 127.0.0.1:8445 | work-egress.env |
| work-runtime.service | Node/Pi runtime（Node≥22，/opt/work/runtime） | 127.0.0.1:8446 | work-runtime.env |
| work-export.service | 审计导出 worker | 无 | work-worker.env＋work-export.env |
| work-directory-sync.service / -full.service | 目录投影同步（oneshot） | 无 | work-directory-sync.env |
| work-cancel.service | governance 取消意图消费者（oneshot，**生产写**） | 无 | work-worker.env＋work-cancel.env |
| work-governance-events.service | Host 治理事件拉取消费者（oneshot，**生产写**） | 无 | work-governance-events.env＋专用 mTLS 身份 |
| work-chain-check.service | 链尾启动闸（oneshot，root） | 无 | /root/work-secrets.env |

- `work-chain-check` 由 `work-api.service` 的 `Requires=` 拉起（卡片 V）；2026-11-24 第二步 rollout 已安装并在 `work-api` 启动时执行成功，2026-11-27 只读复审仍为 active 链尾闸。
- `work-cancel`（0057／GW16）：一次 oneshot＝对 `WORK_CANCEL_ORGS` 里每个 org 跑一轮有界消费（≤100 Task、≤500 意图），超量保持 pending 且 next_attempt 不变，下一轮继续。它是 work_worker，逐 org 设租户上下文，**没有跨组织 claim**；不发帧、不写 Run 终态，只进已登记的 cancel_requested 路径并写 relay 的 cancel_signal 交接。**安装链**：full rollout 在任何写入前要求 `/etc/work/work-cancel.env` 的 `WORK_CANCEL_ORGS` 与 `work.org` 全集逐项相等，随后安装 unit/timer、收紧 env 权限并 enable/start timer；空模板不会自动启用消费者。2026-11-27 现网仍缺这三件，须在下一场获授权的 full rollout 中部署。死信告警＝`cancellation_intent.dead_lettered` 审计行（照 outbox 先例），**无 gauge**；重放只能由 work_ops 调 `requeue_cancellation_dead_letter`，consumed 不可重开。
- `work-governance-events`（0068）：一次 oneshot 按 `WORK_GOVERNANCE_ORGS` 分页拉取 Host 治理命令事件，写本地 consumed/cursor 并执行已授权的席位恢复链。full rollout 写前要求 env 非空且无占位值、专用 `work_governance_events_login` 角色存在、客户端证书 CN 为 `work-governance-events`、cert/key/CA 可读、组织清单精确覆盖 `work.org` 全集；证书还必须是 `WORK_GOVERNANCE_CLIENT_CA` 直接签发、当前有效、带 clientAuth EKU 且与私钥匹配。随后安装 unit/timer、收紧 env 权限并 enable/start timer。官方 verifier 的 `work_governance_consumer` 在缺任一项时为 FALSE。2026-11-27 现网尚未安装该 unit/timer/env，部署仍须逐项授权。
- Temporal 在 k8s 侧（资产 `deploy/aliyun/temporal/`），worker/relay 经 mTLS 连 `WORK_TEMPORAL_ADDRESS`（模板值 10.43.147.249:7233，namespace `work-r0a`）。

Timer 清单（周期以 `systemctl list-timers` 现读为准）：

| Timer | 周期 | 性质 |
|---|---|---|
| work-healthcheck.timer | 每 2 分钟 | 只读探针＋邮件告警 |
| work-reconcile-scan.timer | 每 15 分钟 | 只读孤儿巡检 |
| work-runstream-scan.timer | 每 10 分钟 | 只读运行流读数 |
| work-retention-scan.timer | 每小时（Persistent） | **生产写：到期清扫＋粉碎投递** |
| work-c16-log-scan.timer | 每日（Persistent） | 只读日志扫描 |
| work-cancel.timer | 每 5s（oneshot，不重叠） | **生产写：消费 cancellation_intent→cancel_requested** |
| work-governance-events.timer | 每 10s（oneshot，不重叠） | **生产写：拉取 Host 治理事件并推进本地游标** |
| work-directory-sync.timer / -full.timer | 主机自管；设计值增量 300s/全量每日 | 生产写（投影） |
| meet-db-backup@work.timer | 每 6 小时（00/06/12/18:35＋≤10min 随机） | 备份上传 |
| meet-db-backup-check@work.timer | 每小时 | 备份校验 |
| meet-db-backup-notify@work.timer | 每分钟 | 邮件重试 |
| work-content-backup.timer | 每 6 小时（00/06/12/18:45 +08） | 内容备份（主机自管，§5.4） |

### 1.2 发布链：make-release → rollout → verify

1. **[本地] 构建**（工作站 Git Bash＋docker）：
   ```bash
   bash src/work/deploy/ecs/make-release.sh /tmp/work-release-00NN
   ```
   - 构建容器必须挂载本工作树（脚本按挂载自动推导，或显式 `GO_CONTAINER=… GO_WORKDIR=…`）；默认 work-go 挂的是主 checkout，拿错树会建出与包内增量不一致的二进制。
   - 包自述件：`RELEASE_COMMIT`、`RELEASE_DIRTY`、`MIGRATION_TAIL`（从 increments 文件名推导）、`BINARIES`（从 cmd/ 推导，13 个）、`SHA256SUMS`。
   - 工作树必须干净（`RELEASE_DIRTY=0`）；增量不在 stamped commit 里直接构建失败（除非显式 `WORK_ALLOW_UNSTAMPED_MIGRATIONS=1`）。
2. **[生产写] 上传解包**到主机后校验：`cd <发布目录> && sha256sum -c SHA256SUMS`，必须全 OK。
3. **[只读] 先 dry-run 读半径**：
   ```bash
   MIGRATOR_DATABASE_URL='postgresql://work_migrator_login:<口令>@127.0.0.1:5432/work' \
     ./rollout-r0a-0027.sh --release <发布目录> --dry-run
   ```
   口令只走环境变量（`--migrator-url` 已移除，argv 会进 ps/history）。
4. **[生产写] 正式 rollout**（root）：同上去掉 `--dry-run`。可选 `--migrations-only`（只装链，§3.3）、`--enable-advance`、`--runtime-bundle <tar.gz>`；后两者与 `--migrations-only` 互斥。
5. **[只读] 验收**：`sudo ./verify-r0a-0027.sh "<rollout 开始时刻>"`；退出码 0 且无 FALSE/MISSING。WARN 行是部署状态（如"包里有、主机未装"），不是失败。

rollout 内置闸（任一命中即中止，**不要绕过**）：账本探针读不出、账本比包内 `MIGRATION_TAIL` 新、`MIGRATION_TAIL`/`BINARIES` 缺失、SHA256 不一致、0027 重复治理回执 ≠0、包含 work-chain-check.service 但 `/root/work-secrets.env` 缺失。
半径读脚本自己打印的 `binaries this rollout … = N -> …` 行，不抄文档数字。

### 1.3 角色与 PKI（一次性/重建时）

```bash
# [生产写] 每集群一次：7 个 NOLOGIN 角色，幂等、从不 drop/alter 已有角色
DATABASE_URL=postgresql://… bash deploy/aliyun/apply-work-roles.sh
# [生产写] 0018/0023 之前：在解压后的发布目录创建 work_governance_events / work_operator 组角色（＋可选 login）
WORK_GOVERNANCE_EVENTS_PASSWORD=… [WORK_OPERATOR_PASSWORD=…] \
  ./provision-r0b-roles.sh [--dry-run]
```

workload PKI 由 `init-workload-pki.sh` 生成（/etc/work/runtime-ca，幂等不覆盖；rollout 在 CA 缺失时自动跑）。治理消费者使用独立 Host mTLS 客户端身份；其 PostgreSQL DSN 仍是 127.0.0.1 回环、`sslmode=disable`，与现有 Work 服务及 `provision-r0b-roles.sh` 输出一致，不能套用 Host 的 HTTPS/mTLS 参数。`WORK_GOVERNANCE_CA` 只验 Host HTTPS 服务端；`WORK_GOVERNANCE_CLIENT_CA` 才是客户端证书的签发 CA，供 rollout/verify 做链、有效期、EKU 与私钥匹配预检。

## 2. 环境变量

模板在 `src/work/deploy/ecs/*.env.example`，落地为 `/etc/work/<name>.env`。`install_env` **只在目标缺失时写入**，不覆盖现网 env；模板是占位/代码缺省，不是生产值。api/relay 模板只列部分旋钮，现网文件另含 DSN、主密钥、Host 证书等必填键（以 `cmd/*/main.go` 的 requiredEnv 为准）。

| 键 | 使用方 | 要点 |
|---|---|---|
| WORK_DATABASE_URL | api/worker/relay/authz/content-proxy/egress/export | 各自 login 角色（worker 系为 work_worker_login）；DSN 只进 env 文件，不进 argv |
| WORK_CONTENT_MASTER_KEY | api/worker/relay/content-proxy/egress/export | 必须同一把；丢失＝正文不可恢复；无轮换/重加密驱动（master 层已移出 R0a，C13） |
| WORK_CONTENT_DIR | 同上 | 缺省 /var/lib/work/content（work-control:work-control 700） |
| WORK_TEMPORAL_ADDRESS / _NAMESPACE / _TASK_QUEUE / _WORKFLOW_TYPE / _SERVER_NAME / _CA / _CERT / _KEY | worker/relay | 证书在 /etc/work/temporal；namespace work-r0a、队列 work-r0a-run |
| WORK_AUTHZ_WORKLOADS | authz | /etc/work/runtime-ca/workloads.json 指纹名单 |
| WORK_AUTHZ_LISTEN_ADDR 等四个 LISTEN_ADDR | 内部监听 | 8443/8444/8445/8446 |
| WORK_RUNTIME_MODE / WORK_MODEL_STEPS / WORK_WORKFLOW_ADVANCE / WORK_ADVANCE_URL | worker | 现仅 reference，openai_compatible 被拒 |
| WORK_DIRECTORY_MODE / _TIMEOUT / _ORG_ID / _ALLOW_MASS_ABSENCE | directory-sync | full/incremental；ALLOW_MASS_ABSENCE=1 是一次性放行决定，用完归 0 |
| WORK_EXPORT_ORG / WORK_EXPORT_ID | export | 导出组织 |
| WORK_RECONCILE_ORGS / WORK_RUNSTREAM_ORGS / WORK_RETENTION_ORGS | 三个扫描 unit | 空格分隔；**新增组织必须三处同时追加**，漏列＝静默不巡检/不清扫 |
| WORK_RUNSTREAM_STALE_MINUTES=5 / WORK_RUNSTREAM_MAX_HELD_ON_TERMINAL=0 / WORK_RETENTION_GRACE_MINUTES=15 | 扫描阈值 | 容差 0 是裁定值，重装后核对，勿回 2 |
| WORK_LISTEN_ADDR | api | 缺省 127.0.0.1:8080 |

迁移/备份凭据（不在上述模板）：

- `MIGRATOR_DATABASE_URL`：仅 rollout 用，work_migrator_login。
- `/root/work-secrets.env`：ecs-migrate.sh 与 work-chain-check 读取；键含 `WORK_MIGRATOR_PASSWORD`（或兼容名）、`WORK_DB_HOST/PORT/NAME`、`WORK_DB_MIGRATOR_USER`。
- 备份 age 私钥：只在管理员本地 `%USERPROFILE%\.we-meet-backup\work-offsite-20261029.agekey`，主机无副本（§5）。

改 env 流程 **[生产写]**：`sudoedit` → 保持 root:work-control 640 → unit 有变才 `daemon-reload` → restart 受影响 unit → 按 §4 验证。

## 3. Migration 顺序与 rollout

### 3.1 链结构与现网台账

- baseline：0001（角色前置，不可执行）＋0002（初始 schema）；增量清单与链尾以 `src/work/migrations/manifest.json` 为准，仓库现 tip 见 [status.json](status.json)。
- 整链内嵌在 `work-migrate` 二进制（migrations/embed.go）；manifest.json＋catalogs 钉 checksum；账本表 `work.schema_migration`。
- 现网 tip=62（2026-11-24 实测）。下文的 0040–0045／39→45 是 2026-11-14 与 2026-11-16 的历史裁定记录：0040–0045＝设备面表族；当时在装 work-migrate 对它们零命中，**必须先出链尾 45 的新包**，裁定为整包一次上（39→45；2026-11-14 主签单选扩包，取代 11-13 甲的 0040–0043／39→43，不含执行授权）。 **【2026-11-16 补，原文逐字保留】**仓库链尾已推进到 0049（0046–0049 属 M3 设备 agent/网关线：配对签名验真、设备签名键 getter、receipt 签名形状、pending resolution 认领），**不在该已裁包内**；包范围仍是 39→45，重切须另裁。仓库现 tip 由 [status.json](status.json) 现算，本文不手抄。

### 3.2 读账本 [只读]

```bash
sudo WORK_MIGRATE_BIN=/usr/local/bin/work-migrate bash /usr/local/bin/ecs-migrate.sh status
```

- 必须显式 `WORK_MIGRATE_BIN`：脚本默认指向开发者 home 副本（#98 陷阱），旧二进制不认识新增量。
- JSON `state` ∈ empty/pending/up_to_date；pending 逐名列出缺的版本。wrapper 预检发现"二进制不认识账本已有版本"会拒绝（exit 3）并点名两个路径。

### 3.3 应用 [生产写，需授权]

```bash
# A. 手工（等价 rollout 第 4 步）
sudo WORK_MIGRATE_BIN=/usr/local/bin/work-migrate \
  bash /usr/local/bin/ecs-migrate.sh apply --legacy-migrator-disabled
# B. 走发布链（推荐：自带 dump 与预检）；先 --dry-run
sudo ./rollout-r0a-0027.sh --release <发布目录> --migrations-only
```

- `--migrations-only`：dump → 装 work-migrate → apply → status → 成对装 retention-scan 两件；**不停/不重启任何 unit、不换其它二进制**。函数体类增量当场生效；Go 侧 workflow 变化（如 reconcile 24h 上界）不生效，需完整 rollout 换 worker。
- dump 自动落 `/var/backups/work/work-pre-0027-<stamp>.dump`（0600）；二进制逐项留 `.bak-<stamp>`。

### 3.4 rollout 0040–0045 的三道前置

> 2026-11-22 注记：标题里的"三道"是 0040–0045 时期的计数，标题原文保留不改；现读为五道——第 4 条随整包 0040–0062 重切新增，第 5 条随卡片 W 追加二（W2＝甲）新增。2026-11-23 追加：现读为七道——第 6 条随卡片 V、第 7 条随卡片 Y 的现网核对项新增（均为只读前置）。

1. **工作树干净**：`RELEASE_DIRTY=0`；脏包不可复现，rollout 会打 WARN。
2. **窗口当场生产写授权**：定序裁定不含执行授权。若包内含 authz 热加载改动（卡片 Y 前置 d），restart work-authz 会把 workloads.json 热加载变成现网行为——单独取授权或分开出包。
3. **同二进制重放预检**（换 work-worker 前必做，旧 runbook §5.32）：
   ```bash
   # [只读] 逐 org 数 workflow_status=Running（orphans=0 不能替代：孤儿数的是"已结束"）
   runuser -u work-control -- bash -c 'set -a; . /etc/work/work-worker.env; set +a; \
     /usr/local/bin/work-reconcile -scan -org <org>'
   # Running>0：用新包内 work-replay 导出历史 [生产读＋临时文件写]
   work-replay -export run:<run_id>[,<temporal_run_id>] -out /root/history-<run>.json
   # [本地] 用同一枚新二进制重放
   work-replay /root/history-<run>.json
   ```
   - 全部 `replay ok` → 正常 rollout；任一 nondeterministic → 本批只 `--migrations-only`，换 worker 另批授权，该 Run 先定性再处置（§5.16 口径），不手工动 workflow 历史。
   - Running=0 → 记"无对象可重放"，直接换二进制。
   - 导出 JSON 含组织数据：用后取回并删除，不在主机过夜。

4. **设备派发行为空集（2026-11-22 随整包 0040–0062 重切新增，实测前置）**：`0055:80` 加的是 `ALTER TABLE work.device_dispatch ADD COLUMN permit jsonb NOT NULL` 且无 DEFAULT，现网该表若已有任意行，链会在该步以 23502 中止并把已应用段落留在半途。 ⇒ 第一步开始前必须在窗口当场数过：

   ```bash
   # [只读] 现网设备派发行数必须为 0，否则本包不可在本窗口跑
   runuser -u postgres -- psql -d work -tAc "select count(*) from work.device_dispatch"
   ```

   读数为 0 → 可跑第一步；非 0 → 本窗口不跑该链，另批处置（回滚不可用"删列"绕过，0024 房屋规则下也不给表权限）。同一条判据也覆盖 `0059:11`（那条带 DEFAULT，安全，仅记录）。

5. **备份三件主机哈希装前比对（2026-11-22 随卡片 W 追加二／W2＝甲 新增，只读前置）**：第二步换 work-api 前（脚本 units 段会覆盖这三件），先按**剥 CR 口径**读主机原件并与仓库钉比对，任一不符不开写：

   ```bash
   for f in /opt/meet-db-backup/work-content-backup.py \
            /etc/systemd/system/work-content-backup.service \
            /etc/systemd/system/work-content-backup.timer; do
     if [ -e "$f" ]; then sudo tr -d '\r' < "$f" | sha256sum; else echo "MISSING $f"; fi
   done
   ```

   仓库钉：`.py`＝`393aae65d1ab82b18a75394c112081ba591cf7a9dc8d39ee37484702494fa31c`（另两件的字节钉在 `release-payload-closure.test.mjs`）。**判据边界**：`verify-r0a-0027.sh` 已逐名报 present/MISSING 与 `host_sha16`（剥 CR），但脚本内**没有**"读数与仓库钉不等即中止"的动作 ⇒ 本条的 fail-closed 目前靠现场手工比对，机械化须在 rollout 批获授权时补脚本；在那之前不得声称两侧一致已被机器保证。`.service`／`.timer` 若是首次安装（主机无原件）按 MISSING 记录并继续，这不属不一致。

   > 2026-11-24 追加：W2 的装前比对已在**只读 preflight** 中机械化——`rollout-preflight-package-shape-read.sh` 对三件逐名做剥 CR 后的主机／发布包 sha256 全等比较，任一不符即非零退出；主机缺件仍按首次安装记录并通过。该脚本先验 `SHA256SUMS`，所以“与包相等”同时意味着“与包所证明的仓库字节相等”。**边界未变**：`rollout-r0a-0027.sh` 自身仍无这道中止，现场必须把两份 preflight 的 `HOST_SCRIPT_RC` 都取到 0 才能开写；本机未取主机读数，卡片 W 的现网半句仍未闭合。

6. **work-api 链尾闸的现网读数（2026-11-23 随卡片 V 现网核对项新增，只读前置，第二步换 api 后当场取）**：卡片 V 的仓库面（`work-chain-check.service`＋`work-api.service` 的 `Requires=`/`After=`＋rollout 逐名安装步）已落，但"现网 work-api 是否真的带闸启动"只能当场读。重启 work-api 后取：

   ```bash
   # [只读] unit 片段里必须看得到 Requires=/After=work-chain-check.service
   sudo systemctl cat work-api.service | grep -E '^(Requires|After)=.*work-chain-check\.service'
   # [只读] oneshot 闸必须在本轮重启后成功跑过一次
   sudo systemctl status work-chain-check.service --no-pager
   sudo journalctl -u work-chain-check.service -n 20 --no-pager
   ```

   判据：`cat` 同时看得到 `Requires=` 与 `After=`，且 `status`／`journal` 显示 oneshot 成功执行过。**`enabled` 不是判据**——该 unit 故意不带 `[Install]`，只能由 `work-api` 拉起。任一条读不到 → 本窗口不把卡片 V 读成现网闭合，只记录读数并停在"仓库面已落"。

7. **work-authz 现网二进制身份与启动时间（2026-11-23 随卡片 Y 前置 d 新增，只读前置，重启前后各读一次）**：卡片 Y 的前置 d 是"未换二进制、未重启 work-authz ⇒ 现网仍跑启动期一次性读的旧二进制"。第二步 rollout 会在 `systemctl restart work-authz ...` 时换上新二进制，所以重启后必须当场确认跑的是新件、且启动时间晚于本次重启：

   ```bash
   # [只读] 重启前后各跑一次，记下 MainPID / 启动时间（含单调时钟）/ 可执行文件 sha256
   sudo systemctl show work-authz -p MainPID -p ExecMainStartTimestamp -p ExecMainStartTimestampMonotonic
   pid=$(sudo systemctl show work-authz -p MainPID --value)
   exe=$(sudo readlink -f "/proc/$pid/exe"); echo "$exe"; sudo sha256sum "$exe"
   sudo sha256sum /usr/local/bin/work-authz
   ```

   判据：重启后 `MainPID` 变化、`ExecMainStartTimestampMonotonic` 晚于本次重启、`/proc/<pid>/exe` 解析为 `/usr/local/bin/work-authz` 且其 sha256 等于本包新装件。三条全中才可把"热加载面已随新二进制生效"读成现网事实；否则仍按启动期一次性读的旧进程记，不得声称撤销面已成立。`workloads.json` 改动本身是生产写，不属本条只读核对；5 秒轮询是否真的捡起新名单，须另做受控写验证，本条不声称。

**两步排程（R2 甲＋R3 乙＋排程甲的合并结果）**：`--migrations-only` 与 `--enable-advance`／`--runtime-bundle` 互斥（`rollout-r0a-0027.sh:73-80` 直接拒绝），故整包 0040–0062 在同一窗口内**分两次调用**：第一步只跑 migration（含上列第 1–5 条前置），第二步在"同二进制重放预检全绿＋在途 Run 已 drain 到零"之后换 work-worker＋work-api 并落 V/W/Y（第 6–7 条在第二步当场取）。两次调用各自需要一笔独立的现场生产写授权；第一步完成不等于第二步已获授权。

**只读前置取数**（rollout 前另有两个主机侧只读探针，跑完即删，判据取脚本自身退出码 `HOST_SCRIPT_RC=0`）：`docs/plan/assets/work-r0a-ops-2026-10-25/preflight/rollout-preflight-ledger-read.sh`（台账/在途 Run/预留/outbox）与 `rollout-preflight-package-shape-read.sh`（发布包形状/在装件比对）。取数形状：

```bash
ssh -i ~/.ssh/id_ed25519 -o BatchMode=yes johnshao@<work-ecs> 'cat > /var/tmp/pf.sh && sed -i "s/\r$//" /var/tmp/pf.sh && sudo -S -p "" bash /var/tmp/pf.sh < ~/sudo-pass.txt; rc=$?; rm -f /var/tmp/pf.sh; echo HOST_SCRIPT_RC=$rc' < docs/plan/assets/work-r0a-ops-2026-10-25/preflight/rollout-preflight-ledger-read.sh
```

读数现取（tip_version/open_runs/RELEASE_DIRTY 等由脚本打印），不在本文手抄；现网迁移 tip 与发布包见 [status.md](status.md)。

**2026-11-24 起：两份脚本按 0040–0062 fail-closed 运行**。脚本仍只读、仍跑完即删，但不再“打印完永远成功”：包尾不是 62、`RELEASE_DIRTY` 非 0、`SHA256SUMS` 不通过、声明二进制或 backup 三件缺包、主机 backup 剥 CR 后不等、台账 tip 不符、`device_dispatch` 非空、SQL 探针读不到，都会打印 `PF FAIL` 并以 1 退出。两步分别这样取数（两次都要求 ledger 与 package 两份脚本各自 `HOST_SCRIPT_RC=0`）：

```bash
# 第一步 migrations-only：现网应从 39 起；在途 Run 记录但不阻断这一步
EXPECTED_LEDGER_TIP=39 REQUIRE_DRAINED=0 bash /var/tmp/rollout-preflight-ledger-read.sh
EXPECTED_MIGRATION_TAIL=62 bash /var/tmp/rollout-preflight-package-shape-read.sh

# 第二步换 worker/api 前：台账应已到 62，且在途 Run 必须为 0
EXPECTED_LEDGER_TIP=62 REQUIRE_DRAINED=1 bash /var/tmp/rollout-preflight-ledger-read.sh
EXPECTED_MIGRATION_TAIL=62 bash /var/tmp/rollout-preflight-package-shape-read.sh
```

`PF_RELEASE_DIR` 可指定 exact 包目录；不指定时仍取 `/root/work-release-*` 最新目录。`work.device_dispatch` 不存在按 0 行的安全情形通过，存在但查不到行数则中止。卡片 V／Y 的**重启后**读数仍按第 6／7 条在窗口内另取，本 preflight 不替代、也不声称已闭合。

**2026-11-24 工作主机现场只读结果**：`lavm-t7fmveau9b` 的 ledger preflight `HOST_SCRIPT_RC=0`——tip 39／rows 39，`device_dispatch` 不存在（按 0 行安全情形），但有 `open_runs=1`（active）与 `held_reservations=1`；package preflight `HOST_SCRIPT_RC=1`——最新包仍是 `/root/work-release-0039`，枚举全部 `/root/work-release-*` 后最高 tail 仍为 39，0062 包未就位。W2 三件主机文件剥 CR 后与仓库钉逐字相等；V 的 `work-api.service` 仍无 `Requires=`／`After=` 链尾闸且 `work-chain-check.service` 不存在；Y 的 `work-authz` 仍是 2026-11-11 18:43:44 启动的旧进程。**当前判定＝只能进入“出包／上传”准备，不能进入任何生产写步骤；第二步还须先把 active Run drain 到 0。**

**2026-11-24 0062 包已出并上传（仍非 rollout）**：从 `72d7dcbe3` 构建 `/tmp/work-release-0062`，`RELEASE_DIRTY=0`／`MIGRATION_TAIL=62`／15 个二进制／78 个包内文件；上传归档 sha256 `f302912ed0a92b7cee769c83f33878c2261684e5e94fb88100e4542cf2a7bd43`，主机解包到 `/root/work-release-0062` 后 75 条 `SHA256SUMS` 全 `OK`。对 exact 目录重跑 package preflight＝`HOST_SCRIPT_RC=0`，backup 三件主机／包剥 CR 哈希逐字相等；`work-migrate`／`work-api`／`work-authz` 的包件与已装件不同，`work-relay` 相同，均只是安装前对照。**更新判定＝发布包已就绪；仍未迁移、未换二进制、未重启，active Run 与两步生产写授权仍是后续硬前置。**

**2026-11-24 成功孤儿关闭与 drain 复扫（工单 `OPS-20261124-E24EB42C`）**：上段“active Run 仍是后续硬前置”自此过期。写前备份为 `/var/backups/work/work-pre-success-orphan-20261124-113458.dump`（1,686,432B／0600／root:root／sha256 `e9ae241238dfc7e78851e0405e597be400c9c20fd4dfc2f05c4e6671769cded4`）。对 Run `e24eb42c-5ffb-47ca-a0e9-385c9c4c30e2` 先以同一 SQL 做 `commit=0` 逐句回显并 `ROLLBACK`，确认 Run→`succeeded`、Task→`awaiting_acceptance`、`active_run_id` 清空、open Runs=0、audit／event 各 1 后，再以 `commit=1` 提交；未裸 UPDATE 业务表。提交后独立读回：Run `succeeded`／terminal reason `workflow_history_retention_expired`，Task `awaiting_acceptance` 且 `active_run_id` 为空；原 operation `cc465f2b-7f4c-4596-be51-c0f68a8760fc` 仍 `succeeded`，reservation `settled`／308 tokens／revision 1，Artifact `4c5af2df-21e8-4b25-a943-98609ace942a` 的版本仍 `published`／461B；audit `0968c00f-c99a-43af-8c61-842ec0b1a40d`、task_event `d9cb6ff0-f2fc-4268-aa91-541db60712de`（seq 9）各 1，outbox `e9bb20c9-82b5-440e-b474-5b54e15c5996` 已投递。`work-reconcile -scan` 返回 `runs:null`；`EXPECTED_LEDGER_TIP=39 REQUIRE_DRAINED=1` 的 ledger preflight＝`PF RESULT=PASS`（tip 39／open_runs 0／device_dispatch ABSENT／outbox_pending 0）。**仍有 1 条 held reservation**：operation `90fd0ccf-2617-4776-9674-77fad887927e`（`unknown`）属于已 failed 的 Run `18c04b53-0ddb-40f8-ac33-09a925f3d224`，金额 100000；本批只定位、未释放，也不把“open Runs=0”写成“所有 reservation 已清零”。至此只满足 runtime swap 的在途 Run drain 条件；**未执行 migration、未换二进制、未重启 unit，两步生产写授权仍分别待取。**

**2026-11-24 0040–0062 两步生产执行完成（官方验收器仍有已知过期断言）**：`6d8482427` 的 Work R0a gates／meet Workflow／Release guard 全部成功后，主签分别授权两步。第一步 12:25:27–12:25:31 `--migrations-only` rc=0，40–62 全部应用，dump＝`/var/backups/work/work-pre-0027-20261124-122527.dump`（1,687,350B／0600／sha256 `5ab888a189e8b49696d51bf42e434d936685f53841ad2ec6e5ddda9343dde425`）。第二步 12:31:15–12:31:22 `--enable-advance` rc=0，dump＝`/var/backups/work/work-pre-0027-20261124-123115.dump`（2,148,228B／0600／sha256 `fa0101e5b8322c4e2127b89512474485484ec76278df80345e9a7514e94537ff`），替换 15 个二进制并留 `.bak-20261124-123115`；未传 runtime bundle，`work-runtime` PID／启动时间／哈希未变。最终 `work-api` PID `2444239`、`work-worker` PID `2444261`、`work-authz` PID `2443798` 均 active，进程 exe 与包件哈希逐字相等；healthz／Host `/work-host/v2/orgs` 均 200，`work-reconcile -scan`＝`runs:null`，tip62／drain1／package preflight 全 PASS。V 的 `Requires=`／`After=` 已落，oneshot `work-chain-check.service` 在本轮以 status 0 成功退出；Y 的新 authz 已加载 `workloads.json`（registry sha256 `216c9b653ac94a2a74f345b3461979d43626a182bfd88bb7f3bab68aff68561c`／workloads=2）。W 三件已按包安装且剥 CR 哈希全等，timer 于 12:45:56 实际启动新脚本，12:46:05 以 status 0 成功完成；receipt＝`content/2026/11/24/20261124T044557Z-3c30b5456425.tar.gz.age`／2,831,871B／sha256 `b9828578ac316fec78d4f896ecfb9f045ec2aaee24131bd2b59151da3f033545`，下一轮 18:50:32。12:31:17 旧 API 在“已停、新件未装”窗口出现一次 `203/EXEC`，12:31:22 最终重启后恢复，当前 `Result=success`。**未签收为官方验收全绿**：包内 `verify-r0a-0027.sh` 仍因 `nonce_purpose_closed_set` 只认旧两项 purpose、`run_history_handback_projects_the_lease` 按旧 search_path 文本匹配而 rc=1；直接 live SQL 已证明两项真实语义均 true。1 条 held reservation 未释放，真实供应商 E2E／J39／C13 仍未闭合。

**2026-11-24 0062 包重建与官方验收收口**：`c73adea2a` 的 Work R0a gates／meet Workflow／Release guard 全部成功后，从该 HEAD 重建 `/tmp/work-release-0062-c73adea2a`（`RELEASE_COMMIT=c73adea2ad3c4abe2ba5f400f186cd87df699e4d`／`RELEASE_DIRTY=0`／`MIGRATION_TAIL=62`／15 个二进制），上传归档 sha256＝`f61a86688a703e18482662d0b1eabce24cf08f3666bfb1f194a4ec1dec326f1a`，主机解包到 `/root/work-release-0062-c73adea2a`，75 条 `SHA256SUMS` 全 `OK`。exact 目录 ledger preflight＝`PF RESULT=PASS`（tip62／open_runs 0／outbox_pending 0），package preflight＝`PF RESULT=PASS`；官方 `verify-r0a-0027.sh`＝`OFFICIAL_VERIFY_RC=0`，所有验收 verdict 为 true／present。新旧包的 15 个运行时二进制逐字节相同（`BIN_DIFF_COUNT=0`），变化的只有修正版 verifier 及其校验出处；本批未改数据库、未重启 unit、未再次更换 runtime 二进制。1 条 held reservation、真实供应商 E2E／J39／C13 与 W 的重建可移植性仍是独立未闭合项。

**2026-11-27 现网只读复审**：工作主机 `lavm-t7fmveau9b` 的 exact 0062 包 ledger preflight＝`HOST_SCRIPT_RC=0`（tip_version=62／rows=62／device_dispatch=0／open_runs=0／outbox_pending=0／held_reservations=1）；package preflight＝`HOST_SCRIPT_RC=0`（`RELEASE_COMMIT=c73adea2a`／`RELEASE_DIRTY=0`／75 条 SHA256SUMS 全通过／15 个声明二进制齐备／backup 三件剥 CR 后逐字相等）；包内官方 `verify-r0a-0027.sh`＝`OFFICIAL_VERIFY_RC=0`，所有 acceptance verdict 为 true／present。`/var/lib/work/health.json` 为 `status=ok`（13:59:08+08:00），八个核心 unit active，`work-runtime` 仍为 2026-11-07 08:04:01 启动的 Node/Pi 进程，未换 runtime bundle。现装 `work-api` sha256 `b4b82e8e…` 与 0062 包件 `8f8bae28…` 不同，是下文 C17 `a05ba12e8` 埋点热修后的已知二进制；`/proc/2543216/exe` 与 `/usr/local/bin/work-api` 哈希一致，非运行中 deleted inode。**仍未闭合**：1 条 held reservation；reconcile／retention／gauge 的组织清单均为 1 而目录组织为 2；`work-cancel.service/.timer/.env` 在主机缺失；真实 SLO 告警仍丢弃，C17 观测窗未满。本轮只读，未改数据库、env、unit 或二进制。

**2026-11-27 18:18 CST 当前 HEAD 只读验收**：同一主机仍为 ledger 62／rows 62；用当前 `verify-r0a-0027.sh` 验收返回 rc=1、22 项 FALSE/MISSING，核心原因是包内 `MIGRATION_TAIL=83` 而主机只部署到 62，63–83 的 schema/函数尚未上线。该结果不推翻 0062 exact 包的历史 `OFFICIAL_VERIFY_RC=0`，也不得写成当前 HEAD 已验收通过。治理专项读数：`work_governance_events`／`work_operator` 均为 NOLOGIN 且无 super/createrole/bypassrls，`work_governance_events_login` 为 LOGIN 且无这些高权限；`work-cancel.service/.timer/.env` 与 `work-governance-events.service/.timer/.env` 仍 MISSING，`work_governance_client_cert=FALSE`、`work_governance_consumer=FALSE`。目录组织为 `4a2d3f28-38b9-4d6c-8614-70ef9a83960d` 与 `first-org`，reconcile/retention/gauge 三份清单仅含前者，均缺 `first-org`；cancel/governance env 尚不存在。本轮只读，未改数据库、env、unit、证书或二进制。

**2026-11-27 63–83 迁移风险审计与升级演练**：逐份审计 0063–0083 后未发现迁移期 TRUNCATE/DELETE/UPDATE、表重写、类型/NOT NULL 变更或热表索引构建；主要锁风险是 0063 DROP/ADD CHECK 对 `operation_usage_fact` 与 `operation_resolution` 的 ACCESS EXCLUSIVE 锁。现网只读显示两表分别为 121／0 行（约 168KiB／40KiB）、无超过 30 秒的事务，数据库约 22MiB、WAL 32MiB、根分区可用 229GiB；`work_migrator_login→work_migrator→work_owner` 链完整，`/root/work-secrets.env` 与 worker env 可读。隔离 PostgreSQL 上 `TestApplyFromTip62ToTail` 由正式 runner 先建 tip62，再验证 pending 恰好为 63–83、应用至 tail 并复查 ledger/catalog；`TestFailedIncrementRollsBack` 与 `TestInterruptedIncrementRollsBack` 同批通过。该演练不替代生产 clone、现场 catalog drift 与授权后的正式 rollout。**热升级注意**：0062 源码的 cursor API 调用六参函数，0073 起六参重载故意返回 `admin_access_denied`，只有携带 `org.work.seat.write` 的七参调用可推进；因此 `--migrations-only` 后到新 API 替换前，`/work/v2/admin/governance-event-cursor` 必须视为不可用，不能在该窗口执行恢复。catalog 对比与 `TestUpgradeFrom62PreservesSchemaContracts` 同时确认：0062 的关系、列、约束、238 个函数签名全部保留到 0083，列类型/可空性、函数 result/SECURITY DEFINER/strict/owner/search_path 与函数 EXECUTE grant 无撤销；新增 20 个函数/重载。`approval_decision_proof_valid` 仅将实现语言从 SQL 改为 PL/pgSQL 并收紧校验，调用契约不变。

**2026-11-27 0084 恢复 offer 迁移审计**：0084 只新增 `work.ensure_device_resume_offers(text,uuid,uuid)`，不含表/列/约束/索引变更或数据回写；`SECURITY DEFINER`、owner=`work_owner`、`search_path=work,pg_catalog`，仅 `work_worker` 可执行。命令只对同设备、同会话、grant 仍有效的 `waiting(input)`／未取得 execute lease 的 `active` Run 创建更高 revision，并要求存在 recorded checkpoint；旧会话 grant、撤销 grant/设备、unknown/unresolved、live lease/offer、reconcile lease 均拒绝或跳过。真库覆盖最新 checkpoint、幂等、缺失 checkpoint、身份/撤销边界，gateway 覆盖 heartbeat 自动生成签名 resume offer 并走既有 ready/start；`TestTailCatalogCheckpointMatchesLiveChain` 与 tip62→tail84 catalog 兼容回归通过。生产 63–84 rollout、clone/catalog drift 与真机跨会话显式改绑恢复验收仍未执行。

**2026-11-27 0085 ExecutionProfile 服务端切片审计**：0085 新增 `execution_profile_revision`、`device_model_binding`、`model_profile_probe` 三表及 registry/binding/probe 命令；表均启用 RLS/FORCE，workload role 无表权限，命令为 `SECURITY DEFINER`＋pinned `search_path`，仅 `work_api` 可执行。`local_preview_facts` 旧九参函数被删除并重述为十三参，`submit_local_task` 在写入 Task/Run/binding 前从 active registry＋verified binding 派生 canonical profile 字段，未 verified、profile 撤销、设备/会话撤销均 fail closed。probe verified 必须引用服务端已入账的成功 `device_model_result`，核对 preview/request hash、result hash、设备/会话、模型、时间、≤16 output tokens 与 `configuration_probe` Run binding；普通成功模型回执或设备自证不能替代 `configuration_probe` 入账证据；固定模板的实际执行仍由 Broker 后续批次负责。提交按 org→device/session→grant 加锁，撤销 org/grant 与提交串行。真库覆盖发布/读取不可变性、binding pending→verified、错误设备/会话/profile/hash、撤销 profile、probe 不匹配、preview 过期拒绝、failed/reconcile 撤销 binding、预览/提交零副作用拒绝与 canonical 写回；API 覆盖 GET 与 `model_binding`／`model_probe` 签名拒绝；tip62→85 升级、失败回滚、中断恢复与 tail catalog 回归通过。**该切片尚未接 Broker 真实探测、桌面 profile 来源与 synccore canonical profile 消费，#364 未完成；生产未部署。**

**2026-11-27 0086 configuration-probe 提交链**：新增 `submit_configuration_probe` 与 `POST /work/v2/devices/{deviceId}/model-bindings/{bindingId}/probe-runs`，使用现有 19 字段 `local_intent` 签名域但要求空 grant 集与固定模板 hash。服务端从 pending binding/probe/registry 派生全部执行事实，创建 `task_kind=configuration_probe` 的隐藏 Task、无用户正文 synthetic input、`purpose=configuration_probe` 的 device Run binding，并复用 `submit_task`／原子 activation／现有计量链。同一 probe 仅允许 queued→running 一次；新 request ID 不能重复建 Run，普通 `retry_task` 也被单 Run 触发器拒绝。configuration-probe Run 只允许一个 model Operation 与一条 model result；验证回执必须属于该 probe 已记录的 Task/Run，probe Task/Run 指针写入后不可改；`task_summary` 排除 configuration probe。真库覆盖 canonical 隐藏 Run、幂等/冲突、过期/错配/verified 拒绝、重复提交、禁止 retry 与 pointer 防改写；API 覆盖签名拒绝。生产未部署。

**2026-11-27 0087 签名 offer probe 元数据**：基于 0069 现行 `list_pending_device_offers` 语义重述 getter，保留 offered/ready/active-未签 run_start 的可见条件，仅为 `purpose=configuration_probe` 的 binding 返回 `probe{binding_id,probe_id,preview_hash,template_hash}`。gateway 在 configuration probe 时把该对象写入签名 `run_offer`，普通 Task 线格式不变；Rust `RunOfferBody` 增加可选 `probe` 字段，序列化省略普通 Task 的该键，签名覆盖 probe 元数据。真库验证原子激活后的 probe Run 能返回精确 probe 元数据，Rust 覆盖可选字段、闭合线格式与篡改拒绝。生产未部署。

**2026-11-28 0088 内部探针 grant 与固定模板执行**：`workspace_grant.purpose` 增加 `configuration_probe`，probe binding 通过 `probe:<probe_id>` 快照引用精确匹配 pending probe，并由数据库铸造仅一个、五分钟内过期、`local_only` 的内部 grant；普通 grant 列表显式过滤该 purpose。Broker 仅对 probe 跳过设备侧根目录注册表成员检查，仍携带服务端 grant 走 prepare/permit/计量链；模型 Action 与 model result 的 `request_hash` 使用签名 offer 的 `preview_hash`，普通 Task 保持原独立域哈希。Rust 校验 probe UUID、bare hex、固定模板 hash、单 grant 与 input/snapshot 一致性；Node 忽略 sealed input，不发送用户消息或工具，仅执行一轮且 `max_tokens=16`，模板 hash 不符时在任何模型/工具帧前失败。真库覆盖内部 grant 可见性、精确 probe 关联与 tip88 catalog；Node 51 项、Rust 652 项通过。**仍未实现：** 持久 model_result ack 到签名 `model_probe` receipt 的生产桥接、桌面 profile/binding/probe 界面、profile 生命周期端点与真实设备/供应商验收；生产未部署。

**2026-11-28 model_result ack→model_probe receipt 桥接**：probe 元数据与 model result 同事务持久化；journal 仅读取服务器 signed `recorded` ack 且未 rejected 的结果，复验 model_result 签名与 request_hash=preview_hash 后生成 `model_probe` 签名回执。回执使用 `model_result:<id>` 引用、服务端 result hash、当前 Host session revision，60 秒有效；同一 model result 复用精确签名与 `model_probe:<id>` 幂等请求 ID，过期或 epoch 改变后不再重铸、不再无限重试。Broker 新增闭合轮询 IPC `getModelProbeReceipts`／`confirmModelProbeReceiptDelivery`，桌面轮询用 Host auth_epoch 取回执，严格校验 14 键形状与当前组织/主体/设备后带 Bearer、`X-Work-Client:desktop`、`X-Device-Signature` POST 到现有 `/work/v2/devices/{deviceId}/model-bindings/{bindingId}/probes`，API 成功后才确认本地投递。Rust journal/IPC、桌面 API/pipe/driver 定向回归通过。生产 rollout、真实设备与真实供应商验收仍未执行。

**2026-11-28 0089 probe preview 过期刷新**：新增 `refresh_device_model_probe_preview` 与 `POST /work/v2/devices/{deviceId}/model-bindings/{bindingId}/probe-previews`，仅允许当前 owner/seat、active bearer device/session、匹配 active device_local profile、pending binding 的最新 queued probe 已过期且无 Task/Run 时刷新。函数按 org→member/device/session→binding/profile/probe 顺序加锁，以 client request ID 幂等，保留 binding ID/revision/profile/listener identity 与旧 probe 行，只插入新 UUID 的 60 秒 queued preview；未过期、running、已验证、撤销 profile、错 revision/会话均拒绝。真库覆盖旧 probe 不变、新 preview hash、binding 保持、幂等重放/冲突、未过期与 running 拒绝，tail catalog 89 通过。生产未部署。

**2026-11-28 0090 probe 状态读面**：新增 `get_device_model_probe` 与 `GET /work/v2/devices/{deviceId}/model-probes/{probeId}`。函数为 `SECURITY DEFINER`、固定 `search_path=work, pg_catalog`，核对当前组织/主体、active device 所有权后返回 probe/binding/profile 标识、状态、有效期、Task/Run/Operation 关联、结构化 token usage；failed/reconcile 仅返回固定 `probe_failed`，不泄露供应商错误。API 角色仅获该函数 EXECUTE，不获得 R0b 新表直接 SELECT 权限；桌面 `WorkApi.getModelProbe` 使用同一闭合路由。真库 API 覆盖 queued 状态与空 usage/safe_error，tail catalog 90 通过。生产未部署。

**2026-11-28 0091 签名 offer canonical 资源上界**：`list_pending_device_offers` 从绑定对应的 ExecutionProfile revision 读取 `max_turns`、`max_output_tokens`、`max_request_bytes`，Go gateway 以十进制字符串写入签名 `run_offer`，Rust `RunOfferBody` 必填解析并在 ready 前拒绝零值；普通 Run 的 Node bootstrap 直接消费这三项，并以 profile revision 作为 config revision；configuration probe 仍固定为一轮／16 token／1MiB。真库 offer、Go wire 与 Rust 签名/形状回归通过，tail catalog 91。生产未部署。

**2026-11-28 0092 ExecutionProfile 有限上界**：数据库新增约束：`max_request_bytes ≤ 262144`、`context_tokens/max_output_tokens/max_turns ≤ 2^53−1`，且 `max_output_tokens ≤ context_tokens`；发布夹具同步收紧到 262144 bytes。真库覆盖五类越界拒绝，verifier 钉住五个约束与关键数值，tail catalog 92。生产未部署。

### 3.5 装后验证与链尾闸 [只读]

- `sudo ./verify-r0a-0027.sh "<开始时刻>"`：`rows=N max=N`、清单 all present、函数体探针 true（claim_carries_takeover、terminal_release_guard、export_discovery_hardened、0040–0045 设备面探针等）。
- unit active 且无 STALE（进程仍跑被替换的旧 inode）；rollout 第 10 步自动查。
- 链尾闸（随 rollout 安装后）：work-api 每次启动先跑 `ecs-migrate.sh status -require-up-to-date`。两种指纹方向相反：
  - `ledger_pending_increments`（账本落后于二进制）→ 向前补链（apply/完整 rollout）；
  - `ledger_version_unknown`（二进制落后于账本）→ 换回含该版本的二进制，**绝不为启动改账本**。

## 4. 健康检查

### 4.1 自动探针与告警

`work-healthcheck.timer` 每 2 分钟跑 `work-healthcheck.sh`，检查：`http://127.0.0.1:8080/healthz`=200；Host `/work-host/v2/orgs`=200（客户端证书）；观察名单 unit（directory-sync×2、reconcile-scan、runstream-scan、work-cancel、work-governance-events）Result≠failed；relay active；worker 与已 enable 的治理消费者 timer 在启用时 active；30 分钟内两类同步报告且 `"errors":[]`；/etc/work/certs 与 /etc/work/temporal 证书 30 天内不到期。

- 治理消费者的基础设施失败或跳号会以非零退出留下 failed，并由上述探针转 degraded；timer 已 enable 但非 active 也转 degraded。尚未部署的 timer 不单独触发健康告警，其缺失由官方 verifier 的硬判据拒绝。**仓库接线不等于生产投递已取证**。

- 状态：`/var/lib/work/health.json`；异常：`/var/log/work-health-alerts.log`＋journal。
- `work-health-alert.py` 状态变化发信（ok→degraded 立即；持续 degraded 每 6 小时；恢复发信）。只有邮件通道；SMTP 失败在 journal 搜 `health alert delivery failed`。
- **不要手跑 work-healthcheck.sh 取证——它会发信**。只读取证：

```bash
cat /var/lib/work/health.json                                         # [只读]
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/healthz # [只读]
sudo systemctl list-timers 'work-*' 'meet-db-backup*'                 # [只读]
journalctl -u work-reconcile-scan.service -o cat | tail               # [只读] orgs=N orphans=M scan_errors=K
journalctl -u work-runstream-scan.service -o cat | tail               # [只读] BREACH/ok＋六条读数
journalctl -u work-cancel.service -o cat | tail                       # [只读] orgs=N intents=M＋逐条 outcome/state
journalctl -u work-governance-events.service -o cat | tail            # [只读] events/gaps＋逐 org 消费结果
```

### 4.2 目录同步新鲜度

- 权威表 `work.directory_sync_state`（last_mode/last_success_at/last_error）；verify 的 "directory sync" 块逐 org 打印 age。
- 新工作准入：900s 内无成功同步或 last_error 非空 → 503 `service_degraded`，直到成功同步清除。
- 失败轮（非零退出或 orgs_failed/members_failed>0）之后**下一轮必须补跑 full**，只重跑增量拉不回失败组织的低修订成员。
- 大批缺席闸：full 拟标缺席 ≥ max(10, 候选 20%) 默认拦截（`directory.member_absence_blocked`）；确认 Host 数据后以 `WORK_DIRECTORY_ALLOW_MASS_ABSENCE=1` 重跑一次 **[生产写决定]**，随后归 0。
- 特权读 **[只读]**：
  ```bash
  runuser -u postgres -- psql -d work -Atc \
    "select org_id,last_mode,last_success_at,last_error from work.directory_sync_state"
  ```
- 证书到期预检 **[只读]**：`openssl x509 -in /etc/work/certs/client.crt -noout -enddate -checkend 5184000`（60 天）。轮换步骤见旧 runbook §5.5：客户端轮换无停机；CA 轮换是硬切换，需维护窗口。

## 5. 备份与恢复

### 5.1 数据库备份（OSS＋age）

- `meet-db-backup@work.timer` 每 6 小时：本机 socket 逻辑备份 `work`/`temporal`/`temporal_visibility`，age 公钥加密上传私有桶 `we-work-backup`（前缀 `work/databases/work/`，生命周期 30 天）。
- check timer 每小时校验最新成功记录、对象长度与 SHA-256；notify timer 每分钟重试未送达邮件；失败/过期（>8h）/恢复均发信。
- 配置 `/etc/meet-db-backup/work/{config,storage,notification}.json`＋`recipient.txt`（目录 0700/文件 0600，不入 Git）。
- **私钥只在管理员本地** `%USERPROFILE%\.we-meet-backup\work-offsite-20261029.agekey`；Work ECS 无副本。

值班命令：

```bash
sudo systemctl list-timers 'meet-db-backup*'                                        # [只读]
sudo systemctl status meet-db-backup@work.service meet-db-backup-check@work.service # [只读]
sudo cat /var/lib/meet-db-backup/work/last-success.json                             # [只读]
sudo cat /var/lib/meet-db-backup/work/last-check.json                               # [只读]
sudo python3 /opt/meet-db-backup/database_notify.py work status                     # [只读]
sudo systemctl start meet-db-backup@work.service                                    # [生产写：产生新备份对象]
sudo systemctl start meet-db-backup-check@work.service                              # [手动触发校验]
```

### 5.2 恢复演练

```bash
# 私钥临时放回主机 root 0600 路径并显式指名；演练完立即删除并核实
sudo WORK_BACKUP_IDENTITY=/root/work-backups/work-offsite-20261029.agekey \
  python3 /opt/meet-db-backup/work-db-restore-drill.py
```

- 脚本随发布包交付（源 `src/work/deploy/ecs/work-db-restore-drill.py`，rollout 装到 /opt/meet-db-backup/）。身份文件缺失先失败并点名 `WORK_BACKUP_IDENTITY`；不传该变量必红。
- 流程：下载 latest.json 指向对象 → 校验 SHA-256/manifest → 解密 → 建临时 `work_drill_*` 库 → `pg_restore --no-owner --no-privileges` → 逐表比对行数 → 删临时库。判据 `status=passed`（最近一次 2026-11-05 通过）。
- 不启动应用、不恢复生产角色；结束后私钥删除、无 `work_drill_*` 残留。
- 演练≠区域 DR：RPO＝最近一次 6 小时备份；备份不覆盖主机配置、证书、Redis、OSS 对象与 Temporal 之外的外部依赖。

### 5.3 真实灾难恢复 [生产写，人工审批]

顺序：停 `work-api`、`work-directory-sync*` → 确认冻结窗口 → 解密 dump 恢复到目标库 → 重跑 `work-migrate status` → full 目录同步 → bootstrap 冒烟。旧主必须隔离（轮换 execution generation、阻断旧 egress），不能只做 DNS 切换；详见旧 runbook §3。

### 5.4 内容备份（主机自管）

- `work-content-backup.timer` 每 6 小时（00/06/12/18:45 +08）打包 `/var/lib/work/content`，age 加密上传 `we-work-backup/content/`，30 天清理；回执 `/var/lib/work/content-backup.json`；恢复需同一把 age 私钥。
- 2026-11-13 起仓库无出处（卡片 W）：执行体是主机 `/opt/meet-db-backup/work-content-backup.py`，改它没有 diff 可评审。取证 **[只读]**：
  ```bash
  sudo systemctl cat work-content-backup.timer
  sudo systemctl list-timers work-content-backup.timer
  sudo sha256sum /opt/meet-db-backup/work-content-backup.py
  ```
- **2026-11-22 卡片 W 重开（W1＝甲／W2＝甲／W3＝甲；上条原文与那条 sudo 取数命令逐字保留）**：三件已按 `9bb50f94c~1` 的 blob 逐字节回植 `src/work/deploy/ecs/`，`rollout-r0a-0027.sh` 的 units 段有了逐名安装步（`.py` 0700、两 unit 0644、覆盖前留 `.bak-$STAMP`、`enable`＋`start` 各一行），`make-release.sh` 的闭包按后缀自动带上，`verify-r0a-0027.sh` 的三行读数改报**剥 CR 后**的主机 sha16。上面"仓库无出处、改它没有 diff 可评审"这句自今天起过期，判读以本条为准。两条新口径：① **行尾**——仓库那份是 LF（`.py` 2767B／73 行），主机手工那份是 2840B，差值恰为 73 个 CR，所以上面第 3 条 `sha256sum` 直接算出的值和仓库钉**必然不同**；可比口径是 `sudo tr -d '\r' < /opt/meet-db-backup/work-content-backup.py | sha256sum`，仓库侧钉为 `393aae65d1ab82b18a75394c112081ba591cf7a9dc8d39ee37484702494fa31c`（另两件见 `release-payload-closure.test.mjs`）。W2＝甲 只钉了仓库侧，主机侧一致与否属**现场取数**，没取到读数前不得声称两侧一致。② **本批零现网执行**：`enable`／`start` 在现网是 no-op（那两件早已 enabled＋active），只有按本包重建的主机才靠它们立起来；unit 的 `Persistent=true` 使第一次 start 立刻补跑一次备份（一次上传＋一轮 30 天远端删除），属窗口内可见效果，仍须现场生产写授权。仍未闭合的一格：`.py` 依赖 `/opt/meet-db-backup/backup` 模块与 `/etc/meet-db-backup/work/storage.json`、`recipient.txt`，三者不在仓库 ⇒ 重建主机装得上三件、跑不起这条备份。
- 主密钥与内容目录必须单独纳入备份/恢复演练；首个备份是空目录烟雾，接入真实任务后必须重做下载/解密/目录恢复。
- 删除可回性窗口：清扫前那次备份仍含被删对象，**下一次备份后不可回**——手工删除前先核备份时刻（§8）。

## 6. 回滚

先判方向，两个方向动作相反：

1. **二进制回滚 [生产写]**：重装 `/usr/local/bin/*.bak-<stamp>`（rollout 逐项留备份）→ restart 受影响 unit → verify。若同批动过数据库，恢复 `/var/backups/work/work-pre-0027-<stamp>.dump`（先停写单元再 pg_restore）。
2. **账本方向**：绝不"回滚账本"迁就旧二进制。
   - 二进制旧于账本（`ledger_version_unknown`）→ 换回含该版本的二进制；
   - 账本旧于二进制（`ledger_pending_increments`）→ 向前补链。
   - 链尾闸装上后方向猜错＝work-api CrashLoop（Restart=always 每 5s）。先读闸 **[只读]**：
     ```bash
     systemctl status work-chain-check.service
     journalctl -u work-chain-check.service --since '-15 min' -o cat
     ```
   - 临时绕闸拉起服务只能由主签当场点名授权；本文不提供绕过命令。

回滚纪律：

- 保留 expand/contract 兼容窗口：不删新 schema 字段；不在活跃 Run 上做破坏性迁移。
- 回滚后重放 outbox/对账；不重发已成功或 unknown 的 Operation。
- 新版本写入的 checkpoint 与旧 runtime 不兼容时保持暂停、恢复到兼容版本，不忽略 schemaVersion。
- **保留角色**：角色 provisioning 幂等、从不 drop/alter 已有角色（work-roles.sql）；回滚不清角色。`work_ops` 为 NOLOGIN，值班临时授予成员资格、事后回收，不留常驻授权。
- 前端回滚 **[生产写]**：`bash deploy/aliyun/release-meet.sh --tag <上一版tag> frontend`。
- 每次升级必须包含回滚到旧 runtime 的演练（staging）；未执行的演练不算通过。

## 7. 告警与值班

### 7.1 先承认现状：Prometheus 规则未生效

- 48 条规则（21 record＋27 alert）在 `docs/plan/assets/work-r0a-ops-2026-10-25/prometheus-rules.yaml`（部署副本 `deploy/observability/prometheus-rules.yaml`＋Grafana 面板）。promtool 校验通过，但**今天任何一条 alert 都不会自己响**：两台试点机无 prometheus/alertmanager unit，28 个 work_* 序列零产生者（telemetry-producers.test.mjs 的 UNPRODUCED 棘轮）。
- 真实投递链只有两条：① work-healthcheck.timer → work-health-alert.py 邮件（观察名单 unit 转红才发）；② 各扫描 unit 退出码标红＋值班手工读数。
- SLO：`slo-pilot.json` 12 项指标全部 not_measured；目标是内部测量口径，不是客户合同。

> **2026-11-24 C17 开工原位注记（原文三段保留，判读以本段为准）**：主签已裁首批＝独立观测栈＋`work-api` 埋点，TTFT 暂不测，并授权独立观测包安装与单次 `work-api` 重启。仓库面已新增 `deploy/observability/` 独立包（Prometheus 2.54.1／Alertmanager 0.28.1／Grafana 13.3.1，版本与 sha256 固定）、五个只绑 loopback 的 unit、Grafana provisioning、本机演示 webhook 与安装／验收／回滚脚本；`work-api` 新增 `WORK_METRICS_ADDR` 与首批三条真实序列。**告警路由边界**：Alertmanager 默认 `demo-discard`，只有 `alert_class=demo` 且具名 demo 告警进入本机 webhook；真实 SLO 告警不会被投递，不能读成值班告警已接通。控制 API 可用性规则排除 `/healthz`，避免健康检查稀释 SLO。**当前仍未安装**：上文“任何一条 alert 都不会自己响”在安装前继续成立；安装后必须以 `verify.sh`、Prometheus targets、Grafana datasource/dashboard 与 webhook firing/resolved 回执为准。TTFT 仍不测，12 项 SLO 不因本批自动翻绿。

> **2026-11-24 C17 安装验收补记**：commit `a05ba12e8` 的干净独立包已安装；五个 observability unit 均 active，六个端口均只绑 `127.0.0.1`，Prometheus targets 3/3 up，Grafana health、dashboard `work-r0a-overview` 与 datasource `work-prometheus` 已读到，`verify.sh` rc=0。无客户数据的 `/work/v1/bootstrap` 未认证探针返回 401，并在 Prometheus 形成 `/work/v1/bootstrap` 真实序列（`/healthz` 仍被 SLO 规则排除）。演示告警已取得 webhook firing 与 resolved 两条回执，失败文件已清除。`work-api` 只做了一次停止/启动，当前二进制 sha256 为 `b4b82e8e7baea3ed11e778c75a057a88390fab7ba8be0880ac4c3e5004f41a68`，备份在 `/var/backups/work-observability/20261124-132115`，在途 Run 为 0。现场发现 Prometheus 自动附加 `job`/`instance` 导致 webhook 400，已在当前补丁中按固定值 `work-demo`/`127.0.0.1:19092` 放行并热更新 webhook，未再重启 `work-api`。**仍不闭合**：真实 SLO 告警依旧 `demo-discard`，TTFT 与其余 DB／Node／RUM 指标仍未测，不能据此宣称 C17 或 12 项 SLO 已实测完成。

> **2026-11-24 C17 只读观测窗开启**：主签裁定＝30 天窗＋Prometheus retention 30d＋定时无认证 GET 探针。窗口为 `2026-11-24T15:36:10Z` 至 `2026-12-24T15:36:10Z`；`work-c17-observation-probe.timer` 每 60 秒请求 `/work/v1/bootstrap` 并要求 401，`verify-observation-window.sh` rc=0，retention=30d、timer active、bootstrap 序列已出现。`work-api` 启动时间仍为 `2026-11-24 21:21:48 CST`，观测窗未重启 API。**口径限制**：这是 `org_id="unknown"` 的合成控制面可用性样本，不代表 demo/真实组织流量；提交 P95、SSE、TTFT、DB/Node/RUM 仍 `not_measured`，30 天结束前不得把任何 SLO 标 met/missed。

### 7.2 扫描 unit 退出码（值班读法）

| Unit | rc=0 | rc=1 | rc=2 | rc=4 |
|---|---|---|---|---|
| work-reconcile-scan（15min） | 干净 | org 扫描失败 | 发现孤儿 | — |
| work-runstream-scan（10min） | 无越限 | 调用失败/缺读数 | parked_runs>0 或 held_on_terminal>容差 | — |
| work-retention-scan（hourly） | 干净（扫到 N 行属正常） | 调用失败/缺读数 | content_shred 卡住 >15min 宽限窗 | — |
| work-c16-log-scan（daily） | 干净 | preflight 失败/正控未 fire | — | 发现正文/秘密 |
| work-cancel（5s） | 一轮完成（含 0 条） | org 清单为空/claim 或退避写库失败 | — | — |
| work-governance-events（10s） | 一轮完成（含 0 条） | Host/DB/协议失败或跳号停止 | — | — |

- `parked_runs` 排除 waiting/quota（有意状态，24h 上限）；waiting/reconcile 不排除——那是"24 小时窗口决定要不要救"，每小时 BREACH 是设计内的钟，不是告警坏了。
- `orphans=0` ≠ 没有停放 Run（workflow 仍 Running 的那类孤儿规则看不见）；`held_on_terminal` 容差现值 0，泄漏一笔即红。
- work-cancel 的 rc 只报基础设施：意图死信**不**标红单元（告警是 `cancellation_intent.dead_lettered` 审计行，与 outbox 死信同口径），单条意图被拒也不标红——它进退避阶梯，十次或非可重试才死信。基础设施失败本身会由 healthcheck 转 degraded；值班读死信：`SELECT count(*) FROM work.audit_event WHERE action='cancellation_intent.dead_lettered'` **[只读]**。
- work-governance-events 的 Host/DB/协议失败与跳号会非零退出，由 healthcheck 转 degraded；恢复仍须固定两步，不得用重做授座绕过游标。
- 判自动路径看 `runs_logged`/journal，不抄历史时刻；不要手跑 work-healthcheck.sh 去"消警"。

### 7.3 值班程序

1. 分级（试点 runbook §2）：S1 安全/数据 15 分钟；S2 执行不可用 30 分钟、4 小时未恢复→回滚评估；S3 单任务 4 工作小时；S4 请求 1 工作日。
2. 只读先行：health.json、journal、verify、superuser psql（§0 RLS 纪律）。`work_ops` 只有 5 条 EXECUTE（requeue/skip_outbox_dead_letter、ops_delete_task、ops_cancel_run、transfer_task_ownership）、0 条 SELECT：读走 `/work/v1/admin/*` 或 `runuser -u postgres -- psql -d work`。
3. 写操作只走领域函数：一条一命令、一条一证据；`SET app.subject_id` 的主体由操作者自负（工单写明），执行后核对 `work.audit_event`。
4. 常用处置：
   - 停放 Run（workflow Running、闸有 success 回执）**[生产写]**：
     ```bash
     sudo -u work-control env $(grep -E '^(WORK_DATABASE_URL|WORK_TEMPORAL_)' /etc/work/work-worker.env | xargs -d'\n') \
       /usr/local/bin/work-reconcile -org <org> -operation <op> -signal-only
     ```
   - unknown 对账 **[生产写]**：`-resolution not_sent|sent_succeeded|rejected_not_executed -evidence-ref ticket:<id> [-settled-tokens N] [-resume]`；unresolved 不允许 -resume；token 查不到就记 0 并把"查不到"写进 evidence，**不为消警选 not_sent 抹掉真实消耗**。
   - 孤儿关闭（workflow Failed、DB 仍开放）：旧 runbook §5.16——先 -scan 取证 → pg_dump 备份 → 事务内 finish_run（先 ROLLBACK 验证）→ 补审计 → 复扫。
   - 死信：`work.requeue_outbox_dead_letter` / `work.skip_outbox_dead_letter`（work_ops，带理由）；重放安全性按试点 runbook §6；禁止直接 UPDATE/批量清空。
   - provider 凭据轮换/吊销 **[生产写]**：`work-provider-setup status -org <org>` → `rotate … -dry-run` → 去掉 -dry-run 执行 → status＋真实任务回归；Key 只走 `-secret-file`（0600 临时文件，用后删除），不进 argv/env/history；revoke 同样先 dry-run。详见旧 runbook §5.15。
5. `WorkAuditExportTokenFailureBurst` 属安全信号（一次性凭证疑似泄露），按秘密泄露处理，不当性能问题。

### 7.4 C16 日志扫描

- `work-c16-log-scan.timer` 每日扫 work-* journald 近 14 天；canary＝最近 40 条任务标题＋合成哨兵；正控必须 fire，否则 clean 结论无效（rc=1）。
- 手工复跑 **[只读，临时文件自清理]**：`sudo /usr/local/bin/work-c16-log-scan.sh`；wrapper 与 log-scan.mjs 必须同目录。
- 已知局限（2026-11-14 裁定＝不动规则）：带空格的散文正文抓不到；看到漏抓不自行放宽规则或加豁免。
- 仓库侧复跑：`cd docs/plan/assets/work-r0a-hardening-2026-10-25 && node --test log-scan.test.mjs`，取它自己的退出码。

## 8. 数据删除与留存

### 8.1 任务删除（tombstone＋内容粉碎）

- 用户自助：`DELETE /work/v1/tasks/{id}`（work.delete_task，owner-only）；前置任务静止，否则 409 `run_not_quiescent`——先取消并等终态，unknown/unresolved 先对账。
- 效果（同一事务）：task tombstone、标题 `[deleted]`、成果 tombstone、输入 deleted、去重标记 task_deleted、`content_shred` outbox（只含 content_ref）、审计 task.deleted。预算账本/审计/无正文 task_event 保留。
- 粉碎：work-relay 消费 content_shred 删 Content Store 对象，目标 24h 内；投递证据在 `work.outbox` 的 delivered_at/attempts，journal 只用于证否（content_delete_failed/content_store_unavailable）。
- 运维代删 **[生产写]**：`work.ops_delete_task(org, task, actor, ticket_ref, reason)`（work_ops）。
- 所有权转移 **[生产写]**：`work.transfer_task_ownership`（新 owner 同组织 active＋有席位、任务静止、管理员书面确认）；逐条执行，无批量捷径。

### 8.2 留存清扫（expiry_sweep）

- `work-retention-scan.timer` 每小时、逐 org 事务：expire_due_audit_exports / expire_due_inputs / shred_due_audit_exports（EXECUTE 仅 work_worker）；导出与未绑定输入 TTL 均 24h。
- 整批语义（expires_at <= now()），无按 id 入参；**input 侧绝不提前钟**（会把最近一天所有未绑定输入一起投删）。
- 只读预检：`sudo /usr/local/bin/run-retention-preflight.sh`（superuser＋ON_ERROR_STOP，六列欠账＋ctx 自证）。
- 停止 **[生产写]**：`systemctl stop work-retention-scan.timer`（disable 才跨重启不回来）。kill switch/组织停用停不了它（义务作业）；按组织的唯一开关是从 `WORK_RETENTION_ORGS` 摘除。
- 手工补跑用包装件 `run-retention-scan.sh`，不手抄 SQL；空 org 清单按配错退 1。
- `content_orphans` 只报不删、不进退出码；与 `shred_stuck` 同轮 PAIR 行一起看。refs−disk 稳态属正常（行比对象活得久），要盯的是 status='active' 行的 dangling 引用；孤儿先定性再决定回收，不写自动删除。

### 8.3 组织退出与留存期

1. 停用 **[生产写]**：`work.apply_execution_entitlement`（仅 work_operator，只有 SQL 入口，无 HTTP/CLI）；恢复是四步 ack（conflict→同 rev ack→rev+1 pending_ack→ack restored），不是"把标志改回来"；禁止裸 UPDATE work.org。详见旧 runbook §5.22。
2. 管理员导出所需成果 → 逐任务 ops_delete_task → 核对 content_shred 全部 delivered、死信=0。
3. 租户 DEK crypto-shred（需云 KMS，C13 未关闭——当前缺口，不得声称已完成）。
4. **审计保留 365 天**（P1-A）＋预算账本（财务留存）；供应商侧删除单独书面确认（C15）。
5. 备份按留存周期自然过期（试点 35 天），不做备份内单条擦除，试点协议写明。
6. 撤权后在途 Run 不自动取消（D-07 A）：拦新工作＋人工 `work.ops_cancel_run` 逐条（reason=entitlement_revoked）；不声称已停止外部动作，迟到用量照常结算。

## 9. 试点准入与 go/no-go

### 9.1 机器判据（原样执行，仓库根目录）

```bash
node --input-type=module -e "const p='./docs/plan/assets/work-r0a-ops-2026-10-25/',fs=await import('node:fs'),o=await import(p+'ops-model.mjs'),c=JSON.parse(fs.readFileSync(p+'pilot-checklist.json','utf8')),s=JSON.parse(fs.readFileSync(p+'slo-pilot.json','utf8')),g=o.goNoGo(c,s);console.log('go='+g.go,'blocker='+g.blockerCount,'start='+g.startBlockerCount,'pilot='+g.pilotBlockerCount,'scale='+g.scaleBlockerCount,'measurement='+g.measurementBlockerCount,'slo='+g.sloMeasuredCount+'/'+g.sloMetricCount,'residual='+g.residualCount,'unstatedReopen='+g.unstatedReopenCount)"
```

输入＝同目录 `pilot-checklist.json`＋`slo-pilot.json`，判定逻辑 `ops-model.mjs` 的 `goNoGo()`。

当前读数见 [status.md](status.md)（机器来源 [status.json](status.json)），现跑现取，不抄本文。go=false 即**不开 E8、不进真实客户数据**；闸门绿≠已试点，也≠残口为零。

### 9.2 切换状态机

- `off → pilot_on → rolled_back → pilot_on`（cutover-plan.json，validateCutover/canTransition 校验）。
- pilot_on 要求：C01–C05、C07、C10、C11、C14、C15、C17、C24、C27、C30、C31 done/waived＋4 项演练（RLS、kill switch、备份恢复、旧链接回滚）＋产品/安全/SRE 共同批准；当前 canTransition＝不允许。
- 回滚不等清单：SEV1、SEV2 超 4 小时或 go-gate 指标连续 7 天未达标 → Incident Commander 执行：组织停用阻断派发 → 切 flag → 验证读取/导出/删除可用、提交返回 403 `org_execution_unavailable` → 通知管理员；不删除新数据。
- 再开启：根因关闭＋C17＋旧链接演练；产品与 SRE 显式批准；席位显式重新授予，不自动恢复。

### 9.3 E8 准备（staging 入口，不是生产证明）

- 组织开通：`scripts/onboarding/create-org.sh`、`assign-seats.sh`（要求 `WORK_ONBOARDING_CONFIRM=1`，不做生产批量开通）。
- 黄金任务：`scripts/golden-tasks/run-golden-tasks.sh` 先 `--preflight`（只验 bootstrap/CSRF/任务列表，不创建任务）；正式 6 任务×3 次、每任务 ≥2 次通过、套件 ≥80%、单次成本 ≤200 分、端到端 p95 ≤180s。
- 开通检查单：组织投影＋owner、配额账户周期与 run_cap_tokens、凭据由 owner 在管理面创建（不预置）、通知渠道与 C24/C27 联系人。
- 新组织必须同时追加三个 org 清单（§2）；verify 会比对配置条数与目录 org 数并 WARN。