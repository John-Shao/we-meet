# R0a 决策单：advance 工作流落地所需的四项绑定

> 状态：**待签收**（John 主签；Lily 复核第 3 项租约/身份）
> 提出：2026-10-30　截止：2026-11-06
> 背景：`RunWorkflowAdvance` 实现被正确阻断——以下四点无法由现有已签能力表达，硬写会伪造 checkpoint、路由或租约。

## D-1 首步 checkpoint head

`register_runtime_execution`（execute）要求非空输入 checkpoint 且必须等于已提交 head；首步没有 head。

- **A（推荐）显式 canonical_state revision 0**：注册执行前由 Go 创建 `canonical_state`（revision 0、previous=null、completedModels=[]、phase=ready），提交为 head（revision 0），execute 以它为输入 checkpoint。理由：§8.1 已定义 revision 0；不放松 SQL。
- B 放宽 execute 绑定允许 null checkpoint：改 0009 语义，后续 plan 仍要处理空 head。
- C 由 plan 片段产出 revision 0：需允许 plan `CHECKPOINTED` 并实现 Node 侧 canonical 文档，改动最大。

## D-2 冻结路由的 revision 与 compat profile

`model_request` 需要 `configRevision` 与 `compatProfileVersion`；`resolve_provider_context` 不返回 revision，也无 compat 注册表。

- **A（推荐）新增只读命令 + 常量**：0014 增加 `read_provider_config_revision(org)` 返回 config 的修订/更新时间；`compatProfileVersion` 现签为常量 `r0a-compat-1`（写入本单即为冻结值）。
- B 用 `config_id` 当 revision、compat 常量：不改 SQL，但 revision 语义变成对象 id。
- C 建 compat profile 注册表：改动最大，R0a 不必要。

## D-3 执行租约归属

30s 租约与 16 分钟活动不匹配；设计把 claim/renew 归 Node 父进程，但父进程未实现。

- **A（推荐）父进程 claim + 10s renew + 代次刷新**：父进程经 8443 claim/renew，子进程 token 随代次更新；Go workflow 只登记与等待。
- B Go 代持租约：违反“holder 身份来自父进程”的签名边界，不建议。

## D-4 head 文档形态

子进程写的是 `work-checkpoint-candidate-v1` 交接文档，不是 `canonical_state`；直接把候选提交为 head 会让下一次 plan 无法读取。

- **A（推荐）Go 负责 canonical 提交**：子进程只写候选正文与回执；Go 收尾时构建/校验 `canonical_state` 并 CAS 提交 head，符合 §8.1“Go 确认后提交 head”。
- B 子进程构建 canonical_state：需在 Node 复刻规范化与状态机，双实现风险高。

## 签收

- [x] D-1：**A**（显式 canonical_state revision 0 作为首步 head）
- [x] D-2：**A**（0014 只读命令 + `compatProfileVersion = r0a-compat-1` 现签为冻结常量）
- [x] D-3：**A**（父进程 claim/10s renew，子进程 token 随代次刷新）
- [x] D-4：**A**（Go 构建/校验 canonical_state 并 CAS 提交 head）
- [x] John 日期：2026-10-30
- [x] Lily：**复核通过**（D-3 租约与身份边界）　2026-10-30
