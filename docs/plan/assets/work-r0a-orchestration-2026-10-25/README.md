# Work R0a 编排设计资产（D3）

本目录是 R0a Temporal 编排的**设计契约**，不是运行时实现，也不证明 Temporal/供应商可用。

## 文件

| 文件 | 用途 |
|---|---|
| `RunWorkflow.contract.ts` | RunWorkflow 输入/信号/查询、Activity 接口、重试策略、超时、错误分类 |
| `fault-matrix.yaml` | F01/F02/F03/F04/F07/F21/F23 与 D3 专项故障的预期状态 |

## 校验

```bash
# 纯类型契约，不依赖 Temporal SDK
npx --yes -p typescript@5 tsc --noEmit --skipLibCheck \
  --target ES2022 --module ESNext RunWorkflow.contract.ts

# 故障矩阵可解析
python -c "import yaml; d=yaml.safe_load(open('fault-matrix.yaml', encoding='utf-8')); print(d['stage'], len(d['cases']))"
```

## 已验证

- TypeScript 契约通过 `tsc --noEmit`。
- 故障矩阵 YAML 可解析，包含 12 个案例（7 个架构 F 用例 + 5 个 D3 专项）。

## 未验证

- 未接 Temporal Server/SDK、未执行任何故障注入。
- D1 增量命令（wait/resume/mark unknown/reconcile、workflow-start outbox）尚未实现。
- 真实供应商回执查询、history 驻留、worker 升级/回滚、SSE 多实例均未验证。

## 与其他文档

- D3 设计说明：[../../work-r0a-orchestration-design-2026-10-25.md](../../work-r0a-orchestration-design-2026-10-25.md)
- R0a 详细设计计划：[../../work-r0a-detailed-design-plan-2026-10-25.md](../../work-r0a-detailed-design-plan-2026-10-25.md)
- D1 数据设计：[../../work-r0a-data-design-2026-10-25.md](../../work-r0a-data-design-2026-10-25.md)
- D2 API 设计：[../../work-r0a-api-design-2026-10-25.md](../../work-r0a-api-design-2026-10-25.md)
- 架构 §7/§21：[../../work-system-architecture-2026-10-25.md](../../work-system-architecture-2026-10-25.md)
