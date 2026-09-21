# 纪要动作与时间条件约束（2026-09-21）

独立质量专项。前一项 [ASR 有限对照及 Helm 394 复核](miaoji-asr-language-candidates-2026-09-21.md)已提交 `981a8a336`；本轮继续处理生产中实际出现的无依据动作、保留条件误填截止时间及条件事件化。专项尚未整体完成。

## 改动与边界

共用生成提示要求：待办只能包含原文明示的工作；校对/完成不隐含提交、发送或汇报。due_text 仅用于执行该动作的明确截止时间，保留时段、禁止边界和先决条件应留在正文。概述和章节将故障处理原则表达为原则，只有明确报告发生才描述为事件。

不修改历史内容，不创建业务任务，不对自由文本执行未经依据的正则“纠错”。短文生成、分块提取与汇总均采用同一约束。分块提示版本由 3 升至 4；旧版本 1/2/3 的长文计划在付费模型调用前拒绝，需显式重新生成，不自动重试。部署前让在途长文任务完成；无数据库迁移。

## 八份首次候选

[固定输入](evaluations/miaoji-summary-action-boundaries-inputs.json)包括 Helm 393 的原始快照（无重写）、保留录音、明确校对期限、明确要求提交、明确故障原则，以及上轮“条件未发生/实际已失败”两例。每例只请求一次，qwen3.8-flash，无自动重试；[输出](evaluations/miaoji-summary-action-boundaries-results.json)保留原始回答、解析结果和提示哈希。

| 样本 | 本次评审（Codex） |
|---|---|
| production393-zh | 陈晨只负责术语校对，未加“提交”；期限保留。概述以“清理失败时”表达原则，章节没有编造修复任务；decisions 保留原句歧义，不宣称已全面消除。 |
| production393-en | 15,000 not 50,000、Alice/Bob、before Thursday afternoon 保留；未知 review 责任人空。保留录音在决策正文，未变成动作截止时间。 |
| retention-only | due_text 为空，但正文将“复核前”扩写为“复核完成”，时间语义仍失败。 |
| explicit-deadline | 陈晨校对、明天下午两点前保留，没有附加提交动作。 |
| explicit-submission | 明确要求的提交报告及期限保留，没有被约束误删。 |
| failure-rule | 处理原则及“今天没有发生失败”保留，未虚构故障/修复待办。 |
| conditional-only | 当前成功、未失败、重传未定均保留，action_items 为空。 |
| actual-failure | 一次实际失败、陈晨重传、明天上午十点前保留，再失败才通知的条件保留；没有生成无条件通知待办。 |

8 份都通过结构和精确引用校验；不等于语义全通过。输入仍为合成脚本或其首次转写，未经人工复核，不外推到真人会议。

## 未采用的第二候选

对保留边界再补一句“不要把 before review 扩为 until completion/after review”，只请求四个固定/控制样本一次。[输入](evaluations/miaoji-summary-action-boundaries-v2-inputs.json)及[首次结果](evaluations/miaoji-summary-action-boundaries-v2-results.json)仍完整保留。

第二候选没有解决问题：英文章节仍写 until after the review；中文 retention-only 仍补出“复核完成”；显式“保留直到复核完成”的反例把保留条件填入 due_text。不能声称靠该提示稳定修复时间语义，**最终代码未采用这句额外提示**，没有反复抽样选最好结果。第一候选对生产已知动作扩写和 deadline 字段的定向改善保留，时间条件仍是明确遗留缺口。

后续应评估动作/期限的独立来源证据和字段校验，再用保留条件与真实完成期限反例验收；不能将本轮概括为所有纪要事实已正确。候选结果不回写生产版本。

## 验证与交付范围

73 个相关回归通过，覆盖来源快照、版本、引用、分块、过期提示版本 1/2/3 不付费执行、未知责任人和语言规则；Ruff/diff 检查通过。第二候选仅临时提示文字不同，最终恢复第一候选提示及同一解析/执行路径；两份提示哈希分别留存。

只需发布 backend，agents 的上一批改动仅是评测工具。本轮停在 backend 生产发布依赖，随后对同一隔离快照复核新增动作约束。已知语言分支仍缺合法带语言元数据的生产样本；真人标注及 App 画面阻塞继续保留，详见[收尾清单](miaoji-quality-diagnostics-completion.md)。

## 固定镜像

实现与证据 `7ee54f11e` 已提交推送。由固定提交 Git archive 构建 backend-production，未带入其他窗口未提交改动；仓库推送完成：

- `jusi-cn-guangzhou.cr.volces.com/we-meet/meet-backend:7ee54f11e`
- Digest：`sha256:2217fd6bb9262b95c0088ff28dd40b1c018ace30f84447def669e8d764ce488d`

在途长文纪要完成后执行：

```bash
bash deploy/aliyun/release-meet.sh --tag 7ee54f11e backend
```

无需 agents/frontend/summary 发布或数据库迁移。固定 tag 对应第一候选提示；第二候选仅作为未采用的失败证据保留。

## Helm 395 后续验收

用户已部署 backend 1e13d1689，与实现运行代码一致。两个固定隔离样本定向复核通过：没有新增提交动作或错误录音截止时间，责任人/金额/期限保留，旧版本未变。原句歧义和其他边界失败未据此关闭；[生产结果与总体状态](miaoji-quality-acceptance-395.md)记录实际范围。本页之前待部署状态已解除，无需再发镜像。
