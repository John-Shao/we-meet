# C25 用研执行清单（内部试点，2026-11-09）

> **执行方式**：John 使用多个内部账号在真实试点实例上自测 UT1-UT5
> **环境**：https://meet.we-meet.online/work
> **账号池**：Default Organization，13800000000-13800000009（10 个账号），短信验证码 123456
> **前置确认**：账号已分配 work_seat（如未分配，需先执行 `work.allocate_seat` SQL）

---

## 0. 前置准备（执行前完成）

### 0.1 确认账号状态

```sql
-- 在试点实例生产库执行（sudo -u postgres psql -d work）
SELECT subject_id, phone, org_id, 
       (SELECT COUNT(*) FROM work.work_seat WHERE subject_id = app.subject.id) as seat_count
FROM app.subject 
WHERE phone IN ('13800000000','13800000001','13800000002','13800000003','13800000004')
ORDER BY phone;
```

**预期**：5 个账号均存在且 seat_count ≥ 1。如 seat_count = 0，需为每个账号分配席位。

### 0.2 确认组织执行权限

```sql
SELECT id, name, status, execution_enabled, seat_limit 
FROM work.org 
WHERE name = 'Default Organization';
```

**预期**：`execution_enabled = true`，`seat_limit ≥ 5`。

### 0.3 准备 UT3 失败场景

**时机**：在 UT3 执行前操作

```bash
# SSH 到试点主机，临时移除 provider credential
ssh -i C:\Users\shaoj\.ssh\id_ed25519 johnshao@36.151.147.217
cat ~/sudo-pass.txt | sudo -S -u postgres psql -d work -c "
  SELECT id, org_id, provider, masked_api_key 
  FROM work.provider_credential 
  WHERE org_id = (SELECT id FROM work.org WHERE name = 'Default Organization');
"
# 记录 credential id，然后临时禁用（UPDATE 而非 DELETE，便于恢复）
# UPDATE work.provider_credential SET status = 'disabled' WHERE id = 'xxx';
```

**恢复**：UT3 完成后立即恢复
```sql
-- UPDATE work.provider_credential SET status = 'active' WHERE id = 'xxx';
```

---

## 1. UT1：提交云端文档任务

**执行账号**：13800000000（账号 A）

**步骤**：
1. 打开 https://meet.we-meet.online/work
2. 使用账号 A 登录（手机号 + 验证码 123456）
3. 进入工作首页，找到任务提交入口
4. 输入需求：「写一份关于 Q4 销售总结的文档，包含三个部分：业绩概览、亮点分析、改进建议」
5. 点击预览，确认输入内容
6. 点击提交

**记录项**：
- [ ] 提交耗时（目标 < 60s）
- [ ] 提交后是否显示「云端执行」提示
- [ ] 是否能复述：任务在云端执行、不访问本机文件、成果存到任务中、有 token 用量上限

**成功标准**：60 秒内完成提交；能正确复述云端执行模型。

---

## 2. UT2：等待完成并采纳成果

**执行账号**：账号 A（继续）

**前置**：UT1 提交的任务已完成（状态为 `awaiting_acceptance`）

**步骤**：
1. 在任务工作区找到已完成的任务
2. 查看成果内容
3. 点击「采纳」
4. 编辑成果标题（如：将「Q4 销售总结」改为「Q4 销售总结 - 初稿」）
5. 保存编辑

**记录项**：
- [ ] 是否能找到待验收任务
- [ ] 采纳操作是否顺畅
- [ ] 编辑标题后是否理解「采纳后仍可编辑」
- [ ] 是否遇到版本冲突（如多人编辑场景）

**成功标准**：找到待验收任务并采纳；理解采纳后可编辑；如遇到冲突能正确描述。

---

## 3. UT3：经历失败场景

**执行账号**：13800000001（账号 B）

**前置**：已按 §0.3 禁用 provider credential

**步骤**：
1. 使用账号 B 登录
2. 提交一个新任务：「分析竞品 A 的优劣势」
3. 等待任务状态变化（预期：因无可用 credential，任务会失败）
4. 观察任务状态显示
5. 尝试点击「重试」或其他操作

**记录项**：
- [ ] 任务是否显示为「失败」状态
- [ ] 是否能区分「失败 / 未知 / 取消」三种状态
- [ ] 是否误以为系统会自动重试
- [ ] 点击重试后是否造成重复任务

**恢复**：立即恢复 provider credential（按 §0.3）

**成功标准**：能区分失败/未知/取消；不期待自动重试；不因误操作造成重复。

---

## 4. UT4：我的工作 / Inbox

**执行账号**：13800000002（账号 C）

**前置**：确保账号 C 有需要处理的项（如：被分配了任务、有需要复核的成果）

**步骤**：
1. 使用账号 C 登录
2. 导航到「我的工作」或 Inbox 页面
3. 找到标记为「需要你」的项
4. 点击打开其中一项

**记录项**：
- [ ] 是否能找到 Inbox 入口
- [ ] 是否能识别「需要你」处理的项
- [ ] 是否能说出为什么该项需要自己处理（如：被分配为复核人）

**成功标准**：找到「需要你」项；能解释为什么需要自己。

---

## 5. UT5：管理员视图

**执行账号**：13800000003（账号 D，需为管理员角色）

**前置**：确认账号 D 具有管理员权限（`app.subject_role` 包含 admin 角色）

**步骤**：
1. 使用账号 D 登录
2. 导航到 `/admin/work`
3. 查看席位使用情况
4. 查看配额告警（如有）
5. 点击「审计导出」下载文件
6. 打开导出的文件，查看内容

**记录项**：
- [ ] 是否能找到 `/admin/work` 入口
- [ ] 是否能看懂席位使用数 / 上限
- [ ] 是否能理解配额告警含义（如有）
- [ ] 导出的文件是否为一次性短期凭证（非永久链接）

**成功标准**：找到管理入口；理解席位/配额状态；理解导出文件是一次性凭证。

---

## 6. 多组织覆盖（≥3 组织要求）

**说明**：当前只有 Default Organization 一个组织。为满足「≥3 组织」要求，需要：

**选项 A**：创建额外的测试组织
```sql
-- 创建 org_test_1, org_test_2
INSERT INTO work.org (id, name, status, execution_enabled, seat_limit) 
VALUES 
  (gen_random_uuid(), 'Test Org 1', 'active', true, 3),
  (gen_random_uuid(), 'Test Org 2', 'active', true, 3);
```

然后用账号 E（13800000004）和账号 F（13800000005）分别加入不同组织，重复 UT1-UT4。

**选项 B**：标记为降级
在报告中声明「单组织深度测试，多组织覆盖待 R0b 补做」，按招募单 §7 降级路径处理。

**建议**：如时间允许，选 A；否则选 B 并在 DR3 材料中注明。

---

## 7. 证据收集

**每场测试需记录**：
1. 截图（每个关键步骤）
2. 耗时（从登录到任务完成的总时长）
3. 遇到的问题（UI 困惑、操作失败、理解偏差）
4. 主观评价（1-5 分，任务难度/清晰度）

**汇总格式**：
```markdown
| 任务 | 账号 | 组织 | 耗时 | 成功 | 问题 | 评分 |
|------|------|------|------|------|------|------|
| UT1  | A    | Default | 45s | ✓ | 无 | 4 |
| UT2  | A    | Default | 30s | ✓ | 编辑后无冲突提示 | 3 |
| UT3  | B    | Default | 2m  | ✓ | 失败状态文案不清 | 2 |
| UT4  | C    | Default | 20s | ✓ | 无 | 5 |
| UT5  | D    | Default | 40s | ✓ | 导出文件名不直观 | 4 |
```

---

## 8. 执行后回写

**C25 状态更新**：
- 如全部 UT1-UT5 成功：`status = done`
- 如有失败但可接受：`status = partial`，note 记录缺口
- 如降级（单组织）：`status = done`，note 声明降级

**证据文件**：
- 截图存入 `docs/plan/assets/work-r0a-ops-2026-10-25/c25-usability-test-20261109/`
- 汇总表写入 `work-project.md` 新增段落
- pilot-checklist.json C25 evidence 追加文件列表

---

## 9. 审核清单

**John 审核时请确认**：
- [ ] 账号池 10 个账号均已分配席位
- [ ] UT3 的 credential 禁用/恢复步骤清晰
- [ ] 多组织覆盖选 A 还是 B
- [ ] 证据收集格式是否满足 DR3 复核要求
- [ ] 是否需要补充其他场景（如移动端、网络异常）
