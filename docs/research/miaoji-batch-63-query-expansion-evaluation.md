# 第 63 批：同义／跨语言空结果改写对照

日期：2026-09-21。代码基线 `0de1eed07`，生产仍为 backend `4c5ca713f` / Helm388。本批只新增评测代码、合成题库与报告，**不修改生产检索、不新增镜像、不需要部署**。App仍待共享Pixel8空闲后补验。

## 决策

**暂不将模型关键词改写接入生产。** 它补回一题原有跨语言查询，但新增合成对照的正例仍大多失败，并增加一段模型请求。原31题达到22/25只是本候选的离线结果，不表示生产从21/25升级，也不能单凭达到旧门槛推广。

| 独立题库 | 当前字面检索 | 离线空结果改写候选 |
|---|---:|---:|
| 原31题：25道有证据题完整覆盖 | 21/25 | 22/25 |
| 原31题：应为空 | 5/5 | 5/5 |
| 新14题：8道有证据题完整覆盖 | 1/8 | 3/8 |
| 新14题：应为空 | 6/6 | 6/6 |
| 两套题库禁止内容泄漏 | 0 | 0 |

原题库仅`cross_language`改善：`rollback`→`回滚/恢复/撤销`取得原文；`natural_synonym`仍失败。`synonym_cost`和`synonym_delay`带明确引号，按本候选保守规则不扩展，所以依旧失败。引号在自然问法中也可能只是强调，目前不能把“全部带引号都不扩展”的产品语义当成已验证结论。

新题库改善`revert_bilingual`、`ownership_paraphrase`；`delay_paraphrase`原本可命中。费用、英文上线问题、保留期、有效校对和人工纪要中的跨语言表达仍缺证据。没有调整题目、gold或重新抽样选择模型输出来提高分数。

## 候选如何运行

1. 在pytest-django回滚事务内生成合成记录，通过真实`GlobalAskService._prepare`先取得当前结果。
2. 仅当整体结果为空且没有成对引号时，把**问题本身**列入改写计划。模型不接收标题、记录正文、gold、答案要求或检索结果。
3. 用固定提示词请求最多3个替代关键词（每项2–40字符）。结构错误、截断或空数组不进入候选；HTTP失败直接结束，不自动重试。
4. 测试中临时替换`_meeting_keywords`，再次执行相同权限/版本/日期约束和相同候选配额的真实ORM检索。词按OR匹配，没有增大候选池；基线非空与带引号问题保持基线。
5. 比较实际生成上下文中的gold证据。**不运行最终回答模型**，所以报告`generation=disabled`指回答生成；问题改写来自另行冻结的真实模型产物。

候选只在测试中monkeypatch，不在service中暗设开关。旧TranscriptChunk的向量腿未被改写；统一记录和旧纪要通过共享会议词入口接收替代词。本实验主评测是统一记录fixture，不能据此声称混合旧来源的改写效果已验证；现有混合12题只做原实现回归。

## 真实生成与失败分析

共15次真实改写，每个合格case一次，`qwen3.8-flash`、temperature=0、max_tokens=200、enable_thinking=false。15次均stop且输出结构有效，总用量1830 tokens；单次2.078–3.255秒，中位数2.471秒。该时间仅为改写请求，不是线上总延迟或P95。没有生产记录传出，也没有写入应用AIUsageRecord。

- “项目经费”被改为`项目经费/最终批准金额/budget approval`，仍不匹配原文“预算”：模型理解相关语义不等于适合`icontains`的短词。
- “When is the product launch?”改为`产品发布时间/新品上市时间/launch date`，仍不匹配“产品上线日期”。
- “资料多久会被清掉？”改为`资料保留期限/数据清理周期/document retention period`，仍不匹配“数据保留期”。
- `deployment rollback`生成`部署回滚/发布回退/版本回退`等短语，仍不能命中“回滚使用……”；有效修订和人工纪要两题未召回。
- 相同`deployment rollback`在不同case各请求一次，得到不同列表；temperature=0也不保证确定性。本批保存各case实际输出，重放不重抽样；不宣称已经实现缓存、降级或生产成本控制。

这说明“问句→同义长短语→原有字面匹配”仍受连续子串约束。不能只添加针对这几道题的同义词表解决泛化，也不能用当前负例全空推导所有实体约束安全。

## 验证与证据

最终90项通过：45个真实基线/候选case对照、10项输入结构检查、6项强制命中边界控制、12项既有混合来源、8项引号回归、9项比较器；1条既有Django警告。新增脚本Ruff与diff检查通过。

真实模型的权限题没有召回不一定意味着实际触及权限过滤，因此另设6项**人工指定`回滚`关键词**的控制，强制制造词面命中：私有/撤权/回收/日期仍为空；校对与人工纪要仅返回当前文本，无旧句。控制结果不计入真实改写的召回得分。

三次逐题比较通过：新harness基线与第61批原题库相同；原31题候选无退化；新14题候选无退化。保持原题库hash不变，报告包含数据、实现、harness、改写产物hash，并验证计划hash与真实请求清单一致。

- [原31题候选](evaluations/miaoji-qa-expansion-candidate-b63.json)，基线继续使用[第61批报告](evaluations/miaoji-qa-candidate-b61.json)。
- [新14题基线](evaluations/miaoji-qa-expansion-controls-baseline-b63.json)、[新14题候选](evaluations/miaoji-qa-expansion-controls-candidate-b63.json)。
- [问题计划](evaluations/miaoji-qa-expansion-plan-b63.json)、[实际改写、用量与耗时](evaluations/miaoji-qa-expansion-generations-b63.json)。

新14题在模型请求前编写并冻结，但作者已知旧题库弱点，**不是独立盲测**；多为小型单记录fixture，不覆盖大库噪声与延迟。没有真实答案质量分数。

## 下一步

优先比较基于当前有效原文/纪要的语义候选与重排，而不是直接上线本次改写。先用同一冻结数据和带干扰记录的独立对照验证召回/空态/实体约束，再决定索引方案。

当前`TranscriptChunk.embedding`与`tasks/embeddings.py`属于已有会议分块链路，统一`MeetingOriginalSegment`与`MeetingSummaryVersion`没有对应的语义索引契约。若实验有效，落地前必须明确record/source/revision/model/text-hash标识、重建与失败重试、实时权限过滤、修订/回收/永久删除失效，以及候选与上下文预算。现有旧向量不能直接视作统一记录的可用索引。
