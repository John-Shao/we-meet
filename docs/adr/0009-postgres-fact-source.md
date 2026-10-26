# ADR 0009：PostgreSQL 作为业务事实源

> 状态：Proposed（目标架构提案，待架构评审签收）
>
> 日期：2026-10-25
>
> 决策编号：A02
>
> 决策范围：目标架构；不证明当前仓库已实现，也不替代真实用户/生产验证。
>
> 关联：[Work 系统架构](../plan/work-system-architecture-2026-10-25.md)

## 背景

状态迁移、审批单胜者、预算不超卖、采纳静止和跨租户隔离都需要事务、唯一约束、行锁和 RLS。

## 决策

Task、Run、Operation、Approval、Budget、Artifact 元数据和 Audit/Outbox 以 PostgreSQL 为权威事实源；对象存储只保存正文。

## 备选与取舍

接受 DBA/迁移/容量成本；不用 NoSQL 分摊强一致账本；正文与元数据分层，避免数据库承载大对象。

## 证据与关闭条件

DDL 草案 §4–§8；架构 §5、§7.1、§18。状态保持 Proposed，待架构评审、对应验证闸门和风险登记签收后转为 Accepted；不得仅因文档存在而宣称生产就绪。
