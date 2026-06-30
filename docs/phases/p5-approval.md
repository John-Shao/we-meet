# P5 — 审批 / 工作流

> 路线图位置：P1 组织地基 ✅ → P2 日历 ✅ → P3 文档（代码✅待部署）→ P4 知识库（设计✅待 P3）→ **P5 审批**。
> **P5 不依赖 Docs/P3** —— 只依赖 P1 组织（已建）+ IM 推送（已通）。可在 P3 部署窗口期并行设计 + 实现。

## 一、Context

飞书式**审批/工作流**：请假、报销等表单走审批流，**按组织架构路由审批人**（主管 / 部门负责人 / 指定 org_role / 指定人）。通知与催办**复用 IM 推送**（同 P2 提醒通道）。@部门/@人复用 P1 通讯录。

**MVP = 串行单链审批 + IM 通知**；Later = 条件分支 / 会签 / 抄送 / 委托。

**地基已就位**（无需新建）：
- `Department.head`（FK User）、`Membership`（`org_role` ∈ MEMBER/DEPT_ADMIN/ADMIN/OWNER、`is_primary`、`status`）、`Department.parent`/`path`（向上找主管）、`get_caller_organization`、`User.get_teams()`。
- `JusiImAdminClient`（`create_direct` + `post_message`）+ `im_provisioning.resolve_uid`（P3 修复时抽出，sub→jusi uid）。
- BaseModel / org-scoped queryset / Pagination / UserLightSerializer 等既有 pattern。

## 二、关键决策

- **D1 三模型**（均 BaseModel、org-scoped、`db_table="meet_*"`）：
  - **ApprovalTemplate**：`organization` FK、`name`、`description`、`form_schema`(JSON)、`flow`(JSON：有序节点规则列表)、`is_active`。
  - **ApprovalInstance**：`organization` FK、`template` FK、`applicant` FK(User)、`form_data`(JSON)、`status`、`current_node`(int 指针)。
  - **ApprovalTask**：`instance` FK、`node_index`(int)、`approver` FK(User，解析出的)、`action`(pending/approved/rejected)、`comment`、`acted_at`。一节点一 Task。
- **D2 表单 = JSON**：`template.form_schema` 描述字段，`instance.form_data` 存填写值。**MVP 不做可视化表单设计器**，模板用 Django admin / JSON 录入。
- **D3 流程 = 有序规则列表**（`template.flow`）：每节点一条审批人解析规则。**MVP 串行单链**（节点逐个推进）。
- **D4 审批人解析规则（MVP 四种）**：
  - `direct_manager`：发起人 **primary 部门的 `head`**；为空或 ==发起人 → 沿 `department.parent` 向上找 `head`；到根仍无 → fallback **org owner**。
  - `department_head`：指定 `department_id` 的 `head`。
  - `org_role`：取 org 内某 `org_role`（如 owner/admin）的成员（多人取一个 active）。
  - `user`：指定 `user_id`。
  - **逐节点解析**（实例推进到该节点时才解析）—— 比"发起时解析全链"更能容忍人员变动。
- **D5 状态机**：`pending` →（每节点 approved 则 `current_node++` 推进）→ 全过 `approved`；任一节点 `rejected` → 实例 `rejected`；发起人可 `cancel`（pending 时）。
- **D6 通知走 IM（系统 DM）**：轮到某审批人 → **系统 → 该审批人的 direct 会话**（`create_direct(SYSTEM_uid, approver_uid)` + `post_message`，uid 走 `im_provisioning.resolve_uid`）发「🗳️ 待你审批：<标题>」；终态 → DM 发起人审批结果。催办同理（可选）。
- **D7 API**（`core/api/approval.py`，`IsAuthenticated` + org-scoped）：
  - 模板：列表（GET，发起时选）；CRUD 走 Django admin（MVP）。
  - 发起：`POST /approvals/ {template_id, form_data}` → 建 Instance + 解析首节点 Task + 通知。
  - 我的待办：`GET /approvals/?role=pending_on_me`（当前节点 Task.approver==我 且 pending）。
  - 我发起的：`GET /approvals/?role=mine`。
  - 审批动作：`POST /approvals/{id}/act {action: approved|rejected, comment}`（仅当前节点审批人）→ 推进/终结 + 通知。
  - 撤销：`POST /approvals/{id}/cancel`（仅发起人、pending）。
- **D8 前端**：`features/approval`（我的待办 / 我发起的 / 发起表单 / 详情时间线）+ Header「审批」入口 + `locales/*/approval.json`。MVP 可先后端 + admin 录模板，前端给最小"待办列表 + 通过/拒绝"。
- **D9 不引 celery-beat**：审批是**事件驱动**（提交 / 审批动作触发推进 + 通知）。若要**定时催办**，复用 P2 的 CronJob 模板（`backend.reminders` 同款，gated），MVP 可不做。

## 三、审批人解析（核心逻辑，`services/approval.py`）

```
resolve_approver(instance, node) -> User | None
  direct_manager:  m = applicant.primary active Membership; dept = m.department
                   while dept: if dept.head and dept.head != applicant: return dept.head; dept = dept.parent
                   return org_owner(instance.organization)          # fallback
  department_head: Department(node.department_id).head  (空→fallback org_owner)
  org_role:        first active Membership(org, org_role=node.role).user
  user:            User(node.user_id)
```
解析不到任何人 → fallback **org owner**；仍无 → 实例置 `needs_assignment` + 告警（admin 人工指派）。**Department.head 普遍未设时，fallback 保证流程不卡死**。

## 四、MVP vs Later

**MVP**：串行单链（direct_manager / department_head / org_role / user）+ 发起 / 待办 / 审批动作 / 撤销 + IM DM 通知。模板 admin/JSON 录入。
**Later**：条件分支、会签（并签/或签）、抄送、委托/代理、可视化表单设计器、定时催办（CronJob）、**审批结果归档成 Doc（联动 P3）**、in-app 通知中心。

## 五、触点（文件级）
后端：`core/models.py` 加 ApprovalTemplate/Instance/Task + choices + 迁移；新建 `core/api/approval.py`(viewset) + `core/services/approval.py`(状态机推进 + 解析 + 通知)；复用 `jusi_im` + `im_provisioning` 发 DM；`core/urls.py` 注册。
前端：`src/features/approval`（待办/发起/详情）+ `Header.tsx` 入口 + `locales/{zh,en,fr,de,nl}/approval.json`。
**无新基建**（IM / org 都现成）。

## 六、风险
1. **`Department.head` 未普遍设置** → `direct_manager` 常落空 → **必须有 fallback（org owner）+ admin 可改指派**（已在 D4/§三 设计）。
2. **系统 DM 机制**：需确认 `create_direct(SYSTEM_uid, user_uid)` 可建（SYSTEM uid 已 seed，作 owner 应可）；不行则退用一个"审批通知"专用群或 in-app 通知中心。**实现时先验**。
3. **IM DM 作通知**（无独立通知中心）：MVP 接受；Later 可加通知中心。
4. **org_role 多人**：`org_role` 规则多人匹配时 MVP 取一个；会签是 Later。

## 七、立即下一步（本文档拍板后）
1. **P5-a**：模型 + 迁移 + `services/approval.py` 状态机（纯后端，mock IM 单测）。
2. **P5-b**：API（发起 / 待办 / 审批 / 撤销）+ 测试。
3. **P5-c**：IM DM 通知接线（系统→审批人 / →发起人）。
4. **P5-d**：前端待办 / 发起 / 详情 + 入口 + 5 语言。
