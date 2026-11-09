# 管理台席位分配功能实现计划

> **目标**：在 `/admin/work` 管理台补齐成员席位分配功能，支持内部试点测试
> **日期**：2026-11-09
> **状态**：待审核

---

## 1. 需求背景

C25 用研执行需要 10 个测试账号（13800000000-09）均有 work_seat。当前：
- 10 个账号已在 Keycloak 认证（登录成功）
- 但未自动创建 work.member 记录（登录不等于加入 Work 组织）
- 现有 14 个成员中只有 2 个有 work_seat
- 管理台只读，无法分配席位

**用户裁定**：需要在运营管理台补齐席位分配功能（不是直接 SQL 操作）。

---

## 2. 技术方案

### 2.1 后端 API

**新增端点**：`POST /work/v1/admin/members/{subjectId}/seat`

**请求体**：
```json
{
  "client_request_id": "uuid",
  "work_seat": true,
  "role": "member",
  "status": "active"
}
```

**实现逻辑**：
1. 验证调用者是 owner/admin（复用 `work.assert_org_admin`）
2. 查询目标成员当前 revision（如不存在则 revision=0）
3. 调用 `work.sync_member_projection(org_id, subject_id, status, role, work_seat, revision+1)`
4. 返回更新后的成员信息

**权限**：
- 仅 owner/admin 可调用
- 不能修改自己的席位（防止自锁）
- 不能降级 owner 角色

**错误码**：
- `admin_access_denied`：非管理员
- `member_not_found`：目标成员不存在（需先通过目录同步创建）
- `cannot_modify_self`：不能修改自己
- `cannot_demote_owner`：不能降级 owner

### 2.2 前端 UI

**AdminPage 席位表扩展**：
- 每行增加"操作"列
- 按钮：`分配席位` / `回收席位`（根据当前 work_seat 状态切换）
- 点击后弹出确认对话框
- 调用 API 后刷新列表

**新增成员入口**（可选）：
- 如果目标 subject_id 不在 work.member 表中，需要先创建
- 方案 A：管理台增加"添加成员"按钮，输入 subject_id
- 方案 B：依赖目录同步自动创建，管理台只管理已有成员

**建议**：先实现方案 B（只管理已有成员），因为：
- 10 个测试账号登录后应该会被目录同步自动创建
- 如果目录同步不工作，那是另一个问题（C28 租户开通）

### 2.3 数据库

**无需新迁移**：复用现有 `work.sync_member_projection` 函数。

**ACL**：
- 新端点使用 `work_api` 角色（已有 EXECUTE 权限）
- 函数内部已做权限检查

---

## 3. 实现步骤

### 步骤 1：后端 API（Go）

**文件**：`src/work/internal/api/admin.go`

1. 新增路由常量 `AdminMemberSeatPath = "/work/v1/admin/members/{subjectId}/seat"`
2. 新增请求结构体 `updateMemberSeatRequest`
3. 新增处理函数 `adminUpdateMemberSeat`
4. 在 `routes.go` 注册路由（POST，需 admin 权限）

**测试**：
- `admin_member_seat_pg_test.go`：正向/反向用例
- 权限检查、revision 单调性、不能修改自己

### 步骤 2：前端 API 客户端（TypeScript）

**文件**：`src/frontend/src/features/work/r0a/api/queries.ts`

1. 新增 `useUpdateMemberSeat` mutation hook
2. 调用 `POST /work/v1/admin/members/{subjectId}/seat`
3. 成功后 invalidate `useAdminSeats` 查询

### 步骤 3：前端 UI（React）

**文件**：`src/frontend/src/features/work/r0a/routes/AdminPage.tsx`

1. 席位表增加"操作"列
2. 每行增加按钮（分配/回收）
3. 确认对话框（复用现有 Dialog 组件）
4. 调用 mutation，显示 loading/error 状态

**i18n**：
- `src/frontend/src/locales/*/work.json` 增加翻译键

### 步骤 4：测试与验证

1. 后端单元测试（Go）
2. 前端单元测试（vitest）
3. 本地端到端验证（登录管理台，分配席位，确认生效）
4. CI 门禁通过

---

## 4. 风险与约束

### 4.1 目录同步依赖

**问题**：如果 10 个测试账号登录后没有自动创建 work.member 记录，管理台无法管理它们。

**验证**：先检查目录同步是否工作（`work-directory-sync` timer）。

**备选**：如果目录同步不创建成员，需要：
- 方案 A：修复目录同步逻辑
- 方案 B：管理台增加"手动添加成员"功能（输入 subject_id）

### 4.2 权限边界

**约束**：
- 不能修改自己的席位（防止自锁）
- 不能降级 owner（防止组织失去所有者）
- 只能管理本组织成员（RLS 已保证）

### 4.3 审计

**要求**：所有席位变更必须记录审计事件（`sync_member_projection` 已内置）。

---

## 5. 验收标准

- [ ] 后端 API 实现并通过测试
- [ ] 前端 UI 实现并通过测试
- [ ] 本地验证：登录管理台，给测试账号分配席位，确认 work_seat=true
- [ ] CI 门禁通过（ci-contract、ops-model、前端单测）
- [ ] 10 个测试账号均有 work_seat，可以提交任务

---

## 6. 时间估算

- 后端 API：2-3 小时
- 前端 UI：2-3 小时
- 测试与验证：1-2 小时
- **总计**：5-8 小时

---

## 7. 审核清单

**John 审核时请确认**：
- [ ] 技术方案是否合理（复用 sync_member_projection）
- [ ] 权限边界是否足够（不能修改自己、不能降级 owner）
- [ ] 是否需要"手动添加成员"功能（还是依赖目录同步）
- [ ] 是否现在实施（还是先解决目录同步问题）
