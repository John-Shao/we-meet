# ADR 0011：Task、Run、Operation、Artifact 分离

> 状态：Proposed（目标架构提案，待架构评审签收）
>
> 日期：2026-10-25
>
> 决策编号：A04
>
> 决策范围：目标架构；不证明当前仓库已实现，也不替代真实用户/生产验证。
>
> 关联：[Work 系统架构](../plan/work-system-architecture-2026-10-25.md)

## 背景

失败重试、未知副作用、用户验收和交付物生命周期不同；合并成一个 status 会导致重试覆盖验收、取消掩盖在途动作。

## 决策

Task 表示可验收请求，Run 表示一次执行尝试，Operation 表示外部可计费/有副作用动作，Artifact 表示不可变成果。

## 备选与取舍

查询需要投影；用户仍只看到 Task/Run 产品状态；每个 Operation 必须绑定预算与回执，不能把模型文本当成果。

## 证据与关闭条件

架构 §5.1、§6、§13.2；DDL task/run/operation/artifact。状态保持 Proposed，待架构评审、对应验证闸门和风险登记签收后转为 Accepted；不得仅因文档存在而宣称生产就绪。
