# Work 运维手册（精简操作入口）

> 本文档是 Work 模块的精简操作入口：只保留"执行什么、按什么顺序、如何判定"。
> 详细参考仍是旧 runbook（架构、裁定史、故障注入与逐次取证都在那里，本文不复述）：
>
> - [work-operations-runbook-2026-10-25.md](ops/work-operations-runbook-2026-10-25.md)：升级/灾备/SLO/故障注入，§5.x 是各专题值班口径。
> - [work-r0a-pilot-operations-runbook-2026-10-26.md](ops/work-r0a-pilot-operations-runbook-2026-10-26.md)：试点运营（支持分级、删除、死信、切换）。
>
> 命令与本文冲突时，以仓库脚本/unit 为准：`src/work/deploy/ecs/`、`src/work/scripts/`、`deploy/aliyun/`。

## 0. 现状快照与操作纪律

现状（2026-11-14 已核实；执行任何写操作前先现场重读）：

- 现网最新包 `work-release-0039`，迁移台账 `tip_version=39`。
- 增量 0040–0043（设备面 16 表）已落仓库、**未 rollout**；需要链尾 43 的新包＋窗口当场生产写授权＋同二进制重放预检（§3.4）。
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
| work-chain-check.service | 链尾启动闸（oneshot，root） | 无 | /root/work-secrets.env |

- `work-chain-check` 由 `work-api.service` 的 `Requires=` 拉起（卡片 V）；**现网 work-api unit 仍是无此闸的旧版**，随下次 rollout 安装后生效（§3.5）。
- Temporal 在 k8s 侧（资产 `deploy/aliyun/temporal/`），worker/relay 经 mTLS 连 `WORK_TEMPORAL_ADDRESS`（模板值 10.43.147.249:7233，namespace `work-r0a`）。

Timer 清单（周期以 `systemctl list-timers` 现读为准）：

| Timer | 周期 | 性质 |
|---|---|---|
| work-healthcheck.timer | 每 2 分钟 | 只读探针＋邮件告警 |
| work-reconcile-scan.timer | 每 15 分钟 | 只读孤儿巡检 |
| work-runstream-scan.timer | 每 10 分钟 | 只读运行流读数 |
| work-retention-scan.timer | 每小时（Persistent） | **生产写：到期清扫＋粉碎投递** |
| work-c16-log-scan.timer | 每日（Persistent） | 只读日志扫描 |
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
# [生产写] 0018/0023 之前：work_governance_events / work_operator 组角色（＋可选 login）
WORK_GOVERNANCE_EVENTS_PASSWORD=… [WORK_OPERATOR_PASSWORD=…] \
  ./src/work/deploy/ecs/provision-r0b-roles.sh [--dry-run]
```

workload PKI 由 `init-workload-pki.sh` 生成（/etc/work/runtime-ca，幂等不覆盖；rollout 在 CA 缺失时自动跑）。

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

- baseline：0001（角色前置，不可执行）＋0002（初始 schema）；增量 0003–0043。
- 整链内嵌在 `work-migrate` 二进制（migrations/embed.go）；manifest.json＋catalogs 钉 checksum；账本表 `work.schema_migration`。
- 现网 tip=39。0040–0043＝设备面 16 表；在装 work-migrate 对它们零命中，**必须先出链尾 43 的新包**，裁定为整包一次上（39→43）。

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

### 3.4 rollout 0040–0043 的三道前置

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

**只读前置取数**（rollout 前另有两个主机侧只读探针，跑完即删，判据取脚本自身退出码 `HOST_SCRIPT_RC=0`）：`docs/plan/assets/work-r0a-ops-2026-10-25/preflight/rollout-preflight-ledger-read.sh`（台账/在途 Run/预留/outbox）与 `rollout-preflight-package-shape-read.sh`（发布包形状/在装件比对）。取数形状：

```bash
ssh -i ~/.ssh/id_ed25519 -o BatchMode=yes johnshao@<work-ecs> 'cat > /var/tmp/pf.sh && sed -i "s/\r$//" /var/tmp/pf.sh && sudo -S -p "" bash /var/tmp/pf.sh < ~/sudo-pass.txt; rc=$?; rm -f /var/tmp/pf.sh; echo HOST_SCRIPT_RC=$rc' < docs/plan/assets/work-r0a-ops-2026-10-25/preflight/rollout-preflight-ledger-read.sh
```

读数现取（tip_version/open_runs/RELEASE_DIRTY 等由脚本打印），不在本文手抄；现网迁移 tip 与发布包见 [status.md](status.md)。

### 3.5 装后验证与链尾闸 [只读]

- `sudo ./verify-r0a-0027.sh "<开始时刻>"`：`rows=N max=N`、清单 all present、函数体探针 true（claim_carries_takeover、terminal_release_guard、export_discovery_hardened、0040–0043 设备面探针等）。
- unit active 且无 STALE（进程仍跑被替换的旧 inode）；rollout 第 10 步自动查。
- 链尾闸（随 rollout 安装后）：work-api 每次启动先跑 `ecs-migrate.sh status -require-up-to-date`。两种指纹方向相反：
  - `ledger_pending_increments`（账本落后于二进制）→ 向前补链（apply/完整 rollout）；
  - `ledger_version_unknown`（二进制落后于账本）→ 换回含该版本的二进制，**绝不为启动改账本**。

## 4. 健康检查

### 4.1 自动探针与告警

`work-healthcheck.timer` 每 2 分钟跑 `work-healthcheck.sh`，检查：`http://127.0.0.1:8080/healthz`=200；Host `/work-host/v2/orgs`=200（客户端证书）；观察名单 unit（directory-sync×2、reconcile-scan、runstream-scan）Result≠failed；relay active；worker 在 enabled 时 active；30 分钟内两类同步报告且 `"errors":[]`；/etc/work/certs 与 /etc/work/temporal 证书 30 天内不到期。

- 状态：`/var/lib/work/health.json`；异常：`/var/log/work-health-alerts.log`＋journal。
- `work-health-alert.py` 状态变化发信（ok→degraded 立即；持续 degraded 每 6 小时；恢复发信）。只有邮件通道；SMTP 失败在 journal 搜 `health alert delivery failed`。
- **不要手跑 work-healthcheck.sh 取证——它会发信**。只读取证：

```bash
cat /var/lib/work/health.json                                         # [只读]
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/healthz # [只读]
sudo systemctl list-timers 'work-*' 'meet-db-backup*'                 # [只读]
journalctl -u work-reconcile-scan.service -o cat | tail               # [只读] orgs=N orphans=M scan_errors=K
journalctl -u work-runstream-scan.service -o cat | tail               # [只读] BREACH/ok＋六条读数
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

### 7.2 扫描 unit 退出码（值班读法）

| Unit | rc=0 | rc=1 | rc=2 | rc=4 |
|---|---|---|---|---|
| work-reconcile-scan（15min） | 干净 | org 扫描失败 | 发现孤儿 | — |
| work-runstream-scan（10min） | 无越限 | 调用失败/缺读数 | parked_runs>0 或 held_on_terminal>容差 | — |
| work-retention-scan（hourly） | 干净（扫到 N 行属正常） | 调用失败/缺读数 | content_shred 卡住 >15min 宽限窗 | — |
| work-c16-log-scan（daily） | 干净 | preflight 失败/正控未 fire | — | 发现正文/秘密 |

- `parked_runs` 排除 waiting/quota（有意状态，24h 上限）；waiting/reconcile 不排除——那是"24 小时窗口决定要不要救"，每小时 BREACH 是设计内的钟，不是告警坏了。
- `orphans=0` ≠ 没有停放 Run（workflow 仍 Running 的那类孤儿规则看不见）；`held_on_terminal` 容差现值 0，泄漏一笔即红。
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