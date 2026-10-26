# ADR 0020：端云共用 Pi agent-core + Work Adapter，H11 仅条件备选

> 状态：Proposed（目标架构提案，待架构评审签收）
>
> 日期：2026-10-25
>
> 决策编号：A13
>
> 决策范围：目标架构；不证明当前仓库已实现，也不替代真实用户/生产验证。
>
> 关联：[Work 系统架构](../plan/work-system-architecture-2026-10-25.md)

## 背景

Pi 的 streamFn、工具钩子和轻量内核符合 Work 边界；自建完整模型循环成本高，完整 coding-agent 会引入隐式工具/配置/重试。

## 决策

端云共用固定版本的 Pi agent-core 内核，由 Work Driver/GatewayStreamAdapter/BrokerToolAdapter/CanonicalStateStore 接管会话、授权、预算、恢复与出口；不采用完整 coding CLI 作为默认执行器。

## 备选与取舍

需要自建状态与暂停适配；升级需准入 H01–H10/H12；OpenAI Agents SDK 只在 H03–H05 硬门槛无法修复时启动 H11，不作为默认依赖。

## 证据与关闭条件

架构 §3.2–§3.9；H01–H12、S7。状态保持 Proposed，待架构评审、对应验证闸门和风险登记签收后转为 Accepted；不得仅因文档存在而宣称生产就绪。
