# Work R0a 实施计划

> 状态：**E1-E8 契约/mock 实现完成**（2026-10-27；详见 [实施状态总结](work-r0a-implementation-status-2026-10-27.md)）
> 
> 日期：2026-10-27
> 
> 基线：[实施就绪包](work-r0a-implementation-readiness-2026-10-26.md)、[详细设计大纲](work-r0a-detailed-design-plan-2026-10-25.md)、D1–D6 设计文档
> 
> 分支：`dev/work-r0a`（从 `aliyun-dev` 拉出）
> 
> 准入：[开发准入单](work-r0a-development-entry-2026-10-27.md)：E1 立即开工，E2/E3 依次开工，E4 只做契约/本地切片，E5 只做设计/原型，E6 mock 先行，E7/E8 排在其后
> 
> **完成度**：
> - E1-E3 ✅ 完整实现（数据层/API/SSE+outbox）
> - E4 ✅ 契约 + Mock Worker + 真实 Temporal 部署（K3s work-staging）
> - E5-E8 ✅ 契约 + Mock 实现
> - 未提交：E4 Temporal 集成代码（temporal_client.py, settings.py, outbox_relay.py, deploy YAML）
> - 下一阶段：提交 E4 代码 → 端到端验证 → Worker 真实化（替换 mock activity 为 SQL 调用）→ 试点演练（2026-11-06）

## 1. 总体范围与约束

### 1.1 交付范围

R0a 交付**云端文本任务**的最小可用闭环：

- 用户提交任务 → 云端执行 → 生成成果 → 用户采纳/编辑 → 导出
- 管理台只读：概览、席位、审计导出、接入配置（脱敏）、用量统计
- Token 配额：软/硬周期、Run 级上限、用量可见性
- 客户自带账号：阿里云百炼（演示组织由平台承担成本）

**范围外**：本机执行、远程设备、连接器、项目/计划、分享、多组织切换、实时协作。

### 1.2 关键约束

| 约束 | 来源 | 影响 |
|---|---|---|
| D-04 已签收 | 2026-10-27 | SECURITY DEFINER 领域命令 + REVOKE 直接 DML + 独立角色；E1 必须接入迁移体系 |
| D-03 B 静态加密 | 2026-10-27 | 全局主密钥 + 按 org 派生；不使用云 KMS/HSM；C13 标题已改 |
| D-07 A 只拦新工作 | 2026-10-27 | 撤权不自动取消在途 Run；运营用 `ops_cancel_run` 手工处置 |
| D-08a–d 全签 | 2026-10-27 | Token 配额模型；客户自带账号；演示组织独接百炼 |
| D6 go/no-go 为 **no-go**（计数见 [work-project.md](work-project.md)） | pilot-checklist | 正式开工闸门仍为 DR4 2026-12-04；E1–E3 在准入条件下先行 |
| U1 可用性验证未关闭 | §6.1 | 7–8 名设计伙伴、≥3 家组织；报告 2026-11-27；DR3 2026-12-01 |

### 1.3 Epic 依赖关系

```
E1 数据层落库
  ↓
E2 API 服务
  ↓
E3 SSE 网关与 outbox relay
  ↓
E4 编排（契约/mock 先行）
E5 Runtime 与出口（契约/mock 先行）
E6 前端（mock 先行）
  ↓
E7 可观测与供应链
  ↓
E8 试点准备
```

### 1.4 六类后台作业归属（D3 §11.1）

| 作业 | 数据层 | 作业实现 | 依赖 |
|---|---|---|---|
| Outbox relay | E1（`claim_outbox`/`mark_outbox_*`） | E3 步骤 3.2 | — |
| 死信运维（requeue/skip） | E1（`requeue/skip_outbox_dead_letter`） | E3 步骤 3.2 接口 + E2 步骤 2.7 值班工具 | — |
| 目录投影同步 | E1（`sync_org/member_projection`） | E2 步骤 2.5 | — |
| 审计导出 worker | E1（`claim/complete/fail_audit_export`） | E2 步骤 2.4（Content Store 先用 mock） | E5 替换真实 Content Store |
| 到期清扫 | E1（`expire_due_*`/`shred_due_*`） | E4（Temporal Schedule，逐 org） | E4 |
| Content shredder | E1（`content_shred` outbox 行） | E4 契约，E5 真实删除 | E5 Content Store |

## 2. Epic 分解与实施步骤

### E1 数据层落库

**目标**：将 D1 schema/函数/授权纳入后端迁移体系；`work_*` 角色与 Secret；迁移 CI 跑 148 项冒烟与 9 组竞态。

**依赖**：DR1、D-04

**角色**：后端 + DBA

**当前可做**：立即开工（D-04 已签；共享环境合并前 DR1 追认 C01 两项修订）

#### 步骤 1.1：Django 迁移集成

**前置条件**：执行迁移的数据库连接必须是 `work_owner` 成员（schema 首条即 `SET ROLE work_owner`）；CI/staging 由 DBA 或初始化 Job 预先建角色，本地执行 `sql/r0a_roles.sql`。

**文件清单**（迁移顺序不可交换：schema 内的 `CREATE SCHEMA ... AUTHORIZATION work_owner` 与 `GRANT ... TO work_api/work_worker/...` 都要求 7 个角色已存在）：

1. `src/backend/work/migrations/0001_create_work_roles.py`（新建）
   - 幂等 `DO` 块创建/校验 7 个角色：work_owner, work_api, work_worker, work_ledger, work_migrator, work_ops, work_directory
   - 生产由 DBA 预建；迁移只校验存在性与 NOLOGIN/LOGIN 属性，缺失即失败并给出可读错误
   - 本地与测试库：等价于执行 `sql/r0a_roles.sql`（角色是集群级，测试库复用）
   - 无 `reverse_sql`：回滚不删角色（角色可能被其他库复用）

2. `src/backend/work/migrations/0002_initial_r0a_schema.py`（新建）
   - 运行时读取 `work/sql/r0a_schema.sql`（不内嵌），确保包/镜像包含该文件（MANIFEST.in 或 Docker COPY）
   - 标记为 `initial = True`
   - 添加 `reverse_sql`：`DROP SCHEMA work CASCADE`
   - 依赖：`work.0001_create_work_roles`
   - CI 加一致性检查：从设计资产 `r0a-schema-draft.sql` 去掉 DROP SCHEMA/角色/BEGIN 后与 `work/sql/r0a_schema.sql` diff 为零

3. `src/backend/meet/settings.py`（修改）
   - 在 `INSTALLED_APPS` 中添加 `"work"`
   - 配置 `DATABASES['default']['OPTIONS']['options']` 包含 work schema 在 search_path

4. `src/backend/work/README.md`（修改）
   - 删去「未注册 INSTALLED_APPS、等 D-04」表述，改为已注册与迁移说明
   - 本地验证改为「角色 → migrate → 冒烟」路径

**验证**：
```bash
python manage.py migrate work
python manage.py showmigrations work
python manage.py migrate work zero  # 回滚 schema，保留角色
```

#### 步骤 1.2：角色与 Secret 配置

**文件清单**：

1. `deploy/aliyun/work-roles.sql`（新建）
   - 生产角色创建脚本（由 DBA 执行）
   - 权限矩阵（[D1 §4.1](work-r0a-data-design-2026-10-25.md) 为权威）：
     - `work_owner`：NOLOGIN，拥有 work schema 所有对象
     - `work_api`：NOLOGIN，SELECT + 指定函数 EXECUTE
     - `work_worker`：NOLOGIN，SELECT + 指定函数 EXECUTE
     - `work_ledger`：NOLOGIN，账本/审计只读；写入经领域函数以 work_owner 执行
     - `work_migrator`：NOLOGIN，DDL 占位
     - `work_ops`：NOLOGIN，运维函数 EXECUTE
     - `work_directory`：NOLOGIN，投影同步函数 EXECUTE
   - 7 个角色全部 NOLOGIN；工作负载以平台登录身份 `SET ROLE` 到目标角色（D1 §6.1），迁移身份需 `GRANT work_owner`

2. `deploy/aliyun/secrets/work-db.yaml`（新建，示例）
   - Kubernetes Secret 模板，只写占位符，不提交真实凭据
   - 环境变量：`WORK_DB_USER`, `WORK_DB_PASSWORD`, `WORK_DB_HOST`, `WORK_DB_PORT`, `WORK_DB_NAME`, `WORK_DB_SET_ROLE`
   - `WORK_DB_USER` 是平台登录身份；`WORK_DB_SET_ROLE=work_api` 表示进入工作负载后 SET ROLE

3. `src/backend/meet/settings.py`（修改）
   - 默认连接配置 `search_path=public,work`，`work` 加入 `INSTALLED_APPS`
   - API/worker 在事务内 `SET ROLE work_api/work_worker/work_directory`；专用登录身份与 `WORK_DB_*` alias 待平台 IAM 映射（D1 §6.1）落地，当前不建第二个 DB alias，避免 core 测试与迁移双跑

**验证**：
- DBA 在 staging 环境执行角色创建（7 个角色均 NOLOGIN）
- 迁移身份 `SELECT pg_has_role(current_user, 'work_owner', 'MEMBER')` 为 true
- `SHOW search_path` 包含 `work`；`work` 在 `INSTALLED_APPS` 中

#### 步骤 1.3：冒烟测试集成

**文件清单**：

1. `src/backend/work/tests/test_r0a_schema_smoke.py`（新建）
   - 薄执行器：用 **psql 子进程**对 Django 测试库执行 `docs/plan/assets/work-r0a-design-2026-10-25/r0a-schema-smoke.sql`，不重写 148 项断言（单一事实源）
   - 冒烟脚本使用 `\gset` 等 psql 元命令，psycopg 不能直接执行；断言数仍以脚本自身输出为准
   - 失败时透传 SQL 错误；`WORK_PSQL` 可指向容器内 psql，CI 缺 psql 直接失败

2. `src/backend/work/tests/test_r0a_concurrency.py`（新建）
   - 薄执行器：以子进程调用 `docs/plan/assets/work-r0a-design-2026-10-25/r0a-concurrency-smoke.py`
   - 使用独立一次性 scratch 数据库（脚本会 DROP/重建 schema）；`R0A_SCHEMA_SQL` 指向迁移产物 `src/backend/work/sql/r0a_schema.sql`，`R0A_LOG_FILE` 写临时目录
   - 透传不变量结果；非零退出即失败
   - 覆盖：导出领取/租约接管、一次性下载凭证、投影乱序与重复投递、到期清扫共享引用、撤权窗口、管理读与结算交错、接入配置并发写、用量并发累加

3. `src/backend/work/tests/conftest.py`（新建）
   - Django 测试库与一次性 scratch 库 fixtures；`support.py` 提供 psql 运行器与 DSN 构造
   - 角色切换/数据工厂随 E2 领域测试需要补充（E1 的断言由 SQL 脚本自带）

4. `.github/workflows/work-r0a-gates.yml`（修改）
   - 触发器 `paths` 增加 `src/backend/work/**`、`src/backend/meet/settings.py`、迁移 Runbook 与角色/Secret 模板
   - 新增 `backend-migration` job：postgres:16 服务容器 → 应用 `deploy/aliyun/work-roles.sql` → `python manage.py migrate work` → 148 冒烟 → 9 竞态（独立 race 库）→ 回滚/重放 → Work pytest
   - core `meet.yml` 的 `test-back` 忽略 `work/tests`，Work 测试只在上述 job 执行
   - 保留既有 `db-smoke` job（针对设计资产源），两者互不替代：A 证明迁移路径，B 证明设计资产

**验证**：
```bash
cd src/backend && pytest work/tests -v
# 当前 39 项：E1 迁移/冒烟/竞态/回滚，E2 API 契约，E3 SSE/outbox，E4/E5 契约与本地纵切，E6 契约与 Mock UI，E7 可观测
# 需要 psql（WORK_PSQL 可指向容器）与 Redis（CSRF 会话）
```

#### 步骤 1.4：迁移回滚与版本控制

**文件清单**：

1. `src/backend/work/migrations/0002_initial_r0a_schema.py`（完善）
   - `reverse_sql`：`DROP SCHEMA work CASCADE`
   - 原子性：`atomic = True`

2. `docs/plan/work-r0a-migration-runbook.md`（新建）
   - 迁移步骤：forward/rollback
   - 角色创建顺序
   - 数据备份要求
   - 回滚场景与步骤
   - 故障排查指南

**验证**：
```bash
python manage.py migrate work zero  # 回滚
python manage.py migrate work       # 重新应用
```

#### 步骤 1.5：CI/CD 集成

**文件清单**：

1. `.github/workflows/work-r0a-gates.yml`（修改）
   - backend job 设为 required check，失败阻断合并
   - 迁移 → 冒烟 → 竞态在同一 job 内按序执行
   - 环境变量：`WORK_DB_*`

2. `Makefile`（修改）
   - `make work-migrate`
   - `make work-test`
   - `make work-verify-local`
   - 仅本地便利：根 Makefile 声明 NOT FOR CI，CI 步骤不得依赖 Makefile

**验证**：
- PR 触发 CI，所有 Work 测试通过
- 迁移在 CI 环境中成功执行

#### E1 验收标准

- [ ] `python manage.py migrate work` 成功执行
- [ ] `python manage.py migrate work zero` 成功回滚
- [ ] 148 项冒烟测试全部通过
- [ ] 9 组竞态测试全部通过
- [ ] CI 中 Work 迁移与测试步骤通过
- [ ] 角色创建脚本在 staging 环境验证
- [ ] 迁移 runbook 文档完成

---

### E2 API 服务

**目标**：33 个 operation（D2 契约）、cookie+CSRF、会话主体绑定、错误码目录映射、幂等、受控正文下载、管理只读 6 接口、`work_directory` 目录投影同步作业。

**依赖**：E1、DR1、Host 字段（U2 已于 2026-10-27 关闭，DR1 追认）

**角色**：后端

**当前可做**：E1 后开工（D-02 已签、D-08c/d 已冻结；`ops_cancel_run` 为内部命令，不新增对外 API）

#### 步骤 2.1：API 路由与视图

**文件清单**：

1. `src/backend/work/api/`（新建目录）
   - `__init__.py`
   - `urls.py` - 路由配置（挂载在 `/work/v1/`）
   - `views/` - 视图模块
     - `task.py` - 任务 CRUD、提交、重试、取消
     - `input.py` - 输入上传、TTL
     - `artifact.py` - 成果发布、采纳、编辑、导出
     - `approval.py` - 审批请求、决策
     - `admin.py` - 管理只读 6 接口
     - `usage.py` - 用量查询（本人/组织）
     - `config.py` - 接入配置读写（脱敏）

2. `src/backend/work/api/serializers.py`（新建）
   - DRF 序列化器
   - 请求/响应模型
   - 字段验证

3. `src/backend/work/api/permissions.py`（新建）
   - 权限类：owner/admin/member/viewer
   - 会话主体绑定：`app.subject_id` 从 cookie/session 获取
   - 跨组织拒绝

4. `src/backend/work/api/error_codes.py`（新建）
   - PostgreSQL 异常 → HTTP 状态码映射
   - 错误码目录（D2 契约）
   - JSON 错误响应格式

**验证**：
- 33 个 operation 全部可调用
- 错误码映射正确
- 权限控制生效

#### 步骤 2.2：幂等与去重

**文件清单**：

1. `src/backend/work/api/idempotency.py`（新建）
   - 幂等键生成与验证
   - `submission_dedup` 表集成
   - 重复请求返回同一结果

2. `src/backend/work/api/middleware.py`（新建）
   - CSRF 保护
   - Cookie 生命周期管理
   - 会话主体注入

**验证**：
- 重复提交返回同一 task_id
- CSRF 令牌验证生效
- Cookie 过期后拒绝请求

#### 步骤 2.3：受控正文下载

**文件清单**：

1. `src/backend/work/api/download.py`（新建）
   - 一次性下载令牌生成
   - 令牌验证与过期检查
   - 文件状态检查（ready/expired）
   - Content Store 集成（E5 前用 mock）

2. `src/backend/work/api/views/artifact.py`（修改）
   - 添加导出下载端点
   - 令牌发放与兑换

**验证**：
- 下载令牌一次性使用
- 过期令牌拒绝
- 文件过期后拒绝下载

#### 步骤 2.4：管理只读接口

**文件清单**：

1. `src/backend/work/api/views/admin.py`（新建）
   - 管理读 6：概览、席位列表、审计导出（创建/查询/签发下载令牌/兑换下载）
   - 用量 2：本人用量、组织按模型汇总（按 org/subject/provider/model/date 聚合）
   - 接入配置/凭证 6：配置读写、凭证创建/轮换/吊销、配置脱敏查询（`get_provider_config`）

2. `src/backend/work/api/serializers.py`（修改）
   - 管理只读序列化器
   - 脱敏字段（不返回密文）

**验证**：
- 管理读 6 + 用量 2 + 接入配置/凭证 6 全部可用（33 operation 冻结集）
- 非管理员拒绝访问
- 接入配置不返回密文

#### 步骤 2.5：目录投影同步作业

**文件清单**：

1. `src/backend/work/jobs/`（新建目录）
   - `__init__.py`
   - `directory_sync.py` - 目录投影同步
   - `scheduler.py` - 调度器（Temporal Schedule 或 Django-celery-beat）

2. `src/backend/work/jobs/directory_sync.py`（新建）
   - 增量同步：5 分钟一轮
   - 全量校对：每日一次
   - 修订号单调性检查
   - 滞后告警：> 600 秒

3. `src/backend/work/api/views/admin.py`（修改）
   - 添加投影状态查询端点
   - 显示数据陈旧告警

**验证**：
- 投影同步作业正常运行
- 修订号单调递增
- 滞后 > 600 秒触发告警

#### 步骤 2.6：静态凭证加密与密钥派生（D-03 B）

**文件清单**：

1. `src/backend/work/security/credential_cipher.py`（新建）
   - 全局主密钥从环境/Secret 读取，不落库、不进日志
   - 按 `org_id` 派生密钥（HKDF，salt/参数按 D-03 B 固化）
   - `encrypt(org_id, plaintext) -> bytea` / `decrypt(org_id, ciphertext) -> bytes`
   - E2 的 create/rotate 调 `encrypt` 后写入 `create_provider_credential`/`rotate_provider_credential`；E5 网关调 `decrypt`
   - 密钥缺失/格式错误时 fail-closed，不回显密钥材料

2. `src/backend/work/api/views/config.py`（修改）
   - 凭证 create/rotate 前调用 `credential_cipher.encrypt`
   - 错误路径与审计只记 fingerprint，不含明文/密文

**边界**：主密钥托管、派生参数评审与轮换演练属 E5（开发准入单 L07/L13）；E2 只实现加解密接口与 org 派生。
**验证**：
- 同 org 可解密、跨 org 解密失败
- 日志/错误/审计无明文（D6 日志扫描同一断言）

#### 步骤 2.7：运维取消与值班工具（L14）

**文件清单**：

1. `src/backend/work/management/commands/ops_cancel_run.py`（新建）
   - 连接 `work_ops` 角色（独立 `WORK_OPS_DB_*`），不与 API/worker 连接复用
   - 参数 `--org-id --run-id --ticket --reason`，工单号与原因码必填
   - 调用 `work.ops_cancel_run`，输出审计事件 ID；重复调用返回幂等结果
   - 不暴露为对外 API（D2 冻结集不含此命令）

2. `docs/plan/work-r0a-pilot-operations-runbook-2026-10-26.md`（引用 §5.2，不复制）
   - 值班调用步骤、工单校验与拒绝路径

**验证**：
- 非 work_ops 角色调用被拒
- 缺工单号/原因码被拒；跨组织 run 被拒
- 重复调用幂等；审计带工单号

#### E2 验收标准

- [ ] 33 个 operation 全部可调用
- [ ] 错误码映射正确（D2 契约）
- [ ] 幂等与去重生效
- [ ] 受控正文下载一次性令牌验证
- [ ] 管理只读 6 接口可用
- [ ] 目录投影同步作业正常运行
- [ ] 凭证加解密 org 隔离生效（跨 org 解密失败）
- [ ] `ops_cancel_run` 值班工具通过工单校验与幂等验证
- [ ] API 测试覆盖率 > 80%

---

### E3 SSE 网关、outbox relay 与义务作业

**目标**：Last-Event-ID / 409 resync；跨组织租约 relay（顺序/退避/死信阻塞/运维重放与跳过）；生命周期事件。

**依赖**：E1、E2

**角色**：后端

**当前可做**：E2 后开工（义务作业语义按 D3 §11）

#### 步骤 3.1：SSE 网关

**文件清单**：

1. `src/backend/work/sse/`（新建目录）
   - `__init__.py`
   - `gateway.py` - SSE 网关
   - `event_stream.py` - 事件流管理
   - `resync.py` - 409 resync 逻辑

2. `src/backend/work/sse/gateway.py`（新建）
   - SSE 连接管理
   - Last-Event-ID 支持
   - 心跳与超时
   - 跨组织事件过滤

3. `src/backend/work/api/views/task.py`（修改）
   - 添加 SSE 订阅端点
   - 事件流认证

**验证**：
- SSE 连接正常建立
- Last-Event-ID 恢复事件流
- 409 resync 返回完整状态

#### 步骤 3.2：Outbox relay

**文件清单**：

1. `src/backend/work/jobs/outbox_relay.py`（新建）
   - 跨组织租约 relay
   - 顺序保证：按聚合分组
   - 退避策略：2^n 秒（≤300s）
   - 死信阻塞：第 10 次或不可重试 → 死信 + 审计
   - 运维重放与跳过

2. `src/backend/work/jobs/relay_worker.py`（新建）
   - 常驻循环
   - `claim_outbox` → `mark_outbox_delivered` / `mark_outbox_failed`
   - 行级租约：`claimed_by/claimed_until`
   - 非持有者 ACK → `outbox_lease_lost`

3. `src/backend/work/management/commands/work_outbox_dead_letter.py`（新建）
   - 值班重放/跳过死信（work_ops，工单/原因必填；不新增对外 API）

**验证**：
- Outbox 事件正常投递
- 死信阻塞同聚合后续事件
- 运维重放/跳过生效

#### 步骤 3.3：生命周期事件

**文件清单**：

1. `src/backend/work/events/`（新建目录）
   - `__init__.py`
   - `lifecycle.py` - 生命周期事件定义
   - `publisher.py` - 事件发布器

2. `src/backend/work/events/lifecycle.py`（新建）
   - 任务、Run、Operation 生命周期事件；命名按 D2 事件 schema 的点分格式（参考 `task.updated`），名称以 OpenAPI/事件 schema 为准，不另行定义
   - 事件载荷只含 ID/状态/时间，无正文

3. `src/backend/work/api/views/task.py`（修改）
   - 在状态变更时发布事件
   - 事件写入 outbox 表

> 实现回写：SSE 连接、Last-Event-ID、409 resync 与心跳在 `api/views/run.py`（`StreamTaskEventsView`）；生命周期事件由 SQL 领域函数写入 `work.task_event`/`work.outbox`，未单建 `work/sse/` 与 `work/events/` 包。relay 常驻入口在 `management/commands/work_outbox_relay.py`，未单建 `jobs/relay_worker.py`。

**验证**：
- 生命周期事件正常发布
- SSE 网关推送事件
- 前端接收事件更新 UI

#### E3 验收标准

- [ ] SSE 连接正常建立与恢复
- [ ] Last-Event-ID / 409 resync 生效
- [ ] Outbox relay 正常投递事件
- [ ] 死信阻塞与运维重放/跳过生效
- [ ] 生命周期事件正常发布
- [ ] SSE 测试覆盖率 > 70%

---

### E4 编排（契约/mock 先行）

**目标**：Temporal 部署、RunWorkflow/Activities、`r0a-background` 队列与六类后台作业、worker versioning/drain、故障矩阵子集。

**依赖**：E1、DR2、C22

**角色**：后端 + SRE

**当前可做**：只做契约/本地切片（真实部署等 C03/C22 演练）

#### 步骤 4.1：Temporal 契约定义

**文件清单**：

1. `src/backend/work/orchestration/`（新建目录）
   - `__init__.py`
   - `contracts/` - 契约定义
     - `run_workflow.py` - RunWorkflow 契约
     - `activities.py` - Activities 契约
   - `mock/` - Mock 实现
     - `temporal_mock.py` - Temporal 客户端 mock
   - `local_workflow.py` - 无 Temporal 的本地 Run 纵切（Work SQL + faux gateway）

2. `src/backend/work/orchestration/contracts/run_workflow.py`（新建）
   - RunWorkflow 输入/输出
   - 取消四时点
   - 派发后失败一律 unknown
   - 迟到用量计费

3. `src/backend/work/orchestration/contracts/activities.py`（新建）
   - Activities 与 RunWorkflow 契约对齐（含取消/unknown/对账/等待）：prepare_run、acquire_run、create_model_operation、authorize_operation、reserve_quota、claim_dispatch、invoke_model、finish_operation、settle_quota、publish_artifact、finish_run、mark_operation_unknown、cancel_operation、wait_run、resume_run、reconcile_operation
   - 输入/输出/错误码

**验证**：
- 契约定义完整
- Mock 实现可调用

#### 步骤 4.2：后台作业契约

**文件清单**：

1. `src/backend/work/jobs/contracts/`（新建目录）
   - `outbox_relay.py` - Outbox relay 契约
   - `content_shredder.py` - Content shredder 契约
   - `directory_sync.py` - 目录投影同步契约
   - `audit_export.py` - 审计导出 worker 契约
   - `expiry_sweep.py` - 到期清扫契约
   - `dead_letter_ops.py` - 死信运维契约

2. `src/backend/work/jobs/contracts/*.py`（新建）
   - 六类后台作业输入/输出
   - 租约与接管规则
   - 停止/恢复矩阵
3. `src/backend/work/jobs/expiry_sweep.py`、`management/commands/work_expiry_sweep.py`（新建）
   - 逐 org 执行 input/export 到期清扫并投递 content_shred

**验证**：
- 契约定义完整
- 停止/恢复矩阵明确

#### E4 验收标准（契约阶段）

- [ ] RunWorkflow/Activities 契约定义完整
- [ ] 六类后台作业契约定义完整
- [ ] Mock 实现可调用
- [ ] 故障矩阵子集文档化

---

### E5 Runtime 与出口（契约/mock 先行）

**目标**：每 Run 沙箱 Pod、Pi 1.4.0 Adapter、模型网关、usage 对账、Content Store + 静态凭证加密。

**依赖**：DR2、C13/C14

**角色**：运行时 + 平台 + 安全

**当前可做**：只做设计/原型（真实网关等 C04；凭证加密复用 E2 步骤 2.6，主密钥托管/轮换演练在此）

#### 步骤 5.1：Runtime 契约定义

**文件清单**：

1. `src/backend/work/runtime/`（新建目录）
   - `__init__.py`
   - `contracts/` - 契约定义
     - `work_adapter.py` - Work Adapter 契约
     - `model_gateway.py` - 模型网关契约
     - `usage_reconcile.py` - Usage 对账契约

2. `src/backend/work/runtime/contracts/work_adapter.py`（新建）
   - RunContext 输入
   - ModelCallRequest/Result
   - UsageReport
   - Checkpoint/Restore

3. `src/backend/work/runtime/contracts/model_gateway.py`（新建）
   - 模型调用接口
   - 超时/重试/错误码
   - 凭证解析（`resolve_provider_context`）与解密（复用 E2 步骤 2.6 的 `credential_cipher`）

**验证**：
- 契约定义完整
- Mock 实现可调用

#### 步骤 5.2：Content Store 契约

**文件清单**：

1. `src/backend/work/content/`（新建目录）
   - `__init__.py`
   - `contracts/` - 契约定义
     - `content_store.py` - Content Store 契约
   - `mock/` - Mock 实现
     - `local_filesystem.py` - 本地文件系统 mock

2. `src/backend/work/content/contracts/content_store.py`（新建）
   - 上传/下载/删除接口
   - 对象命名规则（固定对象名 + 存储围栏）
   - Etag/版本检查

3. `src/backend/work/content/mock/local_filesystem.py`（新建）
   - 本地文件系统 mock；按 org 隔离，拒绝路径穿越
   - E2 的 `work/api/content_store.py` 复用该实现

**验证**：
- 契约定义完整
- Mock 实现可调用

#### E5 验收标准（契约阶段）

- [ ] Work Adapter 契约定义完整
- [ ] 模型网关契约定义完整
- [ ] Content Store 契约定义完整
- [ ] Mock 实现可调用

---

### E6 前端（mock 先行）

**目标**：Composer/我的工作/任务工作区/Inbox、管理只读、React Query、SSE 客户端、文案、旧链接只读、Playwright + a11y。

**依赖**：E2/E3 mock 可先行、DR3

**角色**：前端

**当前可做**：mock 先行（最终文案/状态等 U1 报告与 C05）

#### 步骤 6.1：前端契约定义

**文件清单**：

1. `src/frontend/src/features/work/`（新建目录）
   - `contracts/` - 契约定义
     - `api.ts` - API 客户端契约
     - `sse.ts` - SSE 客户端契约
     - `state.ts` - 状态管理契约
   - `mock/mockClient.ts` - 内存 mock（任务/状态/配额/Inbox）
   - `api/client.ts` - 真实 `/work/v1` 客户端（Cookie+CSRF、错误目录、SSE）
   - `api/client.test.ts` - 客户端/SSE 契约测试
   - `WorkRoute.tsx` - 默认 Mock UI：Composer、我的工作、任务工作区、Inbox、管理概览
   - `WorkLiveRoute.tsx` - React Query + 真实 API + SSE 的 live 路由（`VITE_WORK_API_MODE=live`）
   - `WorkRoute.test.tsx` - 组件行为测试
   - `WorkRoute.a11y.test.tsx` - axe-core DOM 无障碍扫描（颜色对比交给浏览器）
   - `../../e2e/work-a11y.spec.ts` - Playwright Chromium + axe WCAG A/AA（含颜色对比）

2. `src/frontend/src/features/work/contracts/api.ts`（新建）
   - 33 个 operation 的 TypeScript 类型
   - 请求/响应模型
   - 错误码映射

**验证**：
- 契约定义完整
- TypeScript 类型检查通过

#### E6 验收标准（契约阶段）

- [ ] API 客户端契约定义完整
- [ ] SSE 客户端契约定义完整
- [ ] TypeScript 类型检查通过

---

### E7 可观测与供应链

**目标**：OTel/日志扫描接入、Prometheus 规则/看板/告警投递、cosign/SLSA/SBOM 门禁。

**依赖**：E2–E5

**角色**：SRE + 平台

**当前可做**：E2–E5 后

#### 步骤 7.1：可观测接入

**文件清单**：

1. `deploy/observability/`（新建目录）
   - `prometheus-rules.yaml` - 从 `docs/plan/assets/work-r0a-ops-2026-10-25/` 复制并适配；`generate-telemetry.mjs` 保持唯一生成来源，CI 用 promtool 校验
   - `grafana-dashboards/` - Grafana 看板
   - `otel-collector.yaml` - OTel Collector 配置

2. `src/backend/work/observability/`（新建目录）
   - `__init__.py`
   - `metrics.py` - 指标上报
   - `tracing.py` - 分布式追踪
   - `logging.py` - 日志字段守卫（无正文/密钥）
   - `log_scan.py` - 对已提交日志的正文/密钥扫描 CLI
   - `api/middleware.py` - 请求关联 ID 与元数据指标（已接入 MIDDLEWARE）

**验证**：
- Prometheus 规则生效
- Grafana 看板显示指标
- OTel 追踪正常

#### 步骤 7.2：供应链门禁

**文件清单**：

1. `.github/workflows/supply-chain.yml`（新建）
   - cosign 签名验证
   - SLSA  provenance 生成
   - SBOM 生成与扫描

2. `scripts/supply-chain/`（新建目录）
   - `sign.sh` - 签名脚本
   - `generate-sbom.sh` - SBOM 生成脚本

**验证**：
- CI 中供应链门禁通过
- 签名验证成功
- SBOM 生成完整

#### E7 验收标准

- [ ] Prometheus 规则生效
- [ ] Grafana 看板显示指标
- [ ] OTel 追踪正常
- [ ] 日志扫描无正文泄露
- [ ] 供应链门禁通过

---

### E8 试点准备

**目标**：组织开通、黄金任务演练、试点指标看板、切换/回滚演练、支持与删除流程签收。

**依赖**：E1–E7、C24/C27/C30

**角色**：产品 + 运营

**当前可做**：E1–E7 后（C24/C27/C30 与试点环境）

**既有资产**（不另建平行定义）：[pilot-ops.mjs](assets/work-r0a-ops-2026-10-25/pilot-ops.mjs)、[golden-tasks.json](assets/work-r0a-ops-2026-10-25/golden-tasks.json)、[pilot-metrics.json](assets/work-r0a-ops-2026-10-25/pilot-metrics.json)、[cutover-plan.json](assets/work-r0a-ops-2026-10-25/cutover-plan.json)、[试点运营 Runbook](work-r0a-pilot-operations-runbook-2026-10-26.md) §10。

#### 步骤 8.1：组织开通

**文件清单**：

1. `scripts/onboarding/`（新建目录）
   - `create-org.sh` - 组织创建脚本（work_owner/work_ops 连接）
   - `assign-seats.sh` - 席位分配脚本

2. `docs/plan/work-r0a-pilot-operations-runbook-2026-10-26.md`（修改）
   - 补组织开通检查单与 C24/C27 联系人填列
   - 接入配置（客户自带账号）与配额设置步骤

**验证**：
- 开通检查单完整
- 脚本在 staging 环境验证

#### 步骤 8.2：黄金任务演练

**文件清单**：

1. `docs/plan/assets/work-r0a-ops-2026-10-25/golden-tasks.json`（复用，不改结构）
   - 6 个黄金任务（每模板 2 个），章节与服务端模板一致
2. `scripts/golden-tasks/run-golden-tasks.sh` + `run-golden-tasks.mjs`（新建）
   - 用生成的 Work 客户端逐任务跑 3 次、轮询终态、读取成果并按 `pilot-ops.mjs` 判据评估
   - `--dry-run` 只校验 6 个任务/3 模板与合成目标，不访问 API
   - 结果写 `WORK_PILOT_OUT`（默认 `pilot-run.json`），不覆盖设计资产

**验证**：
- 每任务跑 3 次、≥2 次通过；套件通过率 ≥80%
- 端到端 p95 ≤180 秒；技术成功率 > 95%
- `no_new_facts`/`no_named_people`/`todos_have_owner_role` 人工复核

#### 步骤 8.3：切换/回滚演练

**文件清单**：

1. `docs/plan/assets/work-r0a-ops-2026-10-25/cutover-plan.json`（复用）
2. `docs/plan/work-r0a-pilot-operations-runbook-2026-10-26.md`（修改）
   - 补切换/回滚执行步骤、判据与故障场景处置

**验证**：
- 切换演练成功
- 回滚演练成功

#### E8 验收标准

- [ ] 组织开通流程文档完整
- [ ] 黄金任务演练通过（技术成功率 > 95%）
- [ ] 切换/回滚演练成功
- [ ] 支持与删除流程签收

## 3. 集成点与依赖

### 3.1 与现有后端的集成

| 集成点 | 现有 | Work | 集成方式 |
|---|---|---|---|
| 数据库连接 | `core` 使用默认连接 | `work` schema 隔离 | 同一数据库，search_path 包含 work schema |
| 角色与权限 | Django 单一用户 | 7 个独立角色 | 应用以 work_api 连接；函数以 work_owner 执行（SECURITY DEFINER） |
| 迁移系统 | Django 标准迁移 | Django 迁移 + 原始 SQL | `work/migrations/0002_initial_r0a_schema.py` 使用 RunSQL |
| 测试框架 | pytest + Django test client | pytest + 原始 SQL | Django 测试数据库；Work 测试独立于 core |

### 3.2 与前端/API 的集成

| 集成点 | 说明 | 依赖 |
|---|---|---|
| API 路由 | `/work/v1/...`（D2 冻结口径，如 `/work/v1/bootstrap`、`/work/v1/tasks`） | E2 |
| 错误码映射 | PostgreSQL 异常 → HTTP 状态码 | E2 |
| SSE 网关 | Outbox 事件推送 | E3 |
| 会话主体 | `app.subject_id` 从 cookie/session 获取 | E2 |

### 3.3 外部依赖

| 依赖 | 状态 | 影响 | 缓解 |
|---|---|---|---|
| DR1 签收 | 2026-11-10 | E1 开工 | 已提前签（D-08a–d） |
| DR2 签收 | 2026-11-17 | E4/E5 开工 | 契约/mock 先行 |
| DR3 签收 | 2026-12-01 | E6 开工 | 契约/mock 先行 |
| C13 静态加密 | partial | E5 开工 | D-03 B 已定；E5 补证据 |
| C14 沙箱 | done | E5 开工 | runc 降级已签 |
| C22 Temporal | 待四项演练 | E4 开工 | 契约/mock 先行 |
| U1 可用性验证 | 2026-11-27 报告 | DR3 签收 | 不阻断 E1–E3 |

## 4. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 角色创建失败 | 迁移无法执行 | 迁移前检查角色存在性；提供角色创建脚本 |
| 冒烟测试失败 | 无法进入 E2 | 本地验证脚本已通过；CI 中隔离 Work 测试 |
| 迁移回滚不完整 | 数据残留 | 完善 reverse_sql；文档化回滚步骤 |
| 与 core 迁移冲突 | 迁移顺序错误 | 明确依赖关系；CI 中测试完整迁移链 |
| Temporal 部署延迟 | E4 延迟 | 契约/mock 先行；不阻断 E1–E3 |
| 沙箱证明失败 | E5 延迟 | runc 降级已签；契约/mock 先行 |
| 可用性验证不通过 | DR3 延迟 | 不阻断 E1–E3；问题回写状态矩阵/文案 |
| 试点组织招募不足 | E8 延迟 | U1 招募已发出；降级路径：≥3 家组织 |

## 5. 验收与放行

### 5.1 Epic 验收

每个 Epic 完成后，需通过以下验收：

- [ ] 所有步骤完成
- [ ] 验收标准全部满足
- [ ] 测试覆盖率达标
- [ ] 文档完整
- [ ] CI 通过

### 5.2 试点放行

试点放行需满足：

- [ ] D6 go/no-go 条件满足（blocking 全部 done/waived，计数见 [work-project.md](work-project.md)）
- [ ] E1–E8 全部完成
- [ ] 黄金任务技术成功率 > 95%
- [ ] 切换/回滚演练成功
- [ ] 支持与删除流程签收
- [ ] go/no-go 评审通过

### 5.3 生产放行

生产放行需满足：

- [ ] 试点运行 ≥ 4 周
- [ ] 无 P0/P1 事故
- [ ] SLO 达标
- [ ] 安全评审通过
- [ ] 运维交接完成

## 6. 下一步

1. **本地闭环**：E1 迁移/回滚 + 148 冒烟 + 9 竞态；E2 33 operation API；E3 SSE/outbox；E4/E5 契约与本地纵切；E6 Mock UI + 真实客户端；E7 指标/日志守卫。Work pytest **39/39**，`work/api` 覆盖 **88%**；真实 HTTP（Cookie+CSRF）走通 bootstrap → input → preview → submit → run → artifact → SSE → usage → acceptance；Playwright axe（含颜色对比）通过
2. **已定的数据库与角色口径**：schema 隔离、同一数据库；默认连接 `search_path=public,work`；DBA 生产预建角色（`deploy/aliyun/work-roles.sql`），迁移 `0001` 幂等校验
3. **E1–E3 外部动作**：DBA 在 staging 执行角色脚本并把 `work_owner` 授给迁移身份；推送后触发 `backend-migration` job，并在分支保护中设为 required check
4. **E4–E8 外部依赖**：真实 Temporal、Content Store、供应商网关与前端 UI 尚未接入；E8 试点环境、C24/C27/C30 与黄金任务演练仍待外部
5. **下一阶段**：E4 真实 Temporal 部署（DR2/C22）、E5 平台 Content Store/主密钥托管、E6 UI 实现（DR3/U1）、E7 部署与供应链签名、E8 试点放行

---

**负责人**：后端 + DBA（E1）、后端（E2/E3）、后端 + SRE（E4）、运行时 + 平台 + 安全（E5）、前端（E6）、SRE + 平台（E7）、产品 + 运营（E8）

**评审**：DR1 2026-11-10、DR2 2026-11-17、DR3 2026-12-01、DR4 2026-12-04

**更新记录**：2026-10-27 初稿；2026-10-27 实现回写：psql 执行器、NOLOGIN 角色、E1–E3 本地实现与 E4–E8 契约/资产、E6 Playwright axe、SSE/事件实现位置
