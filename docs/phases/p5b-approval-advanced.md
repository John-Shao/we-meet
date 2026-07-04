# P5b — 审批进阶:会签 / 条件分支 / 抄送

状态:📝 设计待拍板

> 承接 [`p5-approval.md`](./p5-approval.md)。P5 MVP(串行单链 + IM 通知)已上线;本会话又补了 **催办(urge)**、**委托(delegate)**、**needs_assignment 恢复**(见下)。本文档设计 P5 的三个「Later」大项 —— 它们都要动**状态机 / 模型**,故先出设计再开干。

## 一、现状 / 缺口

**已实现(P5 MVP + 增量):**
- 串行单链:`ApprovalInstance.current_node`(单 int 指针)+ `ApprovalTask`(每节点一 Task,`unique(instance, node_index)`)+ 四种审批人解析(direct_manager/department_head/org_role/user,含向上 + org owner fallback)。
- 发起 / 通过 / 驳回 / 撤销 + IM DM 通知。
- **催办**:`approval.urge()`(发起人重发提醒)+ `POST /approvals/{id}/urge/`。
- **委托**:`ApprovalDelegation`(delegator→delegate + 时间窗)+ `resolve_approver` 单跳替换。
- **needs_assignment 恢复**:`approval.retry_assignment()` + admin 动作。

**本阶段要补的三项(均需改状态机/模型):**
1. **会签** —— 一个节点多个审批人,**并签(全签)** 或 **或签(任一)**。
2. **条件分支** —— 按 `form_data` 的值决定某节点是否需要(如「报销 > 5000 才要总监批」)。
3. **抄送(CC)** —— 通知一批人「知会」,不参与审批、不阻塞流程。

## 二、核心设计决策

### E1 会签 = 「跨节点串行,节点内并行」
不改「串行推进节点」的骨架,只让**单个节点内部**可有多个并行 Task。

- **flow 节点扩展**(向后兼容,旧节点 = 默认单签):
  ```jsonc
  // 旧(单签,继续可用):
  { "type": "direct_manager" }
  // 新(会签):
  { "mode": "and",           // and=并签(全批) | or=或签(任一) | single(默认)
    "approvers": [           // 多条子规则,各解析出一个 User,去重
      { "type": "user", "user_id": "..." },
      { "type": "org_role", "role": "administrator" },
      { "type": "department_head", "department_id": "..." }
    ] }
  ```
  - `mode` 缺省 = `single`,`approvers` 缺省 = 用节点自身的旧 `type` 单解析 → **完全兼容现有模板/实例**。
  - 也支持「一条规则出多人」:如新增子规则类型 `org_role_all`(该 role 全体)、`department_members`(某部门全体)。MVP 先支持 `approvers` 列表逐条解析成人。

- **模型改动**:
  - 去掉 `unique(instance, node_index)`;改为 `unique(instance, node_index, approver)`(同节点同人不重复;`approver` 可空的 CC/needs_assignment 行需特殊处理,见 E3/风险)。
  - `ApprovalTask` 无需加字段即可承载多行(靠 node_index 聚合)。

- **节点完成判定**(`act()` 后对当前 node_index 的所有 Task 聚合):
  - `and`:全部 approved → 节点过、推进;**任一 rejected → 实例 rejected**。
  - `or`:**任一 approved → 节点过、推进**;全部 rejected → 实例 rejected(首个 reject 也可直接否,取「任一 reject 即否」更安全,与 and 对称)。
  - `single`:与现状一致。
  - 未达成 → 停在本节点等其余人(实例仍 pending)。

- **通知**:开节点时给**所有** pending 审批人发「🗳️ 待你审批」;`or` 模式某人已批后,其余人的待办应消失(act 时把同节点其余未决 Task 关掉 / 标记 skipped,或前端按节点状态过滤)。

### E2 条件分支 = 「条件跳过」(不做全图引擎)
80% 场景是「按表单值跳过某审批人」,用**线性 list + 节点条件**即可,不引图/DSL。

- **节点扩展**:
  ```jsonc
  { "type": "org_role", "role": "administrator",
    "condition": { "field": "amount", "op": ">", "value": 5000 } }
  ```
  - 开节点时:有 `condition` 且对 `instance.form_data` 求值为 **false** → **跳过该节点**(记一条 `action=skipped` 的 Task 存档)→ 自动推进到下一节点。
  - `op` ∈ `== != > >= < <= in`;数值比较对两边做数值化;类型不符/字段缺失 → 视为 false(跳过)并记原因。
- **不做**:多分支跳转、并行网关、循环 —— 那需要真正的图模型 + DSL,收益/复杂度不划算,留更后。

### E3 抄送(CC)= 「自动过」节点
- **节点类型 `cc`**:`{ "type": "cc", "targets": [ {rule}, ... ] }`。开到该节点 → 给 targets 发「📄 抄送:<标题>」→ **立即自动推进**(不等)。
- **时间线区分**:CC 不能显示成「待指派/审批人」。方案:给 `ApprovalTask` 加 **`kind`** 字段(`approve` 默认 / `cc`),或给 `action` 加值 `notified`。前端据此渲染成「抄送:张三、李四」而非审批行。
- **末尾 CC = 完成抄送**:把 cc 节点放流程最后 → 审批通过后知会 Cc 人。放中间 = 中途知会。位置即语义,无需额外字段。

### E4 状态机重构(`services/approval.py`)
把「开节点」与「推进」抽成一个**循环**,吞掉 skip / cc / needs_assignment,只在遇到「需要等人的审批节点」时停下:

```
_open_from(instance, idx):
  while idx < len(flow):
    node = flow[idx]
    if cc(node):        record cc tasks + notify; idx++; continue
    if condition_false(node, form_data):  record skipped task; idx++; continue
    approvers = resolve_all(instance, node)      # 单签→1人;会签→N人;含委托替换
    if not approvers:   status=needs_assignment; set current_node=idx; return   # 停,等 admin
    create N pending tasks; notify all; set current_node=idx; return            # 停,等审批
  # 走完 → status=approved; notify applicant

act(instance, actor, action, comment):
  task = 当前节点里 actor 的 pending Task;校验
  记录 task 动作
  评估当前 node_index 聚合(E1 规则):
    rejected → status=rejected; notify; return
    node 完成 → _open_from(instance, current_node + 1)
    否则 → 停(等其余人)
```

- `submit()` / `retry_assignment()` / `urge()` 复用 `_open_from` / 聚合逻辑。
- **向后兼容**:单签节点(mode=single、无 condition、非 cc)行为与现状**逐字节一致**;现有实例的 flow 无新字段 → 全部走老路径。

### E5 迁移(additive + 一处约束调整)
- `ApprovalTask`:删 `unique(instance, node_index)`;加 `unique(instance, node_index, approver)`;加 `kind`(默认 approve)。加 `action` 新值 `skipped`(+ 可选 `notified`)。
- **数据兼容**:旧 Task 每节点本就一行、approver 非空 → 新唯一约束不冲突;`kind` 默认值回填。**无需数据回填脚本**。
- 迁移号顺延(当前最新 0048)。

### E6 API / 前端影响
- **API**:`act` / 提交 / 列表签名**不变**。`ApprovalInstanceSerializer` 需暴露每节点的 **mode / kind / condition 命中** + 该节点**多 Task**,供前端聚合展示。
- **前端时间线**:从「每 Task 一行」改为**按 node_index 分组**:
  - 会签节点:显示「并签(2/3 已批)」或「或签(任一)」+ 各审批人状态。
  - 跳过节点:「已跳过(条件不满足)」淡显。
  - CC 节点:「抄送:张三、李四」。
- **待办过滤**:`or` 节点某人批后,其余人待办消失(后端把同节点其余 pending Task 标 skipped,或 pending 查询按节点是否已决过滤)。

## 三、分期(可独立发布)
- **E-a 会签**(最大):模型改约束 + 多 Task 解析 + 节点聚合 + 前端分组展示。**含迁移。**
- **E-b 条件分支**:节点 condition + 求值 + skip 记录 + 前端淡显。**可无迁移**(除非用 `skipped` 新 action 值 → 小迁移)。
- **E-c 抄送**:cc 节点 + `kind` 字段 + 通知 + 前端渲染。**含迁移**(加 `kind`)。
- 建议顺序 **E-a → E-c → E-b**(会签把状态机重构做掉,CC/条件跳过顺势接入)。每期独立测 + 部署(有迁移走 helm upgrade,见发布 Runbook)。

## 四、风险 / 取舍
1. **唯一约束迁移**:`unique(instance, node_index)` → `(…, approver)`。approver 可空的行(needs_assignment / cc)在多行下可能撞空值唯一性 —— Postgres 多个 NULL 不算重复,安全;但要确认 needs_assignment 仍是「单行空 approver」。**实现时先验**。
2. **或签并发**:两人同时 act 同一 or 节点 → 需在 `act` 里对节点聚合加行锁 / `select_for_update`,避免双推进。
3. **flow schema versioning**:新字段都可选、默认回落老行为;建议给 template 记一个隐式 schema 版本注释,便于将来演进。
4. **条件求值边界**:字段缺失 / 类型不符一律「不满足→跳过」并记原因,避免误拦或崩。
5. **委托 × 会签**:会签解析出的每个审批人**都各自过委托替换**(E1 的 `resolve_all` 内逐个 `_apply_delegation`)。
6. **不做全图**:多分支 / 并行网关 / 会签中的「依次会签」都不在本期;真需要再上图模型。

## 五、立即下一步(本文档拍板后)
1. **E-a**:`ApprovalTask` 迁移(约束调整 + `kind`)+ `services/approval.py` 重构成 `_open_from` 循环 + 会签聚合 + 单测(and/or/混合)。
2. **E-a 前端**:时间线按节点分组 + 会签进度展示。
3. **E-c 抄送** → **E-b 条件跳过**,各自小步 + 测 + 发。

## 待拍板问题
- **或签否决语义**:任一 reject 即否(推荐,与并签对称)vs 需全员 reject 才否?
- **会签审批人来源**:先只支持 `approvers` 子规则列表(逐条一人),还是本期就要 `org_role_all` / `department_members`(一条出多人)?
- **抄送区分**:加 `ApprovalTask.kind` 字段(推荐,干净)vs 复用 `action=notified`?
- **条件分支**:确认本期只做「条件跳过单节点」,不做多分支跳转?
