# R0a 决策单：内容图授权（F0-R5）

> 状态：**待签收**（John 主签；Lily 复核安全边界）
> 提出：2026-10-30　截止：2026-11-06
> 关联：[D4 §6.3](work-r0a-runtime-egress-design-2026-10-25.md)、[D1 §5.5](work-r0a-data-design-2026-10-25.md)、迁移 0011/0012、`internal/contentproxy`

## 1. 问题

内容代理目前只允许读取**绑定到当前 execution** 的引用。签名设计说“read scope 从已批准引用图推导”，并要求“全局模板等共享对象只有 snapshot 确认的只读视图，不因共享存储位置产生跨组织遍历权限”。但注册表里 `input`/`template` 引用按 task/run 登记、`execution_id` 为空，因此 plan 子进程取不到输入与模板正文——Pi 无法组装消息。

必须决定“共享引用如何被某个 execution 合法读取”，否则内容代理只能服务执行私有引用。

## 2. 候选

### A. 按 execution 复制引用行（推荐）

plan 片段注册时，控制面把该 execution 需要的 input/template 引用以 `execution_id` 绑定后登记（内容对象共享，元数据每 execution 一行）。

- 优点：代理规则保持唯一——“只认 execution 绑定”，无需在代理里推断图；撤权/墓碑按 execution 精确生效；与 0011 现有列完全兼容，无需新迁移。
- 代价：同一输入在多次 execution 下有多行元数据；slot 命名需带 execution 维度（如 `input:<execution>:<inputId>`），否则唯一约束冲突。
- 证据边界：不改 SQL 结构；需新增注册调用点与代理负例（跨 execution 拒绝）。

### B. 代理按 task/run 推导

代理读取 execution 的 task/run，再允许该 task/run 下的所有 `input`/`template` 引用。

- 优点：元数据不重复。
- 代价：代理需要新的 execution→task/run 查询面；同一 Run 的多个 execution 共享全部引用；“引用图”退化为“同 Run 全量”，比签名更宽。
- 证据边界：需新增 SQL 读命令与代理逻辑，安全面变大，Lily 需复核。

### C. 片段显式携带允许的 ref 列表

plan 片段在 payload 中列出允许读取的 ref_id，代理按列表放行。

- 优点：最小授权、可审计。
- 代价：片段契约需升版本（当前 `work-runtime-fragment-v1` 为闭集，`additionalProperties:false`）；列表本身成为授权依据，须由 Go 签名/绑定到 execution，否则等于自报授权。
- 证据边界：需要 fragment 契约增量与双端校验，改动最大。

## 3. 推荐

**A**：它把授权判定收敛为一条现有规则，避免在代理里新增“图推导”这一安全面；代价仅是元数据重复，可在 slot 命名里解决。

## 4. 不答复的后果

内容代理无法服务 plan 片段，Pi 子进程只能跑执行私有引用，R0a 无法产生真实模型结果；egress/workflow 接线也无法端到端验证。默认按 A 继续会被视为未签收的实现选择，不能作为架构闭环证据。

## 5. 签收

- [x] John：**选择 A**（按 execution 复制引用行）　2026-10-30
- [x] Lily：**复核通过**（跨 execution 拒绝、slot 命名、墓碑语义）　2026-10-30
