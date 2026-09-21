# 原语言与术语有限对照 / Helm 394 复核

2026-09-21，独立质量专项，不占用共享批次号。本轮仅新增评测工具与证据，不改变生产 ASR 参数。

## Helm 394 的实际验收边界

用户部署 backend `7fffb1f9f`，与 `eb9f94dca` 的 src 无差异。只对原有中文隔离记录显式重新生成一次，job `cf46aff1-4ab3-4ee6-a280-7561f0690558`，generation 5；原文未修改，历史纪要 content 不变，[首次输出](evaluations/miaoji-summary-quality-production-394.json)已冻结，引用的 segment/revision/时间精确匹配。

本次输出中文，陈晨和周五下午三点前保留，没有再次补出“提交”；但章节仍写“处理临时文件清理失败问题”，条件事件化风险未消失。任务 partial / coverage unverified，不能由单次变化宣称修复语义错误。

**本次只能验证空语言回退，不能算已知语言约束的生产端到端通过。** 两条固定合成测试记录与此前音视频测试记录的语言均为空；生产 filetrans 候选也未返回语言，实时适配器当前明确写空语言。没有给历史转写强行补标签、伪造供应商回执或绕过来源哈希。已知语言约束有本地真实模型和直接/分块回归证据，但待具有合法源语言元数据的生产样本验收。部署成功与该分支实际生效分开记录。

## ASR 候选方案与复现

官方 [非实时识别指南](https://help.aliyun.com/zh/model-studio/non-realtime-speech-recognition-user-guide)描述 language_hints；[当前模型 HTTP API](https://help.aliyun.com/zh/model-studio/fun-asr-recorded-speech-recognition-http-api)支持即时 vocabulary，其中普通权重范围 1–5。只给评测用子类的提交请求加参数，结果下载继续不携带授权；生产适配器没有修改。

使用既有 ZIP 和哈希；第一次候选为两个干净样本分别传 en/zh，第二次候选为中文干净、中文 10dB 噪声和静音传 zh，并加 `{"妙记": 5}`。不提供整段答案或人名/金额提示。共五次真实供应商请求，各例一次、首次失败停止、禁止覆盖结果。临时文件按现有 adapter 删除流程处理；未独立 HEAD 验证删除。不代表生产 Pod/App，也没有新建 ASR 用户记录。

| 样本 / 参数 | 原始基线 → 本次结果 | 判定 |
|---|---|---|
| 英文干净 / en | 严格 CER 26.10% → 0%；全部保持英文，5/5 术语 | 原先自动翻译的句子本次保持原文；没有无提示同期重复对照，不能把单次改善全归因于参数或宣称总体提升。金额否定、Alice/Bob、截止时间保留。 |
| 中文干净 / zh | CER 2.82%，6/7 术语，仍为“妙计” | 单独语言提示不解决该专名。 |
| 中文干净 / zh + 妙记5 | CER 1.41%，7/7 术语，写为“妙记” | 陈晨、周五下午三点前、否定关系保留；剩余严格字符差异为“三”与“3”。 |
| 中文噪声10 / zh + 妙记5 | CER 2.82% → 1.41%，7/7 术语 | 本次专名保留，关键事实未改变；噪声候选同时有语言与热词参数，不能分离二者效应。 |
| 静音 / zh + 妙记5 | transcription_poll / no_speech，0 文字 | 没有凭空产出词项。runner 仍将其记为 failed，不将静音零输出当全链路成功；生产预期为已实现的 incomplete/no_speech_detected。 |

所有返回语言依旧为空，speaker 仍为空；请求的语言提示不等同识别结果标签，未将其伪造成已识别语言。术语召回及 CER 不是语义正确率。Codex 逐项复核，尚未经人工审核，仍是合成语音而非真人质量基线。

证据位于 `src/agents/evaluations/asr_quality/`：`language-candidate-2026-09-21-{results,score}.json` 与 `term-candidate-2026-09-21-{results,score}.json`。评分器仍以六项固定全集列出未测项，不缩小分母假装完整重测。

```bash
python src/agents/evaluations/asr_quality/run_provider.py --execute --known-language-candidate --label language-candidate --output /tmp/new-language-results.json
python src/agents/evaluations/asr_quality/run_provider.py --execute --term-candidate --label term-candidate --output /tmp/new-term-results.json
```

两个开关互斥，分别最多 2/3 次付费请求。4 项新增测试覆盖请求参数隔离、下载授权边界、样本数量和静音控制、首错停止及证据不覆盖；Ruff 通过。不将个人/组织热词、源语言选择、原生分人等产品能力算作已交付。该对照完成了“同固定音频的有限候选”这一评测事项，生产集成及真人效果仍未验收。
