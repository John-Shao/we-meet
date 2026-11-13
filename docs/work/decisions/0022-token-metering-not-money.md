# ADR-0022 Work 只统计 token，不计算费用

状态：Accepted（D-08a–d 于 2026-10-27 签收）
日期：2026-10-27
范围：R0a 计量与供应商接入；不证明生产就绪。

## 决策

Work 不计算模型费用，只统计 token（每用户＋组织按模型分列，C 端可见本人用量并标"仅供参考"）；客户用自己的云厂商账号、无平台兜底账号；token 护栏取代 cents 账本。

## 背景

早期设计按 provider 维护价表与 `price_version`，并设想平台统一账号结算。这把 Work 拖进计费合规与价目漂移，且与"客户自带账号"的实际诉求冲突。R0a 需要一个不承诺计费正确性的最小计量面。

## 关键约束

- 每组织一条接入配置，不做跨厂商自动切换。
- 演示组织独接阿里云百炼上的 Qwen，只用演示数据，配置不共享。
- Run 级 token 硬上限；演示组织周期硬上限。
- 用量可见性：C 端本人用量；管理台 owner 写接入配置。

## 放弃的方案

- 方案 A（cents 账本 + 价表结算）：需要价目合规与对账正确性承诺，R0a 不承担；`price_version`、最贵路径上界随之作废。
- 方案 B（平台统一兜底账号）：商务与配额风险集中到平台，与自带账号诉求不符。

## 影响

- 正面：计量面收敛为 token 统计，避开计费合规；客户自担条款与计费。
- 代价：用量"仅供参考"，不做结算；配额到期/限流属运营风险。
- 后续必须验证：真实供应商 usage 归一与对账（当前仅一次 Qwen smoke）。

## 权威实现

- 迁移：`src/work/migrations/`（quota/token 护栏函数，0006/0007 provision）
- 设计：`docs/work/design/work-r0a-data-design-2026-10-25.md`、`work-r0a-api-design-2026-10-25.md`
- 决策原文（归档）：`docs/work/archive/work-r0a-provider-account-metering-decision-2026-10-26.md`