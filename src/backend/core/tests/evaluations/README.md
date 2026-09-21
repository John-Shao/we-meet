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
