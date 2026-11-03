# R0a 决策征询单：reconcile 自动写路径是否纳入（2026-11-04）

**关联**：task #34（只读巡检已落地；写路径待裁）· **关联控制**：C03（DR2 编排故障矩阵）/ C22 · **决策人**：John · **状态**：待裁

## 1. 当前实现事实（按代码取证，非推测）

- **写路径存在但人工**：`work-reconcile` 支持 `-operation <id> -resolution <sent_succeeded|not_sent|unresolved|rejected_not_executed>`，可选 `-resume`/`-signal-only`/`-finish-from-receipt`，并要求 `evidence-ref`（除非 unresolved）——`cmd/work-reconcile/main.go:44-57`。语义：按工单人工核对 provider/outbox 真实结果后再改账本。
- **部署的定时单元刻意只读**：`work-reconcile-scan.{sh,service,timer}` 只跑 `-scan`（`Read-only orphan scan (no writes)`，`work-reconcile-scan.service:2`），命中或扫描失败以非零退出把单元标红，on-call 再按 runbook §5.13/§5.16 **人工**执行写路径（`work-reconcile-scan.sh:5` 明示"不做任何 reconcile_operation 写动作"）。
- 因此**今天没有自动写路径**；#34 的"待裁"是：是否要新增一个"发现孤儿→自动套用 resolution"的调度写路径。

## 2. 为什么这是运营安全问题，需裁定

`resolution` 的四选一（sent_succeeded / not_sent / rejected_not_executed / unresolved）依赖 **provider 侧真实结果**（请求到底发没发、成没成、对方认不认）。自动化要在无人核对时猜这四态之一去改账本 = 把"provider 权威事实"变成"Work 侧推断"，错了就是账本/幂等被污染，且不可逆地推进 outbox/reconcile 状态。

## 3. 选项与代价（逐项单选）

- **A（建议）保持人工写路径**：只读告警 + on-call 按工单核对后写。
  - 代价：MTTR = 人工时延；依赖 #35 work_ops 身份到位才能写。
  - 与既有设计一致（evidence-gated、definer 中介），R0a 无新增自动写码；#34 视为"按设计已交付"。
- **B 全自动 reconcile 写路径**：定时器发现孤儿即套 resolution。
  - 代价：需先补 provider 权威对账接口（`#27` 系），否则是拿推断改账本；R0a 明确不建议。
- **C 半自动**：仅对无歧义态（如 provider 明确 `not_sent` 可安全重驱）自动，其余人工。
  - 代价：需定义"无歧义"白名单 + 补对应单测/演练；介于 A/B，非零新增码。

## 4. 证据边界 / 后果分档

- 判"已按设计完成"只需确认：①只读 `-scan` 已上（已验，gates 绿）；②写路径人工 runbook 就绪（§5.13/§5.16 已在）；③#35 身份可登陆后可执行一次真写核对。
- 选 A 的后果：无；维持现状。选 B：账本被推断污染风险 → **不建议在试点期开**。选 C：需另立实现子任务 + 用例。

## 5. 需你给的

- **勾一项：A / B / C**（默认建议 A）。
- 若 A：把 task #34 从"写路径待裁"改记"按设计=人工写路径，只读巡检已落地"，无需再开发。
- 若 C：指定允许自动的 resolution 白名单，我据此加实现 + pg 用例。
- 若 B：需 `#27` provider 权威对账先落地（独立线）。

本单不代你裁定；A/B/C 中我倾向 A，但自动化写路径属运营安全边界，由你拍板。
