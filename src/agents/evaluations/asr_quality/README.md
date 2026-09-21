# ASR 质量基线 v1

本目录固定六个**合成音频**样本及首次真实 filetrans 结果，用于回归多人轮流说话、术语、噪声与静音。不是人类会议准确率评估，也不是飞书对比测试。自动分人、中文多人交叠、真实房间噪声及 AI 纪要事实/待办质量仍需另行验证。

## 样本与口径

- `fixtures.zip`：六个 PCM16 / mono / 16kHz WAV，总计 122.62 秒，约 3 MB 压缩包；`manifest.json` 保存每个 WAV 的 SHA-256、原文、说话人和时间窗口。
- 双人：Windows SAPI David/Zira 英文轮流发言；干净、10 dB、0 dB 三组，同一段音频只改变噪声。
- 术语：SAPI Huihui 中文，包含“妙记、对象存储、签名续期、跨账号权限、陈晨”；干净、10 dB 两组。
- 静音：3 秒零值音频，测试无语音时的处理，不把“没有输出”自动视为成功。
- 噪声：固定种子的高斯白噪声，按全文件（包含停顿）RMS 定义 SNR，并整体缩放以避免削波。不是咖啡厅/会议室/麦克风噪声。
- `script.json` 是合成输入与内容复核清单；原始 TTS 窗口含句内/句尾静音，**不是人工标注的发声区间**。当前不含重叠说话。

指标：

1. CER：NFKC、忽略标点空白与大小写后计算字符编辑距离。中文/英文使用同一字符口径；**不归一化数字表达，也不接受自动翻译替代原文**。因此 `fifteen thousand`→`15,000` 也会增加 CER，不能直接解读为关键事实错误。
2. 术语召回：冻结词项的严格归一化字符串命中。英文金额的同义数字格式不会自动获满分；具体事实另行复核。
3. 说话人窗口覆盖：最多四个身份的一对一最佳映射，缺失/合并身份受罚；未知身份为零覆盖，另有 `speaker_labels_available=false`。**不是 DER**，不得标成分人错误率。当前原生 adapter 不传 speaker，零覆盖反映能力未贯通。
4. 噪声差异：同样本 CER 相对干净音频的差值。单次测量不能推导噪声提升识别；供应商非确定性及文本规范化都可能影响结果。
5. 终态、任务耗时、静音虚构字符数：与准确率分开。失败/漏测保留在六题分母，静音失败且零字符不算验收通过。
6. `manual_fact_todo_review` 默认 pending：自动字符/词项命中不能证明事实、否定、责任人及时间正确，更不能替代纪要评估。

## 首次实测（2026-09-21）

使用当前 sealed adapter，`qwen-audio-3.0-asr-flash-filetrans` / `cn-beijing`，无热词、无分人参数。六次真实付费供应商任务，逐个提交、无自动重试；本地使用已配置的 OSS 临时对象链路，结束时执行删除。不是生产 Pod/App 验收，没有创建或修改用户记录。未独立 HEAD 验证每个临时对象删除。

| 样本 | 终态 | 严格 CER | 严格术语召回 | 耗时 |
|---|---|---:|---:|---:|
| 英文双人，干净 | 成功 | 26.10% | 4/5 | 5.913 s |
| 英文双人，10 dB | 成功 | 0% | 5/5 | 5.853 s |
| 英文双人，0 dB | 成功 | 11.24% | 4/5 | 5.831 s |
| 中文术语，干净 | 成功 | 2.82% | 6/7 | 5.915 s |
| 中文术语，10 dB | 成功 | 2.82% | 6/7 | 5.888 s |
| 静音 | 失败 | 不适用 | 不适用 | 5.636 s |

原始文本及指标分别保留在 `baseline-2026-09-21-results.json` / `baseline-2026-09-21-score.json`。不删失败，不用重跑的最好成绩替换。

逐条对照合成脚本发现：

- 英文干净样本将 “Please keep the original recording” 输出为中文。核心语义保留，但不满足原文忠实度；金额改成数字也增加严格 CER。该样本不能笼统称为 26.1% 事实错误。
- 英文 0 dB 的主要文字差异是金额格式；三个英文样本中的发布日、负责人、截止时间及金额否定关系在输出文本中保留。没有生成纪要/待办，不能据此确认纪要质量。
- 中文两组均把“妙记”写成“妙计”；责任人“陈晨”和周五下午三点保留，数字“三”→`3` 同样增加 CER。该词项适合后续热词对照。
- 静音未生成文字，但任务在 `transcription_poll` 阶段失败；这里只确认阶段，尚未取得更细的供应商无语音错误分类，不能认定为正常空结果。
- 所有输出无 speaker 标识。多人归属是明确缺口，不是“已有分人质量很好”。

## 运行

离线评分（无需任何凭据）：

```bash
python src/agents/evaluations/asr_quality/score.py --results src/agents/evaluations/asr_quality/baseline-2026-09-21-results.json --output /tmp/asr-score.json
```

真实执行必须显式传 `--execute`；需要 agents 依赖、`DASHSCOPE_API_KEY` 及与 filetrans worker 一致的 AWS/OSS 环境变量。不会打印凭据、对象 URL 或原始供应商异常。每例最多等待 180 秒，第一次失败即停止剩余样本；超时不代表供应商未计费或已取消。

```bash
python src/agents/evaluations/asr_quality/run_provider.py --execute --label candidate-commit --output /tmp/asr-candidate.json
```

独立结果文件必须不存在，防止覆盖基线。`score.py` 拒绝重复 ID、错音频哈希、非有限时间和重叠输出；当前非重叠样本不能用于正式 DER。新增真实交叠样本时需同时扩展标注和评分器，不能删掉重叠段来凑分。

重建合成音频（Windows，需三个指定 SAPI voice）：

```powershell
powershell -File src/agents/evaluations/asr_quality/synthesize.ps1 -OutputDirectory C:\temp\asr-turns-new
python src/agents/evaluations/asr_quality/build_corpus.py --turns C:\temp\asr-turns-new --output C:\temp\asr-corpus-new
```

voice/操作系统更新可能改变合成输出；重建到新目录并核对哈希，不直接覆盖已测 v1。v1 的权威输入是已提交 ZIP 和 manifest。

## 后续质量门槛

第一版是测量基线，不人为宣布全部达标。后续候选必须在同一冻结音频/相同参数下逐题比较，保留失败与首次结果；不得只报平均值。新增分人/热词功能要分别验证身份覆盖、专有词和关键事实，无静音虚构、无原文自动翻译才算对应行为通过。更广泛质量或供应商比较需预先制定人工标注集和验收阈值。

真实样本采集计划：至少两名知情参与者，分别录安静轮流发言、真实背景噪声、插话/交叠；按 `script.json` 覆盖同音人名、金额否定、责任人与截止时间。人工校对原文与说话人时间段，记录设备/语言/来源许可和哈希，建立独立 human 版本。不得把本目录的 TTS 时间窗口当作人类真实标注。
