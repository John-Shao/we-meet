# 纪要与待办事实质量：首轮生产基线与候选约束

日期：2026-09-21。独立专项，不占共享批次号。

## 本轮结论

Helm 390（backend/frontend/agents `696a7768f`，包含 `ae4db984b`）已部署。新静音任务生产 API 返回 `incomplete + no_speech_detected + 0 原文`，普通中文录音成功；无语音分类服务端验收通过。App 已安装 `6f372546` debug APK，但深链打开操作被自动审批以 `blocked by policy` 拒绝，画面验收未完成。未通过其他操作绕过拒绝。

纪要质量首轮发现真实问题：两份英文纪要均把“预算 15,000，不是 50,000”扩写成对过去预算的纠正。新增约束在本轮固定输入候选对照中消除了该推断，同时保留明确的预算变更历史。**这是小样本定向改进，不是总体事实质量通过。** 中文概述仍有把条件性故障原则表述成实际故障的风险；真人会议质量、ASR 原语言/术语和持久故障历史也未关闭。

## 输入与首轮生产结果

所有生产操作均在演示所有者账号新建的合成测试记录进行。未分享、导出、创建业务待办或删除录音。纪要请求走应用既有生成流程；待办仅评估生成内容。

- [生产 ASR 证据](evaluations/miaoji-asr-production-390.json)：静音与中文固定样本、哈希、任务及首次原文。
- [四份生产纪要及不可变原文快照](evaluations/miaoji-summary-quality-production-390.json)。中英文分别评估原始 ASR 与一次最小校对后的文本；首次输出保留，不用后续最好结果覆盖。
- [冻结候选输入](evaluations/miaoji-summary-quality-inputs.json)：SHA-256 `11ba746100a5461a7cb0d0507b0c22363b5db367f25ae8a84b9886199d1f648b`。四个生产快照，加“明确变更”“否定日期”两个文本控制样本。

校对由 Codex 根据已冻结的合成语音脚本执行：中文只把“庙记”改回“妙记”；英文只把错误翻译成中文的一句恢复为英文。不是人工标注的真人会议参考集。修改后的段落 revision 为 2，首次纪要及 revision 1 引用快照仍保留。

| 生产输入 | 观察与判定 |
|---|---|
| 中文 ASR | “妙记”识别为“庙记”，纪要继续传播该术语错误。陈晨、术语校对、周五下午 3 点前保留。 |
| 中文最小校对 | 纪要使用“妙记”；责任人与相对时间保留。校对可以纠正源文本，但不证明识别质量改善。 |
| 英文 ASR | 一句被自动转为中文。纪要金额为 15,000，但增加“纠正之前的 50,000”历史；未指明身份的待办使用 Unknown speaker。 |
| 英文最小校对 | 恢复英文句子后仍出现预算历史推断；这是纪要生成问题，不能归咎于该句 ASR 错误。 |

四份模型版本均为 `qwen3.8-flash`；生成终态 `partial` 与 `coverage_status=unverified` 对应。交付完成、ASR finished 不代表覆盖已校验，因此保留 partial，不把它当供应商失败，也不为了验收改成 ready。

新静音 record `db461cae-0954-4420-936b-34320785fba0`、job `0b056ade-01b1-4161-b67b-37b8e6f9a158`；普通中文 record `7155dab2-6e13-494d-b0e2-83e55a7c1a60`、job `10e0aff5-e388-44af-aa98-c6760dc3c0d2`。新静音只有一次任务，未观察到自动重试。服务端阶段日志尚未用该 job 单独验收；API 证据不替代 App 画面或日志证据。失败后保留旧原文仍为此前回归证据，未在本轮生产重做。

## 候选实现与结果

在 `meeting_summary_versions._generate_content` 共用提示中约束：被否定的数值不代表历史决策；只有原文明示才能描述纠正/变更；未指明责任人/时间留空，泛化说话人标签不是身份；保留相对时间。直出和分块生成共用该入口。无模型、接口、数据库迁移或权限变化。

运行器：`src/backend/core/tests/evaluations/run_summary_quality.py`。实际调用生产提示、LLM transport、解析与引用校验，仅替换数据库 checkpoint 和计费记录 sink。显式 `--execute`；拒绝覆盖输出；供应商重试为 0；首次失败即停止。保留输入哈希、提示哈希、模型、原始输出和安全错误枚举，未输出凭据/异常正文。此运行器记录合成内容，不用于未经授权的实际会议数据。

| 候选输入 | 定向检查结果 | 保留的问题/边界 |
|---|---|---|
| zh-asr | 陈晨与周五下午 3 点前正确；引用原始 revision 1 | 仍传播“庙记”；概述“临时文件清理失败”可能把条件原则写成事实。 |
| en-asr | 预算为 15,000，无虚构历史；Alice/Bob 正确；未指明的复核人留空 | 概述将 before Thursday afternoon 写成 by Thursday afternoon；行动项保留 before。否定的 50,000 没有显式保留，属于压缩遗漏。 |
| zh-corrected | 使用妙记及 revision 2；责任人/相对截止时间正确 | 概述“指出临时文件清理失败的问题”仍有事件化风险。 |
| en-corrected | 无虚构预算历史；未知责任人留空；Bob 截止时间正确 | chapters 为空，不能据此声称章节质量通过；金额反例被省略。 |
| explicit-change | 明确保留原文批准 50,000 后调整到 15,000；Alice 与相对期限正确 | 单一控制样本，不代表所有调整表达。 |
| negated-date | Monday 正确；不虚构此前 Wednesday 期限；复核责任人/期限留空 | Wednesday 否定项被省略，仍需按真实使用需求评估信息完整度。 |

评审者：Codex，逐项对照冻结输入进行语义检查，未经人工复核。六次候选调用均通过生产结构和引用校验；有效引用不等于句子被原文支持，不将 6 次解析成功计为 100% 事实准确率。相对日期未转为编造的日历日期。保留录音直到复核后的措辞，不授权复核后自动删除。

[完整候选输出](evaluations/miaoji-summary-quality-candidate-v3.json)。之前两次本地配置失败分别保存在 [attempt 1](evaluations/miaoji-summary-quality-candidate.json) 和 [attempt 2](evaluations/miaoji-summary-quality-candidate-v2.json)：本地 bootstrap 把 secretKeyRef 当成标量 key，第二次明确 HTTP 401；修正为本地可用标量凭据后才完成六例。这不是生产供应商故障，也没有删除失败记录以改善通过率。

## 验证、部署与下一步

38 项后端回归通过：summary versions、capture summary、summary chunks、评测执行门禁/错误脱敏/结果绑定。Ruff 检查与格式检查通过。生产基线使用旧提示，候选使用本地修改后的真实提示；候选结果不是生产新版本验收。

待交付 backend 固定镜像后，需要生产部署并对独立合成记录显式生成一次，确认定向约束和既有 partial/版本/引用行为。frontend、agents、summary 无需为该提示变更重新发布。部署后继续条件/事实、否定遗漏与时间措辞质量，不应宣布专项全部完成。

其余阻塞与遗留：App 深链审批拒绝；真实多人轮流/噪声/交叠录音及人工标注待提供；ASR 原语言及术语候选对照未完成；通用阶段故障仍只有有界日志窗口，完整持久诊断查询尚未实现。大文件恢复与长原文跨页按用户要求继续延后。

## 固定版本交付

实现与证据提交 `2b84e9838` 已推送。采用该提交的 Git archive 构建，未带入其他窗口的未提交修改。backend production 镜像已推送：

- `jusi-cn-guangzhou.cr.volces.com/we-meet/meet-backend:2b84e9838`
- Registry digest：`sha256:7468c07d9944b90aa3e959fa953776967b7c3a9f5d97faeaab290dde7aa987f8`

生产主机执行：

```bash
bash deploy/aliyun/release-meet.sh --tag 2b84e9838 backend
```

本次停在生产部署依赖。部署后才进行新提示的生产纪要复核；此文档交付提交无需另建镜像。旧无语音修复已随 Helm 390 部署，无需重复操作。


## Helm 391 定向生产复核

用户回传 2026-09-21 18:24:28 Helm 391：backend/celery-backend/beat 均为 `0ccbd5e85`；其 backend 运行代码与 `2b84e9838` 一致。frontend/agents 仍为 `696a7768f`。对上一轮中文/英文最小校对记录各显式 regenerate 一次，先核对源段落完全未变；没有再校对、挑选重跑或修改首次结果。

[完整生产证据](evaluations/miaoji-summary-quality-production-391.json)：中文 job `d3f02b82-b289-424a-b353-9fe162ad2be8`、英文 job `52799e2b-1146-48d5-a5e3-2d869de7e156`。均生成新版本，终态 partial（覆盖仍未校验），旧版本正文完全保留；新版本引用逐项匹配不可变快照的段落、revision 和时间。

英文这次没有虚构“过去 50,000 预算”，15,000、Alice/Bob、before Thursday afternoon 正确；但 transcript review 的 owner_text 再次为 Unknown speaker，说明仅提示约束不能稳定保证未知责任人留空。中文保留妙记、陈晨和周五下午 3 点前，概述仍存在条件故障被事实化的风险。结论只关闭本次预算历史问题的定向生产复核，不关闭责任人、条件语义、遗漏或总体事实质量。
