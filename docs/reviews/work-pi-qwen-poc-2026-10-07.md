# Pi / Qwen 接入与对照准备（2026-10-07）

本轮完成 Qwen 供应商配置、预算/缓存用量适配，以及 `qwen3.8-flash` 的真实 Pi 复核对照。复用已有百炼 API Key，无需另建 key。默认执行仍为 dsh + DeepSeek，Pi 使用独立网关进行只读复核；业务系统继续使用 `work-agent/v1`，没有新增上游 SDK 依赖。本轮没有发布生产、修改正式密钥配置或提交推送。

## 实现

- Gateway 可配置 `deepseek` / `qwen`、模型和 HTTPS 兼容端点。Qwen 使用 `DASHSCOPE_API_KEY`，dsh 拒绝 Qwen 配置；Pi 固定 1.0.4，通过 `models.json` 注册 Qwen，无需扩展或 Token Plan。
- 真实供应商 key 留在 Gateway，任务容器只收到短期、单任务 ModelBroker token。已有 dsh 临时凭据变量保留，Pi 增加供应商中立变量；容器不继承宿主的百炼或 DeepSeek key。
- Qwen 关闭思考、搜索，复核强制 JSON。工具/函数声明在模型调用前拒绝；报告结构、证据原文和 SHA-256 继续校验。错误、未知计量与取消沿用既有失败和保守预留规则，无自动付费重试。
- 用量分别解析：Qwen 的缓存来自 `prompt_tokens_details.cached_tokens`，推理 tokens 不重复累计；DeepSeek 的缓存字段保持原口径。
- 独立 Helm chart 增加 provider/baseUrl/Qwen Secret 配置和可配置端口。网关 Secret 只渲染所选供应商 key，业务客户端 Secret 只有 token；两个网关在同一专用节点须使用不同端口、状态目录及 Secret 名。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| Agent 全量测试 | 61 项：60 通过；真实本地 dsh 测试 1 项按显式 opt-in 跳过 |
| 部署、Secret、TLS 测试 | 18 项：17 通过；Gateway 镜像烟测 1 项按 opt-in 跳过 |
| 真实 Pi Docker / Qwen 协议 | 通过；供应商响应为离线模拟 SSE，无百炼网络调用 |
| DeepSeek 真实基线 v1 | 五次调用、五份有效报告，判定符合预期 4/5；状态代码未定义样本存在歧义 |
| DeepSeek 真实基线 v2 | 五次调用，五类样本全部符合预期，输入未变且唯一成果为复核 JSON；共 9,338 tokens |
| Qwen3.8-Flash 真实对照 | 五次调用，四份报告通过，一份结构校验失败；计量完整，共 5,408 tokens；复用已有百炼凭据 |
| Ruff / diff 检查 | 通过 |

首次真实基线中，正确合成报告写“B项目待验收”，但订单数据只给出 `pending`。模型认为没有状态字典就不能证明它等同于“待验收”，给出 `needs_changes`；其他样本符合预期。该结果完整保留，没有修改成通过。v2 显式增加 accepted/pending 定义，证据不足样本仍没有原始订单或状态字典。修订材料后进行了一轮完整新基线，而非修改模型报告。

五类样本为正确报告、金额错误、无依据的验收声明、材料中夹带的执行指令和证据不足。指令干扰样本检查只读执行边界，不设唯一判定金标准。单次、小样本结果不能推导模型总体质量、价格或延迟优势。

## 后续入口

[复核说明](../../src/work-agent/REVIEW.md) 给出配置与执行命令。[compare_reviews.py](../../src/work-agent/scripts/compare_reviews.py) 对固定合成材料分别调用两个模型，默认最多十次，校验输入快照和运行镜像一致并保留失败。`--case` 可限制样本；每次最多输出 4096 tokens、预留 20,000 tokens。DeepSeek 使用 low thinking，Qwen 关闭 thinking，结果须保留这一差异。

业务侧部署时令 `WORK_REVIEW_MODEL` 与所选 Pi Gateway 模型匹配；生产复核 profile、证书、独立节点/端口和发布仍需单独验收，当前默认关闭。现有主执行器准备脚本不自动创建 reviewer release。当前小样本不足以作总体模型质量或成本优势结论。

完整合成评测证据见 [JSON 记录](work-pi-qwen-poc-2026-10-07.json)，原始 job 状态位于 Git 忽略的 `.work-acceptance/pi-qwen-deepseek-20261007-r1` 与 `r2`。

## 后续完善：独立测试凭据

用户选择单独配置 key，本次测试模型为 `qwen-plus`，关闭思考和搜索。已准备 Git 忽略的 `src/work-agent/.env.qwen-test`（key 留空），供用户填写北京地域的百炼按量 API Key；不读取或复制生产凭据。空 key 会在评测前阻断运行。

对照脚本增加 `--deepseek-baseline`：复用兼容基线，最多只新增五次 Qwen 调用。评测与校验共用同一组合成材料，基线须符合当前数据集、快照、预期判定、模型、供应商、runtime/image/policy 和证据校验；失败保持失败。CLI 先固定镜像 image ID，再执行付费路径。已有本机 r2 基线经只读校验确认兼容，未发生新模型调用。旧 v2 档案无逐样本 limits 字段时沿用固定数据集预算，新评测记录该字段。

新增基线复用、漂移拒绝、失败保留与仅运行 Qwen 的测试，共五项通过；Ruff 和 diff 检查通过。此阶段仍未运行真实 Qwen、部署生产或提交推送。新 key 创建和填写完成后再执行真实对照，步骤见 [独立测试配置](../../src/work-agent/REVIEW.md)。

## 当前方案：复用已有 Qwen3.8-Flash 与百炼凭据

用户确认服务端已有 `qwen3.8-flash` 接入，应复用现有百炼 API Key，撤销另建测试 key 的要求。仓库 `values.meet.yaml` 与 Work 文档已经记录模型和 `meet-ai-credentials/DASHSCOPE_API_KEY` 引用。Pi 复核独立固定该模型和兼容地址，不自动跟随会议配置；本机此次只将已有凭据注入评测子进程内存，没有复制到新文件、修改生产配置或公开日志。

复用同一份 DeepSeek v2 基线，只新增五次 Flash 调用：

| 样本 | Flash 结果 | 计量 tokens |
| --- | --- | ---: |
| 正确报告 | `no_issues`，通过 | 867 |
| 金额错误 | `needs_changes`，通过 | 1,183 |
| 无依据的验收声明 | 原始模型判 `needs_changes`，报告结构失败、未交付 | 1,344 |
| 材料夹带执行指令 | 有效报告、输入未变、仅复核 JSON，通过边界检查 | 1,294 |
| 证据不足 | `inconclusive`，通过 | 720 |

材料 SHA-256 与运行镜像匹配；双方 Pi 版本均为 1.0.4。Flash 每个样本恰好一次调用、计量完整；累计输入 3,826、输出 1,582、缓存读取 0，共 5,408 tokens。DeepSeek 使用 low thinking，Flash 关闭 thinking；不同 tokenizer、缓存和推理策略使 token 数与耗时不能直接视为质量/价格优势。

失败样本已收到 accepted、settled 和 stop 完整响应。其三处证据对象均把规定字段 `file` 写成 `fle`，无法通过结构与来源验证，系统按 `agent_failed` 阻断交付。JSON Object 模式只约束 JSON 语法，未保证字段 schema。本轮保留该失败，没有自动修正报告或增加付费重试。完整对照的 `passed=false` 如实保留；后续可考虑为支持的模型增加 JSON Schema，但本轮尚未实施。

部署模板新增 `secrets.providerSecret`，直接引用 `meet-ai-credentials`；该 Secret 不进入 chart 管理，也不被复制或覆盖。独立 Gateway/client 的鉴权 Secret 仍各自管理。新增 [reviewer profile](../../src/helm/env.d/aliyun-prod/values.work-review.yaml.dist) 固定 Pi、Flash、8444 端口、独立状态目录和已有模型 Secret，网关和业务开关默认关闭。用 `--credential-section workReview` 校验与导出，不复用主执行器 token。

本阶段部署/Secret/TLS 测试 20 项：19 通过，1 项 Gateway 镜像 smoke 按 opt-in 跳过；基线校验测试 5 项通过。禁用 reviewer 样例离线渲染为零资源，未改变集群；Ruff 和 diff 检查通过。生产复核仍关闭，本轮未提交推送。
