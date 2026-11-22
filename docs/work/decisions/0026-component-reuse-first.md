# ADR-0026 组件复用优先：自研前必答三问，安全关键路径默认选开源

状态：Accepted（2026-11-22 主签单选＝甲"先立纪律，零代码"；本 ADR 不授权任何替换，替换仍须逐批另请开工与提交授权）
日期：2026-11-22
范围：Work 全模块（控制面、设备面、网关、前端、工具链）的新建能力与后续批次；不追溯改已完成批次的落地方式。

## 决策

**新增任何"通用能力"（不是 Work 领域语义本身）之前，必须先回答三问并把答案写进当批设计单的"开放裁定项"，未答不得开工。**

1. **是否存在具名开源实现覆盖同一契约？**判据是"它的接口＝我们要的语义"，不是"存在一个相关的库"。答不出具名候选＝这一问未过。
2. **该能力是否落在安全关键路径上？**密码学构造、PKI（签发/续期/撤销）、授权决策、进程沙箱、序列化规范、幂等/重放语义属此列。**落在该列时默认选开源**，只有当开源被一个可验证的硬约束挡住（平台、打包形态、许可、外部审计可达性）才允许自研，且必须把该约束与被拒方案写进本 ADR 同族文档。
3. **替换成本随时间升还是降？**未沉没者（尚无生产依赖、尚无外部对接方）优先做；已沉没者只做记录、不强行回滚。

配套分级（当前仓库现读的结论，作为后续批次的排序依据，不是本次执行范围）：

| 自研面 | 现读事实 | 分级 |
|---|---|---|
| 设备 PKI：自研证书签发/记录/续期＋test-only CA | `src/work/migrations/increments/0058_device_certificate_issuance.sql`、`src/work/internal/gateway/`；生产 CA 与 keys 仍属 J39 未决 | **该换**（step-ca／cfssl 一类；生产 CA 尚未定＝未沉没，第 3 问判为优先） |
| 契约工具链：自研 OpenAPI→客户端生成器＋服务端手写形状校验＋自研漂移门禁 | `src/frontend/scripts/gen-work-api.mjs` 与产物 `src/frontend/src/features/work/r0a/api/generated/r0a-client.mjs`、`src/work/internal/api/` 各 handler、`docs/plan/assets/work-r0a-design-2026-10-25/scripts/ci-contract.mjs` | **半该换**（契约先行保留；请求/响应形状校验与类型生成有成熟件，属可削的内部维护量） |
| 设备 journal 静态加密：应用层 AES-256-GCM＋DPAPI DEK＋自定 AAD/epoch 方案 | `src/device/src/journal/`（依赖 `aes-gcm`、`rusqlite` bundled，见 `src/device/Cargo.toml`） | **该重看，但要连着打包裁定一起动**（SQLCipher／SQLite 加密扩展与"rusqlite 无 CGO"的既有裁定冲突，单换库会连带安装与升级通道形态；不得只换库不回写裁定） |
| 设备工具面与 Node↔Broker 消息协议 | `src/device/src/frame/`、`src/device/src/finish/`、`src/device/src/reconcile/` | **本期保留，R2 前重看**（fence/lease/签名 receipt 语义开源未覆盖；"工具如何被发现与调用"这层在接第三方工具时应让位于标准协议，否则每个工具作者都得读我们的协议） |
| Windows 沙箱与身份闸：AppContainer＋Job＋每 Run SID ACL、命名管道 accept 处 PID/SID 比对 | `src/device/`（windows-rs／schannel 承载），`src/work/node/src/supervisor.mjs` | **保留自研**（Windows 侧无可嵌入的成熟开源等价物；这是第 2 问"被硬约束挡住"的正例，必须留此记录以免被当成随手自研） |
| 授权/席位/治理事件留在 SQL 领域命令＋RLS 内，不引外部关系引擎 | `src/work/migrations/`、`src/work/internal/api/` | **保留自研**（外部授权引擎会把事实源一分为二，与 ADR-0009 冲突；代价是这部分审计面仍由我们自负） |

## 背景

Work 的平台层事实上已是开源优先：编排用 Temporal（ADR-0010，见 `src/work/go.mod`），数据用 PostgreSQL＋pgx，TLS/密钥原语用 `native-tls`/`schannel`/`p256`/`aes-gcm`/`serde_jcs`（见 `src/device/Cargo.toml`），Agent 循环用 pi-agent-core（ADR-0020，见 `src/work/node/package.json`），前端用 React＋TanStack Query＋react-aria＋PandaCSS＋Playwright/Vitest，镜像 SBOM 与签名以 `syft`/`cosign` 为工具且缺工具即 fail-closed（见 `scripts/supply-chain/generate-sbom.sh`、`scripts/supply-chain/sign.sh`）。

需要立纪律的不是"总量是否自研过多"，而是**剩下的自研集中在哪**：密码构造、PKI、协议、工具链校验器。这些正是外部安全审计（J39，未执行）成本最高的部位——审计员读一个有 CVE 履历的组件，与读一段我们手写的密码装配，工作量不同。同时 0046–0062 仍不在已裁 rollout 包、现网 tip 仍 39，"当前进度瓶颈是 rollout 与审计，不是轮子数量"这一判断也要一并记着，否则本 ADR 会被读成"停下来重构"。

## 关键约束

- 本 ADR **零代码、零新门禁**（主签单选甲）。强制方式＝当批设计单的"开放裁定项"必须含三问答案＋选型，评审时人查；不加依赖白名单扫描器，因为"是否算同一契约"是语义判断，扫不出来。
- 任何替换批开工前须现读所选组件的**当时版本与许可**，许可经 SBOM 面复核；不得据本 ADR 的表格直接引版本或下结论（表格是本日现读快照）。
- 替换不得降低既有取证口径：既有真 exe／网关／PG／契约／漂移门禁仍须整包复跑，且仍需突变（判别力）证据。
- 与既有裁定的耦合点必须显式重裁，不得"顺手换库"：journal 加密 ↔ 设备打包形态（rusqlite 无 CGO）；契约生成器 ↔ `check:work-api` 与 R0a 冻结契约资产；PKI ↔ 生产 CA/keys 的 J39 前置。

## 放弃的方案

- **一次性把四处都换成开源**：与"每批独立取证＋逐批授权"的既定纪律冲突，且会在同一段时间里同时打乱 J39 审计面、rollout 面与设备打包面，任一处红都无法定位归因。
- **加一个机器门禁扫依赖白名单/自研面**：零代码选项下不做；且现有供应链门已覆盖镜像与 SBOM，扫不出的正是语义层判断，等于新增一个会给出假安全感的门。
- **"一律用开源"**：Windows 沙箱与 accept 处身份闸没有可嵌入的成熟件；AppContainer/Job 那块自研是硬约束下的正解，写进本 ADR 以免日后被纪律误伤。
- **把纪律写成 AGENTS.md/贡献守则里的一句话**：规则会在批次设计单里被绕开；三问必须出现在每批"开放裁定项"里才可核。

## 影响

- 正面：自研从"默认允许"变为"须举证"；安全关键路径取得默认优先级；上表给出可排序的候选，避免每次重议方向。
- 代价：无机器强制，违规只能靠评审发现；被引用组件的版本/许可快照会过期，表内结论按"本日现读"读取。
- 后续必须验证（重开条件）：① 0046–0062 的 rollout 重切包裁定后，按新排期复核本表优先级；② J39 外部审计一旦指认某处自研密码/PKI 构造，该项自动升为优先并须新建 ADR 记录替换；③ 任一替换批开工前，第 2 问所指的硬约束若已不成立（例如打包形态重裁），原"保留自研"结论即失效，须重答三问。

## 权威实现

本 ADR 是流程规则，其"实现"就是被现读引用的现有件：

- 依赖清单：`src/work/go.mod`、`src/device/Cargo.toml`、`src/work/node/package.json`、`src/frontend/package.json`
- 被分级的自研面：`src/device/src/journal/`、`src/device/src/frame/`、`src/device/src/finish/`、`src/device/src/reconcile/`、`src/work/internal/gateway/`、`src/work/internal/api/`、`src/work/migrations/increments/0058_device_certificate_issuance.sql`、`src/frontend/scripts/gen-work-api.mjs`、`docs/plan/assets/work-r0a-design-2026-10-25/scripts/ci-contract.mjs`
- 供应链工具：`scripts/supply-chain/generate-sbom.sh`、`scripts/supply-chain/sign.sh`、`src/work/deploy/ecs/verify-r0a-0027.sh`
- 活义务载体：[open-rulings.md](open-rulings.md)（本 ADR 的候选排序作为其中一条开放项存续，替换批落地后再收敛）
- 相关决策：ADR-0009（Postgres 为事实源）、ADR-0010（Temporal 编排）、ADR-0012（受控出口）、ADR-0015（目录授权不等于沙箱）、ADR-0020（pi-agent-core adapter）、[ADR-0023](0023-static-single-layer-encryption.md)（静态单层加密的范围例外）
