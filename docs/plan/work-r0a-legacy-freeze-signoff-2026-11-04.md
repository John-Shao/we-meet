# R0a 旧 Work 冻结面签收单（C29）

日期：2026-11-04 ｜ 提出：后端＋产品 ｜ 签收人：John（产品/前端/后端）｜ 截止：**2026-11-08 复评**（与 #40/#48、checkpoint 例外等同批复评）

## 1. 为什么要这张单

`pilot-checklist.json` 的 C29 写的是「旧 Work 数据/路由冻结为只读，不迁移、不双写」，状态一直停在 partial，
原因记在 note 里：**「旧任务根本读不到」这件事从来没被签过，是从删除事实里推断出来的**。
同一周里还有三处文档在指挥人期待旧行为（见 §3）。这张单把「读不到」变成一句可签的话，并把那三处更正留在原地（不删历史）。

## 2. 事实清单（逐条可按原文回读）

| # | 事实 | 证据 |
|---|---|---|
| 1 | D-06 已正式签 A：不迁旧数据、不双写、新表从空开始 | `work-r0a-detailed-design-plan-2026-10-25.md:520-530`（选项文本）、`:655`（签收行「**正式签收 A** \| 不迁旧数据」，2026-10-27） |
| 2 | 旧 Work 代码面已删除 | `docs/plan/work-r0a-host-wire-decision-2026-10-28.md:188`：Django work app、`/work/v1`、`/work/metrics`、前端 `/work` 与旧依赖已删除；`src/backend/work` 目录已不存在；`src/work/README.md:5` 明令不得 import 旧实现 |
| 3 | 旧 Work 数据面已删除 | 同上行文：meet 库 12 张 `public.work_*` 表与 11 条 work 台账已 drop（另见 `work-project.md:203`） |
| 4 | 旧链接现在只显示一条通知，不显示任何旧任务数据 | `src/frontend/src/features/work/r0a/routes/ArchivePage.tsx:15-18`（`legacyTask` 存在时列表被强制为空）、`:34-36`（只渲染 `archive.legacyNotice`）、`:38`（其余全部隐藏）；`legacyRedirect.ts:12-16` 把 `/work?task=` 转成 `/work/archive?legacyTask=:id` |
| 5 | 旧 id 走 API 也是 404，且已有负例断言 | `src/work/internal/api/task_detail.go:97-100`（非法/未知 id → `task_not_found`）；契约 `src/work/contracts/error-codes.json` `task_not_found.status=404`；用例 `src/work/internal/api/task_detail_test.go:85-88`（含固定 UUID 的深链 404 断言） |
| 6 | 没有任何迁移/双写/回填读旧数据的路径 | `src/work/migrations/increments/0007_org_provision_backfill.sql` 是给**新**组织配额度，不读旧表；`src/work` 下无 `*legacy*`/`*dual_write*`/ETL 文件；`internal/migrate/baseline_sync_test.go:17-20` 的 legacy 比对已永久自跳过（`t.Skip("legacy source removed after cutover")`） |

## 3. 本轮更正的三处「活指令」（原文保留，就地加注）

1. `cutover-plan.json` 的 `states.rolled_back.legacy_routes` 原写 `unchanged legacy behaviour restored`——
   回滚不可能恢复已删除的路由；现同串保留原文＋2026-11-04 更正。`states.off` 的两处「legacy page」同样过期，已注。
2. `work-r0a-pilot-operations-runbook-2026-10-26.md` §8 的「180 天只读留存提案（待法务签收）」与 §9 表格行——
   留存期已无对象；法务要签的不再是留存期，而是本单 §4 那句话。
3. 成果页/归档页文案：`archive.legacyNotice` 五语言原文把旧任务称作「read-only / 只读」，
   实际是**读不到**。现五语言改为如实表述（保留 `{{task}}` 占位），并由
   `docs/plan/assets/work-r0a-design-2026-10-25/test/legacy-freeze-claims.test.mjs` 钉住：
   任何「restored / shows legacy page / 180 天」表述若不带 2026-11-04 更正就红。

## 4. 请签的那一句

- [ ] **我确认：旧 Work 任务在新 Work 中不可读、不可打开、不可导出；「只读冻结」一词在本项目此后仅用于
      新 Work 自身的回滚状态（`rolled_back.new_routes`），不再用于旧任务。** 旧链接只显示一条通知
      （显示原 id 供用户辨认），这是对用户的最诚实形状；如需"看起来还能读"的替代方案，须另开裁定并
      重新提供数据来源，而该来源已 drop。

签收人：＿＿＿＿＿＿  日期：＿＿＿＿＿＿

## 5. 证据边界（本单证明到哪儿，不证明什么）

- 证明：代码面与数据面都已删除；UI 与 API 的当前行为；三处过期指令已更正并有机器断言防止复现。
- **不证明**：法务/数据协议层面对「旧数据从未被合规删除」的独立结论（本单只陈述技术事实，
  DPA/法务口径归 C27/C30，签收人仍是外部）；也不证明用户从未导出过旧数据。
- 若有人将来恢复旧路由或重建旧表，本单的结论失效，C29 需重新取证。

## 6. 不签的后果（分档）

- 保持现状：C29 继续 partial，R0a 试点准入仍缺一项 blocking；文档与文案已如实，**不会误导值班**（这是本轮已修掉的实质风险）。
- 签了：C29 → done，剩余 blocking 从 14 降到 13；法务问题从「留存期」改为「已删除」的事实告知，
  与 C27/C30 的外部签收同批追。
