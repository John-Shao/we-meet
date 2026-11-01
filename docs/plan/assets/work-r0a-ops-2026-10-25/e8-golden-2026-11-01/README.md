# E8 黄金任务 live 演练 — 2026-11-01 通过

**结论：通过（官方 `pilot-ops` 规则）。** 6 个黄金任务 × 3 次 = 18 次真实执行全部产出成果并通过自动检查；官方 `evaluateGoldenSuite` 给出 `passRatio=1`、`p95=33.262s`、`passed=true`。本文件取代 [e8-browser-2026-10-31](../e8-browser-2026-10-31/README.md)（`passRatio=0.667`、`p95=185.464s`、未通过）。

机器可读记录见 [pilot-run.json](./pilot-run.json)（含每次运行的 task/run/artifact id、成果 sha256、逐项检查结果、配额与时间线）。

## 执行方式与环境

| 项 | 值 |
| --- | --- |
| 目标实例 | `https://meet.we-meet.online/work`（JD ECS 36.151.147.217，即当前 pilot Work 实例，非独立预发） |
| 传输方式 | 已登录 in-app browser 内的同源 `fetch`（session cookie 为 HttpOnly，Node runner 无法注入） |
| 提交流程 | `POST /inputs` → `POST /task-previews` → `POST /tasks` → 轮询 `GET /tasks/{id}` → `GET /artifacts/{id}/versions/1/content` |
| 模板映射 | `tpl-report→analysis`、`tpl-plan→draft`、`tpl-summary→summary` |
| 提交节奏 | 24s 最小间隔（官方 runner 默认 `WORK_PILOT_MIN_INTERVAL_MS=24000`，即 2.5 starts/min）；任务 `created_at` 间隔实测均为 24.0s |
| 背景材料 | 官方 runner 的合成背景，按各任务 `background_chars` 精确补齐（G01 600、G02 1200、G03 400、G04 300、G05 2500、G06 3000 字） |
| 权限模式 | `ask_each` |

运行窗口（+08:00）：主套件 00:05:24–00:12:24，G05 补跑 00:16:35–00:17:25。

## 评估口径与来源核验

评估代码不是本地副本，而是从固定提交 `41f0bb289da3dea4a596f7ac10b7b9e747c83b63` 的 raw.githubusercontent 取回后**在页面内校验 sha256** 再导入执行的：

| 资产 | sha256 | 与仓库本地文件一致 |
| --- | --- | --- |
| `pilot-ops.mjs` | `eda74ca1e794eefe7fd914f196471bb0327a299eac4acb116b7adebc118d02ee` | 是 |
| `golden-tasks.json` | `f714267fd775d86199b04375bc6dc6d2c67a285ffd14c4e4f573fb87ec33f5c4` | 是 |

页面内只把 `node:fs` 导入替换成桩（`evaluateGoldenRun` / `evaluateGoldenSuite` / `CHECKS` 都不触碰文件系统）。`costCents` 按官方 runner 的口径固定为 0（Work 按 token 计价，见 D-08a），因此 `max_cost_cents_per_run=200` 这条规则**没有真实金额参与判定**；`reviewerApproved` 同官方 runner 保持 `null`，故三项人工检查不参与自动判定。

成果指纹做了双向交叉核对：对 18 个 artifact 重新下载原始字节自算 sha256，与平台自身记录的 `latest_artifact.content_hash` **18/18 完全一致**。

## 结果

套件（官方 `evaluateGoldenSuite`）：

```
perTask: G01 3/3 · G02 3/3 · G03 3/3 · G04 3/3 · G05 3/3 · G06 3/3
passRatio = 1        p95Seconds = 33.262        passed = true
```

逐次运行（完整字段见 `pilot-run.json`）：

| 任务 | 尝试 | task id | run id | artifact id | 字数 | 秒 | settled tokens |
| --- | --- | --- | --- | --- | --- | --- | --- |
| G01 | 1 | `a4af8164…` | `605d9d23…` | `e9c077c2…` | 899 | 12.3 | 1303 |
| G01 | 2 | `6ec6c921…` | `ca6708b5…` | `be6979d0…` | 807 | 29.4 | 1884 |
| G01 | 3 | `1b045b69…` | `95dfc04d…` | `25c15d09…` | 749 | 27.0 | 2694 |
| G02 | 1 | `11d1b725…` | `5d47a429…` | `3ceff77a…` | 676 | 30.4 | 2574 |
| G02 | 2 | `75510d08…` | `dab11641…` | `ee5b11c7…` | 719 | 18.5 | 2216 |
| G02 | 3 | `b4222949…` | `ed356ee1…` | `e03709f3…` | 1143 | 24.7 | 2008 |
| G03 | 1 | `021d3ea6…` | `d350fc4c…` | `f3203ff9…` | 738 | 25.1 | 1700 |
| G03 | 2 | `538f8891…` | `7820d66b…` | `f3243f4e…` | 905 | 32.7 | 1980 |
| G03 | 3 | `d69753ed…` | `67951568…` | `53939ca9…` | 729 | 23.9 | 1717 |
| G04 | 1 | `3453a3ae…` | `79d11820…` | `a27caa60…` | 938 | 27.8 | 2045 |
| G04 | 2 | `aca0f8ce…` | `ad6194c7…` | `e307f72f…` | 672 | 22.1 | 1633 |
| G04 | 3 | `866a8188…` | `5245afdd…` | `d2db79be…` | 685 | 24.6 | 1443 |
| G05 | 1 | `a0431b7d…` | `39a58f68…` | `c8bc73fe…` | 428 | 16.7 | 3708 |
| G05 | 2 | `3924b816…` | `89773c99…` | `1094daa1…` | 343 | 33.3 | 4505 |
| G05 | 3 | `de7d87c8…` | `0c004719…` | `10fee3b1…` | 392 | 12.1 | 3334 |
| G06 | 1 | `18c51e76…` | `ad0b27d8…` | `5fa43c8d…` | 339 | 12.5 | 2607 |
| G06 | 2 | `2150ea92…` | `50e5ce8e…` | `aca17cb4…` | 336 | 32.9 | 4358 |
| G06 | 3 | `f0b8d7ca…` | `d57d5fd8…` | `f8b28771…` | 351 | 17.6 | 3840 |

全部 18 次：`display_state=awaiting_acceptance`、`latest_run.state=succeeded`、`quota.reserved_tokens=0`；合计结算 45,549 tokens，端到端合计 423.6s。字数全部落在 golden 声明区间内（G01 600–2500、G02 600–2500、G03 400–2000、G04 400–2000、G05 300–1500、G06 300–1500）。

## 人工检查项的判定

`no_named_people`、`todos_have_owner_role`、`no_new_facts` 在 `pilot-ops.mjs` 中返回 `'manual'`，永远不会自动判失败，以下是对上述 sha256 成果的人工判定：

- **`no_named_people`（G03，3/3 通过）**：成果只出现角色名（培训负责人、课程经理、项目协调员、采购负责人、班主任、数据分析师、直线经理、预算负责人），无人名。
- **`todos_have_owner_role`（G05，3/3 通过）**：每条待办都带角色前缀（研发负责人、测试负责人、项目经理、运营负责人）。见下节，G05 首轮 3/3 未达标，补跑后才通过。
- **`no_new_facts`（G05、G06，6/6 通过）**：G06 只复述客户 A（登录步骤多、移动端加载慢）、客户 B（导出格式）、客户 C（权限与审计）三类事实，处理顺序沿用背景本身给出的建议顺序；G05 只复述周会记录（核心接口已完成、两个高优先级缺陷、范围不变、培训材料、本周冻结需求、下周回归、供应商接口延迟与数据迁移窗口风险），负责人角色来自背景列出的参会角色。

## 过程中的三次偏差与修正

1. **首轮用了通用背景**。第一次完整 18 次跑出来的成果虽然也全部通过自动检查，但背景是统一的通用文本，`no_new_facts` 因此不可判定。已用官方 runner 自带的逐任务 `BACKGROUNDS`（按 `background_chars` 精确补齐）重跑整套，本文件的证据集是这一轮及其 G05 补跑。
2. **`csrf_invalid` 连续 12 次**。首轮忠实执行中 G01/G02 之后，G03#1–G06#3 连续 12 次被 API 以 `csrf_invalid` 拒绝。根因是 CSRF 令牌内嵌 session revision（`src/work/internal/api/csrf.go` 的 `csrfPayload.Rev`），会话版本在套件中途轮换后旧令牌失效；这些请求在创建任务前即被拒，**未产生任何任务**。已修 runner：遇到 `csrf_invalid` 时重新 bootstrap 一次并重放该请求（`scripts/golden-tasks/run-golden-tasks.mjs`）。修复后的重跑需要 0 次刷新，18/18 成功。
3. **G05 首轮待办没有负责人角色**。首轮 G05 三次的待办只有事项没有负责人，`todos_have_owner_role` 人工判定不通过。已按 golden 定义把该检查所要求的角色标注写进 goal（与既有的章节、字数提示同一机制，只对声明了该检查的任务注入），补跑 G05 三次全部带角色且通过。被取代的三次记录在 `pilot-run.json` 的 `supersededRuns` 中（未删除任务）。

上述两处 runner 改动目前**未提交**（本地 `scripts/golden-tasks/run-golden-tasks.mjs` sha256 `d149301860…`，上游 `1b3dd2d7e` 为 `08fe05b732…`），单元测试 `node --test scripts/golden-tasks/run-golden-tasks.test.mjs` 2/2 通过。

## 组织内副作用

- 18 个证据任务全部 `awaiting_acceptance`、预留为 0、结算已记账，没有留下新的 held 预留。
- 本次会话在同一个演示组织里另有 45 个任务（18 个通用背景的探索轮 + 6 个部分轮 + 18 个证据轮中的 G05 首轮 + 3 个 G05 补跑），全部是普通用户任务、`reserved_tokens=0`，未取消、未删除。
- 仍有 9 个任务各自持有 100,000 tokens 预留（合计 900,000），全部创建于 2026-10-30 11:03–12:31（+08:00），**早于本次演练，未被触碰**：7 个仍为 `running` 且有 active run；另 2 个是 2026-10-31 用 `finish_run(...,'failed',...)` 关闭的孤儿，任务已终态、`active_run_id` 为空，但预留未释放。是否释放属于运维边界决策，本次未处理。

## 证据边界

- 本轮验证的是黄金任务的**内容与编排质量**（章节、字数、无编造链接、无提示词回显、步骤编号、建议给出、人工三项），不覆盖成本判定（`costCents` 恒为 0）、多浏览器/弱网/大文件、并发提交下的配额争抢。
- 传输通道是浏览器同源 `fetch` 而非 Node cookie runner；官方 runner 的 Node 路径仍只有 `--dry-run` + 本地 mock 自测覆盖。
- 人工三项检查的判定由执行者（John）作出，**未经外部复核**：2026-11-01 起独立复核人离队，该项按「自决日志 + 11-08 延迟复评」承接，判定依据逐条记在 `pilot-run.json` 的 `manualAssessment`；`reviewerApproved` 保持 `null`，不追认外部签名。。
- 移动端实机、U1 可用性研究、C22 DR 演练仍按原排期在外，不能因本轮通过而视为关闭。
