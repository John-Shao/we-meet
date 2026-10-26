# Work R0a 编排设计资产（D3）

本目录是 R0a Temporal 编排的**设计契约**，不是运行时实现，也不证明 Temporal/供应商可用。

## 文件

| 文件 | 用途 |
|---|---|
| `RunWorkflow.contract.ts` | RunWorkflow 输入/信号/查询、Activity 接口、重试策略、超时、错误分类 |
| `background-jobs.contract.ts` | D3 §11 六类非 Run 后台作业：调度参数、租约/幂等键、错误分类、义务作业与可停止作业划分、必需的指标/告警名 |
| `fault-matrix.yaml` | F01/F02/F03/F04/F07/F21/F23、D3-R01–R09 与 D3-N01–N06（后台作业）故障的预期状态；`measured` 字段记录已在数据库侧实测到的交错 |

## 校验

```bash
# 纯类型契约，不依赖 Temporal SDK
npx --yes -p typescript@5 tsc --noEmit --skipLibCheck \
  --target ES2022 --module ESNext RunWorkflow.contract.ts background-jobs.contract.ts

# 故障矩阵可解析（18 例：7 F + 5 D3-R + 6 D3-N）
python -c "import yaml; d=yaml.safe_load(open('fault-matrix.yaml', encoding='utf-8')); print(d['stage'], len(d['cases']))"
```

## 已验证

- TypeScript 契约（workflow + 后台作业）通过 `tsc --noEmit`。
- 故障矩阵 YAML 可解析，包含 18 个案例（7 个架构 F 用例 + 5 个 D3-R 专项 + 6 个 D3-N 后台作业用例）。
- **Temporal dev 参考纵切**：[work-temporal-slice-2026-10-25](../work-temporal-slice-2026-10-25/README.md)；F01/F02/F04/F07/F21/F23 + D3-R06–R09 **10/10** + normal smoke 1/1（2026-10-26 修订后连续 3 次通过）。

## 后台作业契约表达什么

- 六类作业：`outbox_relay`、`content_shredder`、`directory_projection_sync`、`audit_export_worker`、`expiry_sweep`、`dead_letter_ops`。
- **义务作业不可停**：`OBLIGATION_JOBS` = relay / shredder / 投影同步 / 清扫；只有 `audit_export_worker`（产生新工作）与提交/派发受 kill switch、组织停用影响。这把 D3 §11.3 的语义变成类型层面的常量，实现要绕开它就必须显式改契约。
- 领取带租约（`JobLease`）、收尾校验持有者、外部调用只在事务提交后进行；`work_*` 错误码只映射到公开 `service_degraded`。
- 指标/告警名不在此重复定义：`REQUIRED_JOB_METRICS`/`REQUIRED_JOB_ALERTS` 必须能在 D6 `telemetry-contract.json` 中找到，由 `telemetry.test.mjs` 跨资产校验。

## 未验证

- 未做 S1 拓扑/升级/DB-Temporal 偏移、outbox backlog/kill switch/org suspend 演练。
- D3-N02–N05 的**数据库侧交错**已用多连接竞态脚本实测（导出去重与租约接管、一次性凭证单次兑换、共享引用只粉碎一次、投影乱序/重复投递——其中投影丢更新是这批竞态测出并修复的），见 [D1 资产 README](../work-r0a-design-2026-10-25/README.md) 与 [D1 §6.1](../../work-r0a-data-design-2026-10-25.md)。
- 仍未执行：进程被杀的真实窗口（D3-N01 与 D3-N03 的崩溃点）、义务作业在 kill switch/组织停用下继续运行（D3-N06）、真实 worker 多副本与跨库时钟偏差下的租约接管——契约只是类型与预期状态，待实施验证（C20/C22）。
- 参考纵切使用 faux model + in-memory Temporal；未接真实 provider、sandbox、KMS 或生产 Temporal。
- 真实供应商回执查询、history 驻留、worker 升级/回滚、SSE 多实例均未验证。

## 与其他文档

- D3 设计说明：[../../work-r0a-orchestration-design-2026-10-25.md](../../work-r0a-orchestration-design-2026-10-25.md)
- R0a 详细设计计划：[../../work-r0a-detailed-design-plan-2026-10-25.md](../../work-r0a-detailed-design-plan-2026-10-25.md)
- D1 数据设计：[../../work-r0a-data-design-2026-10-25.md](../../work-r0a-data-design-2026-10-25.md)
- D2 API 设计：[../../work-r0a-api-design-2026-10-25.md](../../work-r0a-api-design-2026-10-25.md)
- 架构 §7/§21：[../../work-system-architecture-2026-10-25.md](../../work-system-architecture-2026-10-25.md)
