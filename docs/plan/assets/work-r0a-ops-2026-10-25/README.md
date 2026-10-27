# Work R0a 安全/运维/容量/试点资产（D6）

本目录是 R0a 试点的**安全控制、SLO、容量模型与 go/no-go 清单**，不是生产证据或演练记录。

## 文件

| 文件 | 用途 |
|---|---|
| `security-controls.json` | S01–S18 威胁/控制/证据/状态/owner/关闭条件 |
| `slo-pilot.json` | 试点内部 SLO 口径、窗口、来源、状态 |
| `pilot-checklist.json` | 设计/实现/安全/运维/产品/迁移的 blocking 清单 |
| `pilot-capacity-model.mjs` | 3 组织/20 席位/10 并发的试点容量模型 |
| `telemetry-contract.json` | 12 个 SLO 的指标/标签/记录规则/告警/runbook 契约；禁止正文/密钥标签 |
| `generate-telemetry.mjs` | 生成 `prometheus-rules.yaml`；`--check` 检测漂移 |
| `prometheus-rules.yaml` | 21 条 recording rule + 27 条告警（15 SLO + 12 operational）= 48 条规则 |
| `prometheus-rules.test.yml` | promtool 告警单测：13 组输入序列、14 条断言，触发与不触发两侧都测 |
| `telemetry-model.mjs` | 契约/SLO/runbook/标签/PromQL 引用校验 |
| `telemetry.test.mjs` | 11 组测试（覆盖、target 对齐、track-only、篡改负例、漂移、与 D3 作业契约的跨资产一致性） |
| `ops-model.mjs` | 控制/SLO/清单校验与 go/no-go |
| `ops-model.test.mjs` | 9 组测试（含 S17/S18 存在性与冻结契约里禁 `download_url`） |

## 校验

```bash
cd docs/plan/assets/work-r0a-ops-2026-10-25
node generate-telemetry.mjs --check
node --test ops-model.test.mjs telemetry.test.mjs
node pilot-capacity-model.mjs

# 用真实 Prometheus 工具校验规则与告警语义（需 Docker；CI ops-telemetry job 同一条命令）
docker run --rm -v "$PWD:/w:ro" --entrypoint sh prom/prometheus:v2.54.1 \n  -c "promtool check rules /w/prometheus-rules.yaml && promtool test rules /w/prometheus-rules.test.yml"
# Windows Git Bash 会改写 -v 路径，需要 MSYS_NO_PATHCONV=1 且用绝对盘符路径

python -c "import json; [json.load(open(f, encoding='utf-8')) for f in ['security-controls.json','slo-pilot.json','pilot-checklist.json','telemetry-contract.json']]; print('json-ok')"
```

## 已验证

- 11/11 ops + 6/6 pilot-ops + 11/11 telemetry 测试通过（共 28/28；黄金任务/试点指标/切换状态机见 `pilot-ops.mjs`）：控制字段/证据、SLO 必需指标/未测不冒充、清单完整性、go/no-go、容量基线、10× 失败、零使用、非法输入；12 个 SLO 全覆盖、target/window/unit 与 `slo-pilot.json` 对齐、track-only 不产生 SLO 告警、缺失/篡改/内容标签/错误 runbook 被拒。
- `prometheus-rules.yaml` 由契约生成且无漂移：21 条 record、27 条 alert；`promtool check rules`（prom/prometheus:v2.54.1）报告 **SUCCESS: 48 rules found**，`promtool test rules` 对 `prometheus-rules.test.yml` 的 13 组序列、14 条断言 **SUCCESS**。2.54 的 promtool 只支持 `alert_rule_test`（单数）并比较标签与注解，没有表达式单测，所以慢查询类告警改用可被单测覆盖的平均耗时形式；每条告警带 severity/for/runbook 与 `org_id` 注释；标签白名单禁止 goal/background/prompt/content/body/email/api_key/authorization/cookie/session。
- 当前 `goNoGo`：**no-go，30 个 blocking 中 18 个未关闭**，并按 `gate` 拆开：`start`（DR4 开工前必须关闭）**4 项**（C01/C02/C11/C14 已提前签，C15 已 waived）、`pilot`（试点前）14 项、`scale` 0 项；`canStartWork` 为 false。关闭全部 start 项只会让 `canStartWork` 变 true，试点 `go` 仍需 14 项实施证据。
- 基线：36 Run/日、108 模型 Operation/日、7.5 provider req/min、0.125 DB 预留/秒、1.296M token/日、1.156GB/365 天；均在试点限制内。
- S1 参考演练：worker 重启、DB 终态偏移、执行开关/组织停用、outbox backlog 4/4，`patched` 升级 1/1，file-backed server 重启为修订前结果（未复跑）；见 [Temporal slice](../work-temporal-slice-2026-10-25/README.md)。
- 本地关闭：C12 RLS 池化 3/3；C18 10 并发 1.774s；C19 Work DB 恢复计数一致；C20 S1-R03；C21 on-call runbook。30 个 blocking 中 18 个未关闭（C01/C02/C11/C14 已提前签，C15 已 waived）。
- 10× 压力会触发 provider RPM/token、workflow、内容留存与并发限制。

## 后台作业遥测（2026-10-26 增补）

D3 §11 的六类非 Run 作业现在有指标与告警：

| 类别 | 数量 | 关键项 |
|---|---|---|
| 指标 | 28 | `work_background_job_runs_total{kind,outcome}`、`work_background_job_last_success_seconds{kind}`、`work_background_job_lease_takeovers_total`、`work_directory_projection_lag_seconds`、`work_audit_export_backlog`、`work_audit_export_duration_seconds_sum`/`_count`、`work_audit_export_downloads_total{outcome}`、`work_content_shred_backlog` |
| 告警 | 27（15 SLO + 12 运维） | 新增 `WorkBackgroundJobStale`、`WorkBackgroundJobLeaseTakeovers`、`WorkDirectoryProjectionStale`、`WorkAuditExportBacklog`、`WorkAuditExportFailureRatio`、`WorkAuditExportSlow`、`WorkAuditExportTokenFailureBurst`、`WorkContentShredBacklog`，全部指向[运行手册 §5.1 后台作业故障处置](../../work-operations-runbook-2026-10-25.md) |
| 控制 | 18（S01–S18） | S17 目录投影写入与新鲜度；S18 治理读越权与一次性下载入口 |

`telemetry.test.mjs` 额外做两项跨资产一致性校验：D3 `background-jobs.contract.ts` 声明的作业指标/告警名必须在契约里存在，且"义务作业"（relay/shredder/投影同步/清扫）与"产生新工作的作业"（导出 worker）的划分必须与类型契约一致；`ops-model.test.mjs` 断言 `S17/S18` 存在且冻结集里不出现 `download_url`。

## 未验证

- **遥测未接入**：没有 Prometheus scrape、仪表盘、Alertmanager 或真实告警投递；规则已由 `promtool` 校验并带告警单测，但**没有真实序列**——阈值是否合适应在试点数据上复核，所有 SLO 仍为 `not_measured`。
- 指标/告警保留 `org_id`；task/run/operation ID 不进入指标标签（高基数），需由 exemplar/trace/结构化日志关联。
- 未做试点压测/备份恢复/停用/kill switch/RLS 池化演练。
- 未接真实 Temporal、沙箱、KMS、Content Store 或供应商条款。
- 3 家组织、5–8 名研究、golden tasks、支持/删除/所有权转移均未完成。
- 容量模型是设计计算，不是生产容量证明；区域 DR 不在 R0a 范围。

## 与其他文档

- D6 设计说明：[../../work-r0a-security-ops-migration-design-2026-10-25.md](../../work-r0a-security-ops-migration-design-2026-10-25.md)
- 威胁模型：[../../work-threat-model-2026-10-25.md](../../work-threat-model-2026-10-25.md)
- 运行手册：[../../work-operations-runbook-2026-10-25.md](../../work-operations-runbook-2026-10-25.md)
- R0a 详细设计计划：[../../work-r0a-detailed-design-plan-2026-10-25.md](../../work-r0a-detailed-design-plan-2026-10-25.md)
