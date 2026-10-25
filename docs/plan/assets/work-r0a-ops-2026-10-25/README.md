# Work R0a 安全/运维/容量/试点资产（D6）

本目录是 R0a 试点的**安全控制、SLO、容量模型与 go/no-go 清单**，不是生产证据或演练记录。

## 文件

| 文件 | 用途 |
|---|---|
| `security-controls.json` | S01–S16 威胁/控制/证据/状态/owner/关闭条件 |
| `slo-pilot.json` | 试点内部 SLO 口径、窗口、来源、状态 |
| `pilot-checklist.json` | 设计/实现/安全/运维/产品/迁移的 blocking 清单 |
| `pilot-capacity-model.mjs` | 3 组织/20 席位/10 并发的试点容量模型 |
| `ops-model.mjs` | 控制/SLO/清单校验与 go/no-go |
| `ops-model.test.mjs` | 8 组测试 |

## 校验

```bash
cd docs/plan/assets/work-r0a-ops-2026-10-25
node --test ops-model.test.mjs
node pilot-capacity-model.mjs

python -c "import json; [json.load(open(f, encoding='utf-8')) for f in ['security-controls.json','slo-pilot.json','pilot-checklist.json']]; print('json-ok')"
```

## 已验证

- 8/8 测试通过：控制字段/证据、SLO 必需指标/未测不冒充、清单完整性、go/no-go、容量基线、10× 失败、零使用、非法输入。
- 当前 `goNoGo`：**no-go，28 个 blocking 项**。
- 基线：36 Run/日、108 模型 Operation/日、7.5 provider req/min、0.125 DB 预留/秒、1.296M token/日、1.156GB/365 天；均在试点限制内。
- 10× 压力会触发 provider RPM/token、workflow、内容留存与并发限制。

## 未验证

- 未接 SLO 遥测/告警；未做试点压测/备份恢复/停用/kill switch/RLS 池化演练。
- 未接真实 Temporal、沙箱、KMS、Content Store 或供应商条款。
- 3 家组织、5–8 名研究、golden tasks、支持/删除/所有权转移均未完成。
- 容量模型是设计计算，不是生产容量证明；区域 DR 不在 R0a 范围。

## 与其他文档

- D6 设计说明：[../../work-r0a-security-ops-migration-design-2026-10-25.md](../../work-r0a-security-ops-migration-design-2026-10-25.md)
- 威胁模型：[../../work-threat-model-2026-10-25.md](../../work-threat-model-2026-10-25.md)
- 运行手册：[../../work-operations-runbook-2026-10-25.md](../../work-operations-runbook-2026-10-25.md)
- R0a 详细设计计划：[../../work-r0a-detailed-design-plan-2026-10-25.md](../../work-r0a-detailed-design-plan-2026-10-25.md)
