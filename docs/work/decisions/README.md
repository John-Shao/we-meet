# Work 架构决策记录（ADR）

> 每份 ADR 只解决一个不可逆或高成本决策。变更应新建 ADR 或更新状态，不追加"原文保留／后续更正"；历史靠 git 追溯。
>
> 早期 Work ADR（0005–0021）存放在仓库统一的 [`docs/adr/`](../../adr/)；R0a/R0b 阶段的新决策（0022 起）存放在本目录。本索引是 Work 视角的合并入口。

## 状态：Accepted（目标架构提案，部分待评审签收）

| ADR | 决策 | 位置 |
|---|---|---|
| 0005 | 两层授权（组织开通 + 成员席位） | [docs/adr](../../adr/0005-work-two-layer-access.md) |
| 0006 | Work 吸收 Task，不另建任务模块 | [docs/adr](../../adr/0006-work-absorbs-task.md) |
| 0007 | 本地/远程执行边界 | [docs/adr](../../adr/0007-work-execution-local-remote.md) |
| 0008 | 模块化控制平面 | [docs/adr](../../adr/0008-modular-control-plane.md) |
| 0009 | PostgreSQL 作为业务事实源 | [docs/adr](../../adr/0009-postgres-fact-source.md) |
| 0010 | Temporal 持久编排 | [docs/adr](../../adr/0010-temporal-orchestration.md) |
| 0011 | 领域生命周期 | [docs/adr](../../adr/0011-domain-lifecycles.md) |
| 0012 | 受控出口（egress） | [docs/adr](../../adr/0012-controlled-egress.md) |
| 0013 | unknown 副作用不自动重试 | [docs/adr](../../adr/0013-unknown-side-effects.md) |
| 0014 | 能力冻结与实时撤权 | [docs/adr](../../adr/0014-capability-freeze-live-revocation.md) |
| 0015 | 目录授权不等于沙箱 | [docs/adr](../../adr/0015-directory-grant-not-sandbox.md) |
| 0016 | 成果不可变（不可覆盖） | [docs/adr](../../adr/0016-immutable-artifacts.md) |
| 0017 | 单写同步 DR | [docs/adr](../../adr/0017-single-writer-sync-dr.md) |
| 0018 | R1/R3 workflow 边界 | [docs/adr](../../adr/0018-r1-r3-workflow-boundary.md) |
| 0019 | 安全边界与服务拆分 | [docs/adr](../../adr/0019-security-boundaries-service-split.md) |
| 0020 | Pi Agent Core Adapter | [docs/adr](../../adr/0020-pi-agent-core-adapter.md) |
| 0021 | 可剥离独立产品边界 | [docs/adr](../../adr/0021-work-standalone-product-boundary.md) |
| 0022 | Work 只统计 token，不计算费用（D-08） | [本目录](0022-token-metering-not-money.md) |
| 0023 | 静态单层凭证加密，云 KMS 缓接（D-03 B） | [本目录](0023-static-single-layer-encryption.md) |
| 0024 | 撤席位只拦新工作，在途 Run 运营取消（D-07 A） | [本目录](0024-seat-revocation-block-new-work.md) |
| 0025 | 不拆仓，Work 集中于 src/work 子树（RB-06） | [本目录](0025-monorepo-work-subtree.md) |

## 模板

```markdown
# ADR-XXXX 标题

状态：Accepted / Proposed / Superseded
日期：
范围：

## 决策
一句话说明最终选择。

## 背景
最多三段。

## 关键约束
- ...

## 放弃的方案
- 方案 A：原因

## 影响
- 正面影响 / 代价 / 后续必须验证的事项

## 权威实现
- 代码路径 / migration / 测试
```