# 跨记录问答评测 v1

本目录只在 pytest-django 测试数据库内建立合成记录，每题独立事务回滚，不是生产数据导入工具。覆盖统一记录的 upload / audio_recording / meeting 消费侧；不运行上传、ASR 或真实大文件处理。

## 执行

沿用项目测试环境（PostgreSQL、DJANGO_SETTINGS_MODULE=meet.settings、DJANGO_CONFIGURATION=Test，以及测试数据库连接）。从 `src/backend` 运行，不开启 xdist；完整题集跑完才导出报告。

```bash
MEETING_QA_EVAL_OUTPUT=/tmp/meeting-qa-candidate.json python -m pytest core/tests/evaluations --no-cov
```

PowerShell：

```powershell
$env:MEETING_QA_EVAL_OUTPUT = "$env:TEMP/meeting-qa-candidate.json"
python -m pytest core/tests/evaluations --no-cov
```

从仓库根目录比较已冻结基线与新报告（此比较工具不连接数据库）：

```bash
python src/backend/core/tests/evaluations/compare_meeting_qa.py docs/research/evaluations/miaoji-qa-baseline-v1.json /tmp/meeting-qa-candidate.json
```

输出 `passed=true` 仅说明逐题召回/精度未回退且权限、过期内容、应为空边界未失败；不是功能发布通过或回答准确率通过。有回退退出 1；题库哈希、问题、gold、题目数量不一致或数值无效则拒绝比较。依赖版本与源码哈希随报告保留，依赖升级需说明后重新建立基线。

## 标注与评分

31 题：25 题有可引用的 gold 证据，5 题应无召回，1 题有相关讨论但缺少所问金额、需模型承认未知。每题保存原始记录、固定日期、来源、所有权/授权、当前校对或人工纪要、预期记录别名与原文证据片段，以及回答要求。题库全为合成内容，无账号、令牌或真实会议文本。

- record_recall：每题命中 gold 记录数 / gold 记录数。
- evidence_recall：进入**真实生成上下文**的 gold 片段数 / gold 片段数；必须属于标注的对应记录，重复候选不会反复加分。
- evidence_precision：真正包含 gold 片段的候选引用数 / 候选引用数；有证据题却没有召回计 0。
- all_evidence：该题全部必需证据是否齐全，跨会议对比必须同时找到两侧。
- reciprocal_rank：首个含必需证据的候选排名倒数；不是人工相关性排序分数。
- largest_record_share：候选中占比最大的记录，配合 unique_records 识别同一记录挤占。
- 无 gold 的题不进入正例召回/精度分母，也不会因空集合 all() 获得召回成功。应为空的题另报分母；“金额未定”允许召回相关讨论，不强制模型盲目拒答。
- 每条引用复核当前权限；禁止片段/记录是硬失败。上下文与引用卡片 snippet 分开保留，防止把命中记录、160 字卡片或来源状态 ok 等同于可回答证据。

pytest 的绿色表示评测过程及安全边界可用，**不表示31题问答质量都通过**。质量缺口记录在报告里，不能把预期失败改成空 gold 来提升分数。

## 分层测量与人工回答评分

第一层（已执行）：真实 `GlobalAskService(scope="meetings")._keywords/_prepare` 与 ORM 召回，记录模型实际会看到的上下文；LLM/embedding/跨源调用受测试守卫限制，无付费生成。统一记录之外的历史 TranscriptChunk/Summary、IM/日历、组织停用与大库性能不是本题库覆盖范围；原有 API/撤权回归另跑。

第二层（待执行）：使用报告中的 `generation_prompt` 和 question 固定同一模型/参数生成回答，记录 model、prompt/hash、参数、耗时、用量、错误。空召回题验证罐头路径；非空召回题才需要实际模型。不得在运行时将 gold 混入提示词，也不能把 Mock 返回内容当成真实回答质量。

第三层：对每题补 `generated_answer` 与 `human_review`，至少由复核者逐项检查：

| 字段 | 评分规则 |
|---|---|
| correctness / completeness | 0 错误或遗漏主要事实；1 部分正确/部分覆盖；2 全部事实正确/完整；0/1 必须写明缺失或错误 claim。 |
| citation_support | 标出每个可核查 claim、使用的引用号及支撑原句，检查引用号存在并实际支撑；合法编号不能替代语义支撑。 |
| chronology / contradiction | 有前后变更时说明时间与各自版本；冲突未解决时并列，不擅自选择。无此要求记 N/A，不计作满分。 |
| abstention | 无证据或金额未定时明确不足，不猜测；不能只检查是否包含“没找到”字样。 |
| instruction_boundary | 资料中的指令作为引用内容，不能改变回答任务；相应题当前只验证召回，尚未验证模型遵循。 |
| reviewer / notes | 记录复核者、复核时间和理由；争议另人复核。未评分保留 null，不能当 0 或满分。 |

诊断/validation 分组在 v1 冻结后保持不变；两组均已公开和跑过，validation **不是盲测集**。后续使用脱敏真实问题增补独立留出集，版本变更后重新跑 baseline 与 candidate，不能直接横比不同题库的总分。

## 下一轮准入建议

权限/旧版泄漏 0；本题库应为空题 5/5 保持；逐题证据覆盖、记录召回和证据精度不退化。下一轮先解决四个候选挤占题、英文常见词占位与上下文关键句截断，再评估同义/跨语言召回。建议在本 v1 上达到至少 22/25 题证据齐全，并完成冲突、未知与引用支撑的真实回答复核后，再决定是否推广。这个阈值是项目建议，不是线上准确率承诺；同时检查候选数量、提示词长度、延迟与成本，避免只放大候选数。


## 第59批混合来源诊断集

`meeting_qa_mixed_cases.json`是独立12题诊断集，9道有证据、3道应为空。`test_meeting_qa_mixed.py`执行统一记录与旧TranscriptChunk共同进入meetings scope的真实查询，设置`MEETING_QA_MIXED_OUTPUT`导出报告。向量控制使用固定人工向量，只验证分支仍可用；禁止真实生成和外部源调用。该题集不是盲测，不替换冻结31题。

旧实现与候选报告在`docs/research/evaluations/miaoji-qa-mixed-{baseline-v1,candidate-b59}.json`。用同一比较器比较两者，并另比较原31题b57/b59，不能跨题库总分混算。生产中文视频派生回归在`test_meeting_search_ranking.py`，不含旧会议私有文本。生产重问及真实回答质量继续单独验收。

## 第61批：固定证据实际生成对照

`meeting_qa_answer_cases.json` 是独立6题诊断集，固定证据来自合成数据与用户提供的公开样本；不读生产会议、不测召回。`prompts/meeting_qa_b61_{before,after}.txt` 冻结本批前后模板。两套检索题库继续单独比较，不混算分母。

以下命令从仓库根运行，明确调用外部模型并产生费用。自行通过环境变量提供 `MIAOJI_EVAL_API_KEY`，不要提交凭据：

```bash
python src/backend/core/tests/evaluations/run_answer_eval.py --before src/backend/core/tests/evaluations/prompts/meeting_qa_b61_before.txt --after src/backend/core/tests/evaluations/prompts/meeting_qa_b61_after.txt --output /tmp/answer-eval.json --model qwen3.8-flash --base-url https://dashscope.aliyuncs.com/compatible-mode/v1
```

使用一个新的输出路径保留既有结果；每题每侧只生成一次，错误直接退出、不自动重试，已完成输出逐次保存。请求只发送context与question，不发送requirements。报告记录模板/哈希/用量/耗时，Qwen3系列关闭thinking；其他模型不设置该参数。该脚本不走应用用量登记，不能用于声称生产成本数据。

成功请求不等于质量通过；检查完成原因，再逐claim核查引用。Codex复核只写`assistant_review`，`human_review`留待独立人工。第61批报告保留了日期表达缺口，没有把6题小样本当成完整问答验收。

## 第63批：空结果关键词改写离线实验

生产代码不变。新增`meeting_qa_expansion_cases.json`的14题，与原31题独立计分。先不设置`MEETING_QA_EXPANSIONS`运行`test_query_expansion.py`，以`MEETING_QA_EXPANSION_OUTPUT`指定目录，导出问题计划和基线。随后显式调用外部模型（产生费用）生成固定产物：

```bash
python src/backend/core/tests/evaluations/run_query_expansion.py --plan /tmp/b63/plan.json --output /tmp/rewrites.json --model qwen3.8-flash --base-url https://dashscope.aliyuncs.com/compatible-mode/v1
```

通过环境变量提供`MIAOJI_EVAL_API_KEY`，不提交凭据。计划只允许id/question；原始记录、gold和答案要求不会发给模型。输出文件已存在则拒绝覆写；每case一次，不重试挑结果。最终回答模型不调用。

使用已提交产物重放时无需模型凭据或网络。从backend目录执行（先按本文件开头配置测试数据库，路径使用绝对值）：

```bash
MEETING_QA_EXPANSIONS=/absolute/repo/docs/research/evaluations/miaoji-qa-expansion-generations-b63.json MEETING_QA_EXPANSION_OUTPUT=/tmp/replay python -m pytest core/tests/evaluations/test_query_expansion.py --no-cov
```

对输出的每套`baseline/candidate`使用既有比较器。新题库可召回而非空态的题只有8道，不能与旧25道合并分母；pytest通过只表示评测与边界控制运行通过。原题库基线还应与第61批逐题比较。六项人工指定关键词的权限/修订控制不计入模型改写成绩。详情与未推广原因见第63批文档。

## 第64批：冻结语义向量与多阈值重放

只用于合成测试数据库。`semantic_candidates.py`全量枚举当前可见有效内容，切800字符窗口，使用真实向量和原上下文配额；不是生产索引实现。`meeting_qa_semantic_cases.json`新增带干扰的12题，与原31题/第63批14题各自计分。

先不设`MEETING_QA_VECTORS`，以`MEETING_QA_SEMANTIC_OUTPUT`指定目录运行`test_semantic_retrieval.py`导出plan；此时是planning，不能把相同基线当向量评测结果。显式生成向量会产生费用，环境变量`MIAOJI_EVAL_API_KEY`提供凭据：

```bash
python src/backend/core/tests/evaluations/run_semantic_embeddings.py --plan /tmp/semantic/plan.json --output /tmp/vectors.json.gz --model text-embedding-v4 --base-url https://dashscope.aliyuncs.com/compatible-mode/v1
```

输出已存在则拒绝覆盖，成功请求逐次保存；失败不自动重试。只发送plan中的合成文本，最多256个输入，1024维。没有gold或最终答案生成。模型服务请求不经应用用量登记。

从backend目录离线重放本批已提交向量（先配置测试数据库，路径换成绝对路径）：

```bash
MEETING_QA_VECTORS=/absolute/repo/docs/research/evaluations/miaoji-qa-semantic-vectors-b64.json.gz MEETING_QA_SEMANTIC_OUTPUT=/tmp/semantic-replay python -m pytest core/tests/evaluations/test_semantic_retrieval.py --no-cov
```

`report.json`内每个corpus有baseline与五档reports、逐题comparisons以及ranking诊断。报告的`generation=disabled`指没有回答生成，embedding来自指定冻结产物；mode必须是replay才是实际语义评测。计划、向量和harness的hash须相符，模型/维度/数值不匹配会拒绝。阈值只做敏感性对照，不能从同一批合成数据挑阈值就当作线上校准。

第64批0.55仍存在实体错误，0.65大量漏召回，未接入生产。pytest绿色不表示全部质量比较通过；详见第64批决策文档。

## 第65批：编号过滤与证据重排

`test_evidence_rerank.py`复用第64批冻结向量，比较字面基线、语义0.35、编号过滤、再加模型重排四方案。另有`meeting_qa_rerank_controls.json`六个直接控制，单独计分。只过滤空结果补召回，不修改生产服务或实现持久索引。

从backend目录运行，先按本文配置测试数据库。离线回放已提交的实际生成，无需密钥或外部请求：

```bash
MEETING_QA_RERANK_DRAWS=/absolute/repo/docs/research/evaluations/miaoji-qa-rerank-generations-b65.json MEETING_QA_RERANK_OUTPUT=/tmp/rerank-replay python -m pytest core/tests/evaluations/test_evidence_rerank.py --no-cov
```

指定输出目录时应运行整个文件，勿只挑部分用例或使用xdist；session级汇总检查57个检索case和6个控制完整性。可以与其他回归联合执行，pytest-django可能按数据库标记重新排列用例。无输出目录、无生成文件时只执行规划/结构检查，不代表模型质量已测。

重新实验时，先不设`MEETING_QA_RERANK_DRAWS`，设置`MEETING_QA_RERANK_OUTPUT`导出plan。显式调用模型会产生费用，环境变量`MIAOJI_EVAL_API_KEY`提供凭据；仍从backend目录以模块方式运行：

```bash
python -m core.tests.evaluations.run_evidence_rerank --plan /tmp/rerank-plan/plan.json --output /tmp/rerank-draws.json --model qwen3.8-flash --base-url https://dashscope.aliyuncs.com/compatible-mode/v1
```

输出已存在则拒绝覆盖，每题一次、不自动重试。只发送问题与合成候选id/title/text，不发送gold或内部标签。完整保留原始输出、用量和完成原因；形状/摘句不合法会记录`invalid_output`并拒绝选择。重放校验输入hash及原始输出与保存选择一致。摘句存在不证明语义相关；最终回答未生成。

第65批22次请求中有一次裸编号数组输出，按原样冻结。三套题库应为空题恢复，但干扰正例从6/6降到3/6，含产品上线误配快递。报告中的比较器通过只表示相对字面基线无退化，不等于相对语义候选无损；`summary`另外保留语义到重排的逐题比较。详见第65批决策，候选不推广。

## 第66批：严格Schema与场景决策

`structured_rerank.py`定义两个固定方案：原证据要求适配严格Schema的`schema_only`，以及增加场景核对/歧义决策的`scenario`。复用第65批输入计划，另加入`meeting_qa_scenario_controls.json`中的14个直接控制（10个基础样例、4个反序变体），共36个输入、每方案各一次请求。它们是合成诊断，不是独立盲测。

从backend目录、已配置测试数据库的环境重放，不需要网络或模型密钥：

```bash
MEETING_QA_STRUCTURED_DRAWS=/absolute/repo/docs/research/evaluations/miaoji-qa-structured-generations-b66.json MEETING_QA_STRUCTURED_OUTPUT=/tmp/structured-report.json python -m pytest core/tests/evaluations/test_structured_rerank.py core/tests/evaluations/test_structured_rerank_runner.py --no-cov
```

未设置生成文件时，154个需要模型产物的回放case会明确skip，只运行本地契约检查；不能将skip算作质量通过。回放使用session汇总，应运行完整文件且不使用xdist。报告仍按第65批gold判断旧题，旧正例即使返回`clarify`也计为漏召回。新增明确期望澄清的题另行评分。

如需重新付费生成，从backend目录运行以下命令，`MIAOJI_EVAL_API_KEY`通过环境注入；使用新输出路径，不覆盖既有结果：

```bash
python -m core.tests.evaluations.run_structured_rerank --plan /absolute/repo/docs/research/evaluations/miaoji-qa-structured-plan-b66.json --output /tmp/new-structured-draws.json --model qwen3.8-flash --base-url https://dashscope.aliyuncs.com/compatible-mode/v1
```

脚本核对计划与冻结数据相符、总输入不超过64个；逐条保存响应，交替方案调用顺序，失败不自动重试。使用严格JSON Schema、不设置max_tokens，本地继续检查ID、原文摘句及decision/selected一致性。报告核对完整请求hash、模型、提示、Schema、输入和原始响应；不把合法JSON等同于正确证据。最终回答与生产索引均未接入。
