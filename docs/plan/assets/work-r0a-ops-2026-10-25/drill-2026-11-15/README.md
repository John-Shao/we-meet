# 11-15/16 演练 · 现场证据目录

**关联清单**：[../../../../work-r0a-drill-checklist-2026-11-15.md](../../../../work-r0a-drill-checklist-2026-11-15.md)（步号 P*/D1-*/D2-*/D3-*/D4-*/C13-0/C28-*/S1-R06* 与本目录一致）
**关联控制**：C03、C22、C13（A 裁定后只保留 C13-0 前置审计）、C28
**执行窗口**：2026-11-15 14:00 – 2026-11-16 18:00（+08:00）· 主持：John · 复核：无（自决日志 + 11-18 复评）

## 使用说明

- 每一步在 [verdict.json](./verdict.json) 里已按清单步号预置一行 `{step, verdict, ts, evidence:[...], notes}`；现场把 `verdict` 改成 `"pass" | "fail" | "na"` 并填 `ts`/`evidence`/`notes`。
- 附件按 `attachments/<step-id>-<kind>.<ext>` 命名放本目录 `attachments/`，`evidence` 里只填相对路径。kind 建议：`log` / `sql` / `png` / `describe` / `diff`。
- 演练完成回填本 README §"结论" → 按下方"回写映射"更新 `pilot-checklist.json` + 顶层 `work-project.md` §3.3。
- 未过的项目：**不放宽判据**（memory 铁律），改记 `fail` + 后果分档 + 重开条件；不把 checklist 状态从 partial 改成 done。

## 环境快照（执行前一次性填入，之后只读）

| 项 | 值 |
|---|---|
| 目标实例 |  |
| Helm revision |  |
| migration ledger |  |
| Temporal namespace / taskqueue |  |
| worker 版本 tag | v1= / v2= |
| 观察窗起点 |  |
| 参与人（现场） |  |

## 结论（演练结束填）

- 通过步：__/总步
- 失败步（附重开条件）：
- N/A（原因）：

## 回写映射（照清单最后一张表；每完成一行勾一项）

- [ ] D1-1..7 + D2-1..7 + S1-R06 全 pass → `pilot-checklist.C22.evidence` 追加"多节点拓扑、在途 server 重启、worker drain 实测 2026-11-15"
- [ ] D3-1..6 + D4-1..6c 全 pass → `C22.evidence` 追加"Temporal PG 故障恢复、配额饱和实测 2026-11-16"；`C22.status → done`
- [ ] D3-N01/N03/N06 真实环境 pass → `C03 §4(3)` 满足
- [ ] C13-0 判定：驱动不存在（当前代码事实，与 #40-A 一致）→ `C13.status` 保持 `partial`，不空跑 C13-1..8
- [ ] §4 全满足（U3 + D1-D4 + N01/N03 + S1）→ `C03.status → done`，DR2 签收

回写目标：`pilot-checklist.json` 对应 item；`work-project.md` §3.3；演练后签收单回写 `work-r0a-c03-u3-drills-2026-10-27.md` §2/§3。

## 失败/延期时

- 记录 fail 具体步号 + 症状 + 附件路径；
- 后果分档写 verdict.json `notes`；
- 若阻断 pilot gate：另开 task 并在 `pilot-checklist.C**` 上写 blocked/waived（waived 需另批）。
