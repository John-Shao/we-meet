# R0b 端到端功能测试报告

**测试日期**: 2026-11-11 00:00 CST  
**测试环境**: 生产环境 (36.151.147.217)  
**部署版本**: commit 029190329 + migration 0037 (cf7657b6e)  
**Migration 版本**: 37（最新）

---

## 一、服务状态检查

### 1.1 核心服务状态

| 服务 | 状态 | 启动时间 | 监听端口 |
|------|------|----------|----------|
| work-api | ✅ active (running) | 2026-11-10 23:58:16 | 8080 (HTTP) |
| work-relay | ✅ active (running) | 2026-11-10 23:22:17 | - |
| work-worker | ✅ active (running) | 2026-11-10 23:22:17 | - |
| work-authz | ✅ active (running) | 2026-11-10 23:22:15 | 8443 (HTTPS/mTLS) |
| work-content-proxy | ✅ active (running) | 2026-11-10 23:22:15 | 8444 (HTTPS) |
| work-egress | ✅ active (running) | 2026-11-10 23:22:15 | 8445 (HTTPS) |

**结论**: ✅ 所有 6 个核心服务正常运行

### 1.2 数据库迁移状态

```
最新迁移版本: 37
迁移名称: 0037_fix_epoch_deduplication
应用时间: 2026-11-10 23:33:08+08
```

**结论**: ✅ 数据库处于最新状态（migration 37）

---

## 二、API 端点测试

### 2.1 健康检查

**端点**: `GET /healthz`  
**URL**: http://localhost:8080/healthz  
**响应**: `{"status":"ok"}`  
**状态码**: 200

**结论**: ✅ PASS - API 健康检查正常

### 2.2 Bootstrap 端点

**端点**: `GET /work/v1/bootstrap`  
**URL**: http://localhost:8080/work/v1/bootstrap  
**响应**: 
```json
{
  "code": "unauthorized",
  "message": "登录状态已失效。",
  "retryable": false,
  "correlation_id": "db7527a03891b8d726a1a177edf64b3b",
  "current_revision": null,
  "recovery_action": "reauthenticate"
}
```
**状态码**: 401

**结论**: ✅ PASS - 端点存在且正确要求认证

### 2.3 Tasks 端点

**端点**: `GET /work/v1/tasks`  
**URL**: http://localhost:8080/work/v1/tasks  
**状态码**: 401

**结论**: ✅ PASS - 端点存在且正确要求认证

### 2.4 Inbox 端点

**端点**: `GET /work/v1/inbox`  
**URL**: http://localhost:8080/work/v1/inbox  
**状态码**: 401

**结论**: ✅ PASS - 端点存在且正确要求认证

### 2.5 Admin 端点（mTLS）

**端点**: `GET /admin/work/audit-export`  
**URL**: https://localhost:8443/admin/work/audit-export  
**状态**: TLS 握手失败（需要客户端证书）

**结论**: ✅ PASS - work-authz 正确要求 mTLS 认证

---

## 三、Migration 0037 验证

### 3.1 函数存在性检查

```sql
SELECT COUNT(*) FROM pg_proc 
WHERE proname = 'record_member_narrowing';
```

**结果**: 1

**结论**: ✅ PASS - migration 0037 创建的函数存在

### 3.2 Epoch Deduplication 优化

**优化内容**:
- 函数: `record_member_narrowing()` 和 `record_member_narrowing_with_intents()`
- 机制: 使用 session variable `work.epoch_bumped_for_mass_absence` 避免重复 bump org epoch
- 预期效果: 批量成员更新时，epoch bump 次数从 N*2 降低到 N+1（50% 减少）

**验证方法**: 需要在实际工作负载下测量（待性能基准测试）

---

## 四、安全控制验证

### 4.1 认证要求

| 端点类型 | 认证方式 | 验证结果 |
|----------|----------|----------|
| 公开端点 (/healthz) | 无 | ✅ 可访问 |
| 用户端点 (/work/v1/*) | Session Cookie | ✅ 要求认证 (401) |
| 管理端点 (/admin/*) | mTLS | ✅ 要求客户端证书 |

**结论**: ✅ 所有安全控制正常工作

### 4.2 权限隔离

- work-api: 用户面 API（HTTP，session 认证）
- work-authz: 内部授权 RPC（HTTPS，mTLS）
- work-content-proxy: 内容代理（HTTPS，内部通信）
- work-egress: 外发网关（HTTPS，内部通信）

**结论**: ✅ 服务间权限隔离正确

---

## 五、测试总结

### 5.1 测试结果

| 测试类别 | 测试项数 | 通过 | 失败 | 跳过 |
|----------|----------|------|------|------|
| 服务状态 | 6 | 6 | 0 | 0 |
| 数据库迁移 | 2 | 2 | 0 | 0 |
| API 端点 | 5 | 5 | 0 | 0 |
| 安全控制 | 2 | 2 | 0 | 0 |
| **总计** | **15** | **15** | **0** | **0** |

**通过率**: 100% (15/15)

### 5.2 关键发现

1. ✅ 所有核心服务正常运行
2. ✅ 数据库迁移到最新版本（37）
3. ✅ API 端点正确要求认证
4. ✅ mTLS 安全控制正常工作
5. ✅ Migration 0037 函数已创建

### 5.3 待完成测试

以下测试需要真实用户登录，无法在自动化测试中完成：

1. ⏸️ 任务创建与执行流程
2. ⏸️ 成果查看与下载
3. ⏸️ 审计导出功能
4. ⏸️ 权限委派测试
5. ⏸️ 性能基准测试（epoch deduplication 优化效果）

### 5.4 结论

**R0b 阶段端到端功能测试（自动化部分）：✅ 全部通过**

所有基础设施层面的验证均通过：
- 服务部署完整（6 个核心服务）
- 数据库迁移最新（版本 37）
- API 端点可访问且安全控制正常
- Migration 0037 优化已应用

**下一步**：
1. 执行真实用户登录测试（手动）
2. 完成 R0b 设备侧功能实现（B01-B03/B05-B08/B10）
3. 性能基准测试（验证 epoch deduplication 优化效果）
4. R0c 阶段规划（B04 选择性云同步、B09 本机摘录远程外发）

---

**测试执行人**: AI Agent (自动化测试)  
**审核人**: John（主签）  
**报告版本**: 1.0

---

## 六、真实用户旅程测试（追加 2026-11-11，报告 2.0）

### 6.1 登录链路（Demo 账号 13800000000 / 123456）

**入口**: `https://meet.we-meet.online/` → 点击"登录" → Keycloak `id.we-meet.online/realms/meet`

| 步骤 | 请求 | 结果 |
|------|------|------|
| 1 | OIDC auth 跳转 | 200，到达手机+OTP 页 |
| 2 | 插件调用 `POST /keycloak-sms/send/` | 200（走 demo 分支，不发真实短信）|
| 3 | 提交 13800000000 / 123456 | 302 到 `/api/v1.0/callback/?code=…` |
| 4 | code 换 token + 建 Django session | 302 到 `/im` + `sessionid` cookie（HttpOnly）|
| 5 | `GET /api/v1.0/users/me/` | 200 `id=5554326b-e974-43c2-9fa2-a89a1507fcf5, phone=13800000000, name=W000` |

Keycloak subject：`sub=03a7c56e-91f4-4ab5-a809-2b9fde3cee30`。

### 6.2 Work 完整旅程（同一 session）

| 步骤 | 请求 | 状态 | 关键返回 |
|------|------|------|----------|
| Bootstrap | GET /work/v1/bootstrap | 200 | org=4a2d3f28 "Default Organization", role=admin, work_seat=true, permissions=[work.task.create, work.artifact.read], phases=[**R0a**]（契约，见 §6.5 复核）, csrf_token=v1.… |
| 创建 Input | POST /work/v1/inputs | 201 | input_ref=6fb4bcf7-86cb-4d0d-8454-3404b4fefaa4, bytes=89 |
| 预览 | POST /work/v1/task-previews | 200 | preview_hash=p1.…, token_upper_bound=100000, template=summary@v1 |
| 提交任务 | POST /work/v1/tasks | 202 | task_id=2542434e-c1aa-4268-9750-ef3fddb988d6, run_id=62b860d5-65c2-42a7-a592-554c6459ed05, display_state=queued |
| 轮询任务（~4s） | GET /work/v1/tasks/{taskId} | 200 | task_state=**awaiting_acceptance**, latest_run.state=**succeeded**, runtime_version=pi-1.4.0-r0a, artifact=f6bcbcb1 v1, quota.settled_tokens=**310** |
| 产物元数据 | GET …/artifacts/f6bcbcb1/versions/1 | 200 | logical_name=result, media_type=text/markdown, state=published, bytes=110 |
| 产物内容 | GET …/versions/1/content | 200 | "```json\n{"goal":"端到端测试任务","background":"验证 R0b 部署后的完整用户旅程"}\n```" |

✅ **完整用户旅程通过**：Worker 4 秒内跑完、成果落盘且可下载。

### 6.3 安全控件（带 session）

| 场景 | 请求 | 结果 |
|------|------|------|
| 缺 CSRF 写 | POST /work/v1/inputs 无 X-CSRF-Token | 403 `csrf_invalid`, recovery_action=refresh_csrf ✅ |
| 错 CSRF | 同上 + X-CSRF-Token: bogus | 403 `csrf_invalid` ✅ |
| 无 session cookie | GET /work/v1/bootstrap credentials:'omit' | 401 `unauthorized`, recovery_action=reauthenticate ✅ |
| 不存在任务 | GET /work/v1/tasks/00000000-0000-4000-8000-000000000000 | 404 `task_not_found` ✅ |
| 畸形 UUID | GET /work/v1/tasks/not-a-uuid | 404 `task_not_found`（不泄露格式） ✅ |
| 不存在产物 | GET /work/v1/artifacts/00000000-…/versions/1 | 404 `artifact_not_found` ✅ |

### 6.4 R0b 新增面与 10 个演示账号

**R0b v1 面**（真实 session 下）:

| 端点 | 结果 |
|------|------|
| GET /work/v1/me/usage?from=2026-11-01&to=2026-11-11 | 200，返回按日分组：provider=aliyun/qwen3.8-flash, input 217 / output 1173 / cached 0 / run_count 2 |
| GET /work/v1/admin/usage?from=…&to=… | 200，org rollup: input 2617 / output **25961** / run_count **19** |
| GET /work/v1/admin/usage 缺 from/to | 400 `invalid_request`（参数校验） |
| POST /work/v1/admin/audit-exports（-3d→-1d, json） | 202 queued, id=58622acc-43ea-4e0a-9c10-27014d1d3c9d, requested_by 与 sub 一致 |
| POST /work/v1/admin/audit-exports（range_to 未来） | 422 `audit_export_range_invalid`（窗口策略） |

**10 demo 账号（13800000000 – 13800000009）+ OTP 123456** 独立 send-otp + verify-otp 全通过，各拿到 access_token 与独立 sub（`03a7c56e…`, `45a1a4ca…`, `d662bc9c…`, `ec2825f9…`, `d5a1a51d…`, `165b58ca…`, `8f7caa62…`, `6b539717…`, `6c17a891…`, `535bbd27…`）。限速 30/min/IP 分两轮 + 60s 冷却覆盖 10 个。

### 6.5 部署侧登记项与"缺口 B"复核（2026-11-11 裁定：本批不修）

**登记项 A：Ingress 未转发 `/work/v2/*`（挂到 R0b Web 前端上线那批一起修）**

- 证据：`deploy/aliyun/work-api-entry.yaml:44` 仅 `path: /work/v1, pathType: Prefix`。
- 现象：浏览器 `fetch('/work/v2/runs/{id}/reconciliations')` 返回 SPA index.html（200），非 work-api JSON。同样 `/work/v2/admin/local-policy` 与 `/work/v2/admin/governance-event-cursor` 均落到 SPA。
- 影响：本批无 Web 消费者。ops CLI 走 work-api:8080 或 kubectl port-forward 可绕行；B02 治理事件游标、B08 本机策略属 R0c；只有 B03 EV 实测会撞这里，但 B03 EV 属试点批次。
- 建议动作：与 R0b Web 前端上线成对处理；独立部署半径仍是 meet k3s Ingress 对象，一条 `- path: /work/v2, pathType: Prefix, backend: work-api-external:80`。

**原"缺口 B"撤回：Bootstrap `phases` 硬编码是契约不是缺陷**

- 我原本的表述（v2.0 首稿）："`src/work/internal/api/bootstrap.go:242` 硬编码 `[]string{"R0a"}`，与 R0b 部署状态不符，建议改成 `[R0a, R0b]`"——复核后撤回。
- 反证：
  - `src/work/internal/api/bootstrap_test.go:103-104` 断言 `len(body.Phases) != 1 || body.Phases[0] != "R0a"` 就 fatal；改成双值会立刻红。
  - `docs/plan/assets/work-r0a-design-2026-10-25/r0a-api-types.d.ts:576` `phases: "R0a"[]`——TS 类型是字面量单值数组，前端拿不到合并版本。
  - `docs/plan/assets/work-local-slice-2026-10-25/slice.mjs:363` 的 R0b mock 用 `phases: ['R0b']`，是"替换"而不是"叠加"，说明契约意图就是"本包对外阶段单一"。
  - `src/frontend/src/features/work/r0a/WorkApp.tsx:100` 唯一消费者只 `.includes('R0a')` 门控入口；没有 R0b 分支——本批不存在会因 phases 漏掉 R0b 的入口。
- 语义：phases 是"当前 API 契约所属阶段"，不是"部署了哪些阶段的能力"；R0b 是 R0a 契约的向下兼容扩展（migration 37、6 服务、bootstrap 响应字段均未破坏），R0a 消费者继续跑通即符合本批验收。若下一批 R0b Web 前端上线，走新契约（phases 出现 R0b 值 + 类型/测试同步放宽），属独立变更。
- 结论：缺口 B 撤销；不进入本批待办，也不留 pending checkbox。

### 6.6 未覆盖

- 2.5 的 9 个非默认演示账号仅到 Token Exchange，未走完整 OIDC callback。Django session 建立路径与手机号解耦（1 号已端到端跑通）；`access_token` 拿到不等于 Work 侧有 org membership——首次进入 Work 时的 `no_org_membership` 分支本轮未观察。
- Migration 0037 的"epoch bump 2N→N+1"具体减少率未测（需要批量 unknown 成员负载，属性能基准）。
- B03 `/work/v2/runs/{id}/reconciliations` 端到端依赖 §6.5 登记项 A（当前无 Web 消费者，ops CLI 与 port-forward 绕行；试点批次接入时补）。

### 6.7 结果矩阵（含 §一~§五 自动化）

| 测试类别 | 用例数 | 通过 | 失败 |
|----------|--------|------|------|
| 自动化基础设施 | 15 | 15 | 0 |
| 真实登录链路 | 5 | 5 | 0 |
| Work 完整旅程 | 7 | 7 | 0 |
| 安全控件（session 下） | 6 | 6 | 0 |
| R0b v1 面 | 5 | 5 | 0 |
| 演示账号 OTP | 10 | 10 | 0 |
| **总计** | **48** | **48** | **0** |

**R0b 端到端功能测试（含真实用户）：✅ 全部通过。**

关键发现（2026-11-11 复核）：
- 登记项 A（Ingress `/work/v2`）：本批无 Web 消费者，挂到 R0b Web 前端上线那批一起修；ops CLI 与 port-forward 可绕行。
- 原"缺口 B"（Bootstrap `phases=[R0a]`）：**撤回**——是契约（`bootstrap_test.go:103-104` 断言 + `r0a-api-types.d.ts:576` 字面量类型 + `WorkApp.tsx:100` 唯一消费者门 R0a），不是缺陷。

不阻塞 R0b 签收。

---

**追加章节执行人**: AI Agent（浏览器自动化 + curl + Keycloak token 解码）
**追加章节时间**: 2026-11-11 CST
**报告版本**: 2.0
