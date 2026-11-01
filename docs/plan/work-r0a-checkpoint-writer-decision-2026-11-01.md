# Work R0a checkpoint 写入方决策单（2026-11-01）

> 状态：**待 John 自决**（无独立复核人；11-08 延迟复评）。本文不实现代码，只把 #280 从"未接线"这一事实，拆成两种合同读法与各自后果，供判定它是否真是 R0a 退出门。

## 问题

审计表 D4 行原写「真实执行窗口的 child checkpoint 写未观测」。2026-11-01 查实这不是观测缺口，而是**子进程侧没有调用方**：

- `src/work/node/src/content-client.mjs:392` `putCheckpoint(...)` 完整实现（refId/slot/hash/bytes 校验、本地先验摘要、单次尝试不重试、响应回读校验），但**非测试代码零调用点**。
- `src/work/node/src/child-pi.mjs:30,729` 只 `createContentClient(...)` 使用 `get`；没有任何内容端点环境变量接线。
- Work 主机 `journalctl -u work-content-proxy`：2026-10-31 00:09 之后整窗口只有 5 行（一次重启 + `listening addr=127.0.0.1:8444`），即 8444 **未服务过任何请求**（读也没有）。

## 两种读法与证据

**读法 A：D4 §6.3 的子进程 HTTP 合同适用于 R0a，因此 plan 必须自己提交 `model_request` 候选、execute 后必须写 `checkpoint_candidate`。**

- 依据：`work-r0a-runtime-egress-design-2026-10-25.md` 子进程 HTTP 合同表（`POST /runtime/v1/content/reserve-candidate`，kind 只允许 `model_request`/`checkpoint_candidate`，"plan 可提模型意图，execute 不可重写意图"）。
- 但同一段紧接一句：**"内容访问由代理形成服务端授权描述符，本轮纯模型只模拟这一步的结果，不实现引用图遍历"**；且该表的路径是 `/runtime/v1/content/*`，与已落地的 `src/work/internal/contentproxy/server.go:27-28`（`GET /internal/v1/content/{refId}` + `POST /internal/v1/checkpoints`）不是同一套路径。
- 后果：R0a 需要新增 plan 阶段（当前是单步模型调用）、给子进程接内容端点、并让控制面不再从回执构造 canonical successor。

**读法 B：R0a 落地合同已由 2026-10-30 的已签决定改写，checkpoint 写入方是控制面/egress，不是子进程。**

- 依据：`work-project.md` 2026-10-30「E2E 修复」第 (4) 条——"execute 子进程原本尝试读 content 并在本地写候选，与 D4 §6.2『plan 只有 work-content、execute 只有 work-egress』冲突；**现 execute 不读正文，由 egress 服务端装配 messages，控制面从可信回执与答案提交 canonical successor**"。
- 代码一致：`src/work/internal/egress/provider.go:27,36` 注释与字段表明 canonical `model_request` 摘要在 **egress 服务端**形成并由 gate 消费；`contentproxy` 的 checkpoint 路由保留为**受测能力**（`contentproxy_pg_test.go:262,386` 覆盖 `checkpoint:model:…:candidate` 的 reserve→Put→commit→回读）。
- 后果：#280 不是 R0a 缺实现，而是"该路由在 R0a 无生产调用方"；需要做的是一条**范围例外签收**（写明触发条件＝多步链路/R0b 本机执行/池化恢复），并把 D4 行措辞从"未接入"改为"R0a 无调用方，按例外延后"。

## 建议

按 B 处理，但**必须留下可核对的例外签收**，理由：A 会推翻 2026-10-30 已签的执行面边界（execute 不持正文），而 R0a 试点确实是单步链路；同时把"8444 在生产零流量"记成运行事实——它意味着内容代理目前只在测试里被证明可用，一旦 R0b 引入多步/本机正文，这条路径是首次真实运行，需要单独取证窗口。

## 退出门归属（2026-11-01 已定）

John 于 2026-11-01 判定**本项计入 R0a 退出门**，不放行到 R0b/多步链路。已在 `assets/work-r0a-ops-2026-10-25/pilot-checklist.json` 登记为 **C33（gate=pilot、blocking=true、status=todo）**，因此本项现在是试点 go/no-go 的组成部分：`goNoGo` 会把 C33 计入未关闭阻塞项（当前 start 3 / pilot 13 / scale 0）。A/B 仍未勾选，勾选定的是**关闭方式**而非是否阻塞。

## 签收栏

- [ ] John 选 A（R0a 内实现子进程候选写；需重开执行面边界）　日期：
- [ ] John 选 B（记范围例外 + 触发条件，D4 行改措辞）　日期：
- [x] John 确认计入 R0a 退出门（2026-11-01，已登记为 C33）　日期：2026-11-01
- [ ] 其他（写明）：

**不勾选 A/B 的后果**：状态源保持"child checkpoint 写在 R0a 无调用方、关闭方式待决"，C33 保持 `todo` 并继续阻塞试点 go/no-go，D4 行不得写成"已达成"，R0a 不标完成。
