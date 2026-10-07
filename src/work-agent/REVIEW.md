# Pi 只读复核 PoC

Work 业务层协调复核，dsh 仍是默认执行器。Pi 使用独立 Gateway、执行镜像与状态目录，通过 `work-agent/v1` 通信。执行与复核各自有 UUID、预算、状态和取消操作，两种执行器可独立更新。

## 使用与授权

Web/Electron 共用 Work 页面，在成功完成的任务详情中显示“成果复核”。选择最多 8 个原始成果文件，确认将选定成果和本任务已授权材料发送给复核模型后，手动开启本次复核。默认额外预留 20,000 tokens，最多调用模型一次，同一成果最多复核 5 次，与原执行共享每日预算。

桌面成果经原有显式同步流程进入服务端后才可选择；不读取桌面文件夹、不自动上传工作空间。Android 可复用新接口，当前 Android 页面尚未增加复核入口。

创建时冻结任务目标、背景、选定成果和已授权材料。引用文件使用 `source-<id>.md/csv`、`result-01.<ext>` 等别名，`snapshot.json` 记录原始名称与文件映射。检查的是选定原始成果文件，不会读取编辑后的 Markdown 草稿代替它。

## 只读限制

- Pi 1.0.4 使用 `--no-tools`，禁用扩展、MCP、技能、提示模板和上下文文件发现；模型只有内联文本，没有文件读取、写入、编辑或命令执行工具。
- ModelBroker 在付费调用前拒绝复核请求中的工具/函数能力，并强制 JSON Output。每个容器只挂载当前 job，不挂载桌面工作空间、Docker socket 或业务凭据；Pi 只有临时模型 token，真实供应商 key 保留在 Gateway。
- runner 与后端分别验证报告结构。每条问题必须引用快照中的文件名、SHA-256 和精确非空原文。匹配证据来源不能证明模型推理正确，仍需人工核实。
- 可信 runner 写入唯一成果 `pi-review.json`，保存到独立 `WorkReview`。复核不修改原成果版本、不改变原执行结果、不自动触发修复或发布。
- `no_issues` 表示在提供的材料中未发现问题；`needs_changes` 必须有问题与证据；`inconclusive` 必须解释缺失信息。
- 模型同时报告“未发现问题”和“缺失信息”时，由确定性规则保守提升为 `inconclusive`；不会丢弃缺失项或补造证据。
- 无效报告作为失败处理，不自动重试模型。私有 runtime-home 内的 `review-candidate.json` 用于定位失败，不作为成果、API 响应或公开日志；遵循 job 的私有数据保留策略。

[DeepSeek JSON Output 文档](https://api-docs.deepseek.com/guides/json_mode/)说明了 JSON 模式及空内容、截断的可能性；空结果和无效证据仍会阻断交付。

## 配置与接口

迁移 `work.0006_pi_readonly_review` 新建复核表；已有任务不变。生产默认关闭，新配置独立于主执行器：

| 环境变量 | 用途 |
| --- | --- |
| `WORK_REVIEW_ENABLED` | 接收新复核，默认 `False` |
| `WORK_REVIEW_URL` | 独立 Pi Gateway；远程必须 HTTPS |
| `WORK_REVIEW_TOKEN` | 独立鉴权 token，只配置在后端/Work worker |
| `WORK_REVIEW_CA_PEM` | 私有 CA，保留证书及主机名验证 |
| `WORK_REVIEW_MODEL` | 默认 `deepseek-flash`，需与 Gateway 匹配 |
| `WORK_REVIEW_TOKEN_BUDGET` | 默认 20,000，计入 `WORK_DAILY_TOKEN_BUDGET` |

Gateway 以 `--engine pi` 和固定 Pi 镜像启动，使用独立端口和状态目录，不能与 dsh Gateway 共用 SQLite。可复用独立 agent chart，但 reviewer 必须分别设置 release、服务、Gateway/client/TLS Secret 名、状态路径和端口。现有生产准备脚本只配置主执行器，尚未自动创建 reviewer 生产 profile；本轮没有发布镜像或启用生产复核。

部署新版本的 Work worker 和 Beat 后，`work.tasks.tick_reviews` 在既有 Work queue 中每 5 秒协调两条记录。关闭开关后已有历史可读，取消清理仍继续协调。

桌面本地工作空间任务成功且成果已明确同步到云端后，同一页面显示“成果复核”。用户再次选择已同步文件并勾选发送授权，再开启复核；尚未同步的本地文件不会列入复核选项。复核只使用云端冻结材料，不遍历本地文件夹。新增同步成功或响应不确定时，页面重新查询云端文件身份；切换本地任务会清空原同步文件选择。

完整流程的合成验收见 [桌面到 Pi 复核记录](../../docs/reviews/work-local-pi-flow-2026-10-07.md)。包含真实 PostgreSQL/API、HTTP Gateway 与 Pi Docker 的模拟供应商响应，未新增付费调用。

- `GET /api/v1.0/work/runs/<run_id>/reviews/`：查看记录与报告，不返回输入正文、Gateway 地址或凭据。
- `POST` 同一路径：正文 `{"files":[{"name":"report.md","sha256":"…"}]}`，UUID `Idempotency-Key`；同键同选择返回原记录，选择变化返回冲突。
- `POST /api/v1.0/work/runs/<run_id>/reviews/<review_id>/cancel/`：只取消复核。
- capabilities 新增 `review_enabled`、`review_model`、`review_token_budget`。

接口按原任务账号与当前组织隔离，材料权限在创建、执行、交付和查看时重新校验。撤销源材料会阻断交付并清理远端任务。取消优先于迟到报告，但保留已产生的供应商用量。传输不确定时查询同一 UUID 和快照，不自动换执行器或创建新 UUID。

## 真实评测

以下命令调用 DeepSeek，只用脚本内的合成订单和报告；key 从 Git 忽略的 `.env` 读取，不打印凭据。state 目录必须全新，避免重放未知执行。

```powershell
cd src/work-agent
docker build --target pi -t we-meet-work-agent:pi-review-poc .
python scripts/evaluate_reviews.py --live --env-file .env --state ../../.work-acceptance/pi-review-new-run --output ../../.work-acceptance/pi-review-new-run/evaluation.json
```

默认先运行 dsh，再复核其真实生成的成果，另测人为错误、无证据验收声明、指令干扰和证据不足。`--review-only` 用正确合成报告替代 dsh 调用，`--case` 选择个别样本。记录判定、证据、输入是否变化、额外文件、实际调用次数、tokens 和耗时。这是小样本可行性验证，不能推导总体成功率或成本优势。

## Qwen 复核与同样本对照

Gateway 增加 `--provider qwen --model qwen3.8-flash`，复用现有百炼 `DASHSCOPE_API_KEY`；无需另建 key。仓库已有该模型的会议总结与 Work 接入，Pi 复核独立配置同一个模型和兼容地址 `https://dashscope.aliyuncs.com/compatible-mode/v1`，不自动跟随其他业务的模型配置变更。可用 `--base-url` 指定与凭据区域、工作空间匹配的端点。使用按量 API，不使用 Qwen Token Plan 凭据或第三方 Pi 扩展。

Pi 仍固定 1.0.4，Qwen 模型通过自建 `models.json` 登记，最多输出 4096 tokens，并按网关请求预算进一步收紧。默认网关模型保持 DeepSeek；dsh 仍仅接受 DeepSeek。业务端只需让 `WORK_REVIEW_MODEL` 与复核网关的模型名一致，继续使用原接口、权限、快照、取消和共享日预算，不增加上游 SDK 依赖。

Qwen 复核强制 `enable_thinking=false`、`enable_search=false`，并剔除客户端传入的思考参数。`qwen3.8-flash` 及其 `qwen3.8-flash-` 快照名使用 Gateway 固定的 JSON Schema，`strict=true`；所有嵌套对象声明必填字段并禁止额外字段，客户端不能覆盖该格式。其他 Qwen 模型与 DeepSeek 保留 JSON Object；不推定其他模型支持相同 schema。它与 DeepSeek 的 `thinking=low` 不构成相同推理预算的性能实验。两种路径均禁止工具、自动重试和无效报告交付。

Schema 只约束字段、类型与枚举；字符串长度、数组数量、判定一致性、文件 SHA-256 和原文引用仍由 runner 与后端校验。`file` 误写为 `fle` 继续按无效报告拒绝，不自动改名或删掉错误证据。供应商拒绝 schema 时，不自动降级为 JSON Object 或创建第二次调用；已发起请求的用量未知时继续保守预留。capabilities 记录 `review_output_format` 和 `review_schema_sha256`，用于识别本次格式约束。

Qwen 的 `prompt_tokens_details.cached_tokens` 计入输入缓存；非缓存输入为 `prompt_tokens-cached_tokens`。推理 tokens 已包含在 `completion_tokens` 中，不再次累加。缺失或无效用量保持未知和保守预留，不能当成免费调用。供应商 key 只在网关，容器收到的是限当前 job 的短期 token。

配置测试用 `DASHSCOPE_API_KEY` 后，执行以下合成样本对照。默认每个模型五次调用，共最多十次，每次最多预留 20,000 tokens、输出 4096 tokens；失败保留、不自动重试。它使用固定的正确合成成果，不重新运行 dsh，以保持两种模型收到相同材料。

```powershell
cd src/work-agent
docker build --target pi -t we-meet-work-agent:pi-qwen-poc .
python scripts/compare_reviews.py --live --env-file .env --pi-image we-meet-work-agent:pi-qwen-poc --state ../../.work-acceptance/qwen-compare-new --output ../../.work-acceptance/qwen-compare-new/comparison.json
# 可增加 --qwen-base-url <区域工作空间端点> 或 --qwen-model <固定快照模型名>
```

脚本校验每个样本目标与材料的 SHA-256，以及双方的 runtime/image/policy 固定信息。`work-review-synthetic/v2` 补齐 accepted/pending 状态定义；旧样本未定义这些业务代码，不能把模型拒绝推定状态含义直接当成误报。证据不足样本继续不提供订单或状态字典。

### 复用现有百炼凭据与基线

本次 PoC 选择现有 `qwen3.8-flash`，关闭思考和搜索。正式部署通过 `workAgent.secrets.providerSecret: meet-ai-credentials` 读取已有 `DASHSCOPE_API_KEY`。chart 不创建、复制或替换这个供应商 Secret；Gateway 与业务客户端的任务鉴权 token 仍独立管理。无需另建百炼 key，也不需要填写 `qwenApiKey`；使用 providerSecret 时 chart 拒绝混入明文供应商 key。

本机评测使用已授权的现有凭据，仅注入当前评测进程的 `DASHSCOPE_API_KEY`，不写入新密钥文件。`.env.qwen-test.dist` 仅保留为可选的本地覆盖入口，不是服务端接入的前置条件。已有会议/Work 模型接入并不代替 Pi 复核提示词、引用与计量验收。

已有本机 DeepSeek v2 合成基线可以复用，以下命令只新增最多五次 Qwen 调用，不要求新的 DeepSeek key：

```powershell
cd src/work-agent
python scripts/compare_reviews.py --live --qwen-model qwen3.8-flash --deepseek-baseline ../../.work-acceptance/pi-qwen-deepseek-20261007-r2/evaluation.json --state ../../.work-acceptance/qwen-test-new --output ../../.work-acceptance/qwen-test-new/comparison.json
# 当前进程须已有 DASHSCOPE_API_KEY；如使用区域工作空间端点，增加 --qwen-base-url <兼容地址>
```

复用前校验数据集版本、样本哈希、预期判定、实际报告证据、模型名、供应商、运行镜像和调用次数。旧 v2 基线未记录逐样本 limits 时采用该固定数据集的原预算；新评测明确记录 limits。复用的本地 JSON 属于可信评测档案，不是签名的供应商证明。失败样本保持失败，不筛掉、不补造通过报告。首次检查将镜像 tag 固定为 image ID，随后两种模型都使用此 ID，避免评测中途 tag 改变。

独立 Helm chart 支持 `workAgent.provider`、`model`、`baseUrl`、`secrets.providerSecret`。复核部署需独立 fullname、状态目录、鉴权 Secret/TLS 名；同一专用 Docker 节点上的两个网关须使用不同 `workAgent.port`。默认主执行器端口仍为 8443。示例 [values.work-review.yaml.dist](../helm/env.d/aliyun-prod/values.work-review.yaml.dist) 固定 Pi + Qwen3.8-Flash、8444 端口和已有模型 Secret，网关和业务开关默认关闭。准备脚本仍只管理主执行器，生产 reviewer 的节点、镜像、TLS 和任务鉴权 Secret 须分别准备。

用 `check-work-agent.py --values-file <reviewer profile> --credential-section workReview` 校验 reviewer；此模式不读取主执行器的 token。可选的 `workReview.secrets` 只用于独立任务鉴权配置，供应商仍引用 `meet-ai-credentials`。校验器验证 Pi 引擎、模型、服务地址与 client token/CA 引用，明确开启后才要求非 optional 引用。禁用样例可离线校验，不更新集群。

2026-10-07 用户确认复用已有百炼凭据后，完成五次真实 Flash 调用：四份报告通过，一份因 `file` 字段误写为 `fle` 被结构校验阻断。计量完整，共 5,408 tokens；材料及 runtime 与 DeepSeek v2 基线一致，失败保留，无自动付费重试。详见 [本轮记录](../../docs/reviews/work-pi-qwen-poc-2026-10-07.md)。生产 Pi 复核仍关闭，尚未发布。

供应商配置依据 [Pi 自定义模型文档](https://pi.dev/docs/latest/models)、[百炼 OpenAI 兼容调用](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions) 和 [Qwen 结构化输出](https://help.aliyun.com/en/model-studio/qwen-structured-output)。2026-10-07 查阅的官方 JSON Schema 支持列表包含 Qwen3.8-Flash 系列；本次只为所选 Flash 系列启用。JSON Object 保证语法格式，不保证字段 schema；两种格式均继续严格校验，未自动纠正模型报告。

### Schema 变更后的单样本回归

先以新代码构建单独的 Pi 测试镜像，再把其本地 image ID 传入评测，保持旧镜像和原失败记录。当前进程已配置现有 `DASHSCOPE_API_KEY` 后，只复测原失败的 `missing_status` 合成样本：

```powershell
cd src/work-agent
docker build --target pi -t we-meet-work-agent:pi-review-schema-poc .
$reviewImageId = docker image inspect --format '{{.Id}}' we-meet-work-agent:pi-review-schema-poc
python scripts/evaluate_reviews.py --live --review-only --review-provider qwen --review-model qwen3.8-flash --case missing_status --pi-image $reviewImageId --state ../../.work-acceptance/pi-qwen-schema-new --output ../../.work-acceptance/pi-qwen-schema-new/evaluation.json
```

最多一次模型调用、20,000 tokens 预留和 4096 tokens 输出，无自动重试。单样本回归不覆盖或改写原 4/5 对照；修改镜像和格式后不再宣称与旧 DeepSeek 基线具有相同 runtime。完整新对照需要两种模型均采用新镜像，并重新验证固定数据集。

2026-10-07 单样本真实回归成功：1 次调用、1,281 tokens，`needs_changes` 报告通过 runner 与后端证据校验，输入未变且仅交付 `pi-review.json`。详见 [Schema 回归记录](../../docs/reviews/work-pi-qwen-schema-2026-10-07.md)。
