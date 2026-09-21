# ASR 质量基线与阶段诊断（2026-09-21）

本专项独立命名，不占用多窗口共用的批次号。范围为原生录后 filetrans 及共用 capture worker 的故障诊断、首版合成音频质量基线；不是新增自动分人、热词功能或更换供应商。

## 已完成

- `asr_diagnostics.py`：固定枚举阶段与 `failed/timeout` 代码；按 job UUID 输出结构化日志和距任务开始的毫秒数。展开 TaskGroup 异常，保留内层错误阶段，不输出异常正文、原文、签名、对象键、凭据或供应商响应。
- 阶段覆盖：manifest、control、storage_read、audio_validate、storage_prepare、storage_upload、storage_sign、transcription_submit、transcription_poll、result_fetch、result_parse、delivery、cleanup、finish、execution（兜底）。sealed 文件链路细分供应商阶段；live 共用控制/输入/回传/终态，实时供应商内部仍可能归入 execution，不能宣称实时/上传全链路已细分。
- 原生 filetrans 把网络转写与结果发布拆成可测的函数。结果结构缺失不能再默认当空转写成功；明确的空 transcripts 仍可表示无语音。临时对象清理失败会被记录，且不会覆盖更早的存储/供应商根因；仅清理失败时保留原有“不完成”语义。
- `check_capture_transcription.py --worker-logs`：在只读回执报告之外，读取该模式 worker 当前 Pod 的当前/上一次容器日志。每份最多 24 小时、2000 行、2 MiB，仅投影指定 job 的已知阶段/代码/耗时，未知字段和其他任务忽略。无日志不代表无故障；已删除 Pod/更早日志不在本探针范围。此版不向数据库增加诊断字段。
- [质量基线目录](../../src/agents/evaluations/asr_quality/README.md)：六个固定音频、SHA-256、原文/说话人窗口、术语/事实复核清单、可复现白噪声、离线评分器及显式供应商运行器。语料不打入生产镜像。
- 不改变任务授权、自动重试、计费 gate、终态回执协议、数据库或前端接口；finish 回传不确定仍停止 worker，不声称成功后继续领取。

## 真实测量结果

音频是本地 SAPI 合成，不是人类真实会议：英文 David/Zira 双人轮流说话三组（干净/10 dB/0 dB），中文 Huihui 术语两组（干净/10 dB），静音一组，总计 122.62 秒。对当前 `qwen-audio-3.0-asr-flash-filetrans` / `cn-beijing` 提交六次真实付费请求，无自动重试。

**5/6 成功，静音失败于 transcription_poll。** 成功例耗时 5.831–5.915 秒。中文两组严格 CER 均 2.82%、术语召回 6/7，均将“妙记”写为“妙计”。英文干净样本将一句英文输出成中文；严格 CER 26.10% 同时受金额数字格式影响，不能称为同等比例的事实错误。10 dB 样本 CER 为 0，0 dB 为 11.24%；单次结果不支持“加噪提升准确率”的结论。

原生 adapter 无 speaker 字段，所有样本的身份覆盖缺失，不能把文件转写成功当自动分人通过。静音没有输出文字也不能掩盖失败终态。关键事实对照和原始输出详见质量目录；未生成纪要/待办，相关质量仍 pending。

该实测是本地 adapter + 已配置 OSS/供应商链路，不是生产 Pod 或 App 新版本验收；没有创建/修改用户记录。临时对象执行了 finally 删除，未另做逐对象 HEAD。已保存首次结果，不挑选最好的一次，不承诺人类会议准确率或 DER。

## 验证

- Agents 相关 **56 项**通过：原生 sealed/live、filetrans、实时 ASR 既有回归，加上阶段故障注入与质量评分反例。
- 只读诊断工具 **6 项**通过，包括任务隔离、非法/附加字段过滤、不回显原始错误。
- 故障注入覆盖上传、签名、提交、轮询、结果获取、解析、交付、双重清理错误、TaskGroup、取消、终态未知与输入校验；质量评分覆盖 speaker ID 换名/合并、错词、静音虚构、漏测、失败、错哈希、重叠时间和重复 ID。
- Ruff / 格式检查、Git whitespace 检查通过。六次真实供应商结果与离线基线评分已固定保存。

## 发布及生产复核

仅需构建/发布 **agents**，无需 backend/frontend/summary、数据库迁移或开关修改。生产发布前使用本专项代码提交的固定镜像 tag；不要直接把其他窗口后续文档提交当镜像 tag。

发布后选择新建短测试录音，显式发起一次转写，再执行：

```bash
git pull
python3 deploy/aliyun/check_capture_transcription.py --job <本次任务UUID> --worker-logs
```

成功任务以终态回执和原文为依据，通常没有失败事件；失败任务应给出对应阶段。不得用新代码部署后的空日志“证明”历史已删除任务无错误。生产 Pod 故障注入、应用展示、持久诊断历史不在本次通过范围。

## 剩余边界

R9 从“无共同基线/只有笼统 incomplete”推进到“有可执行 v1 和阶段定位”，但未关闭：真实多人/交叠、方言/真实噪声、人工分人时间标注、AI 纪要/待办事实质量、正式终端仍需补。静音失败的供应商原因分类、输入语种忠实度和“妙记”专有词是本轮暴露的具体后续项。原生自动分人/热词仍属于 R1/R2，不在本专项顺便实现。
