# ASR 无语音分类与提示（2026-09-21）

独立专项，不占用共享批次号。范围是原生录后 sealed filetrans：把明确的供应商无文字错误转换为可理解的提示，保留原有失败、重试和版本保护语义。

## 结论与证据

使用已冻结的 3 秒静音 WAV，通过本地 adapter + OSS + 实际 Qwen filetrans 服务做两次独立请求（诊断一次、修改后验证一次，无自动重试）。两次均得到 `PENDING → RUNNING → FAILED`，终态 `output.code=ASR_RESPONSE_HAVE_NO_WORDS`，没有结果文件。第一次仍映射为 `transcription_poll/failed`，修改后映射为 `transcription_poll/no_speech`。临时对象执行 finally 删除；没有修改生产录音记录，没有覆盖第一次六样本基线。

[阿里云官方错误码说明](https://help.aliyun.com/zh/model-studio/error-code)将该码解释为识别结果为空，可能没有有效语音或过滤后无文字。文档相关描述主要针对 Paraformer；本次 Qwen 分类同时以实际观测到的终态代码为依据，不推断其他模型都具有相同协议。

Helm 389 的历史静音任务 `9bdbbbe5-6c7d-4985-b514-5e0ada5f0ef0` 只保存了通用失败，不能用这次新请求反写或证明历史任务的供应商代码。其历史回执保持不变。

## 行为与兼容性

- adapter 仅接受 `FAILED + 精确代码 + 无结果文件`。通用失败、超时、消息中出现同名字符串、存在部分结果均不归类为无语音。
- worker 在没有生成/回传文字、所有根错误均为无语音且没有额外清理故障时，才发送 `failure_code=no_speech_detected`。任务仍为 `incomplete`；不伪造 provider finished 或成功原文。
- 后端再次检查已开始的 sealed 任务、完整保存的音频清单、全部输入确认、任务数量/采样数匹配、零原文和零回传。缺片、部分文字、其他错误仍是通用未完成；取消/过期状态不被覆盖。
- 回执已有 JSON 字段持久化该枚举，无数据库迁移。相同终态回执可重放，不同回执仍冲突；旧的成功原文不会被本次空结果替换，既有权限、计费确认和显式重试流程保留。
- 新后端在 worker claim 中增加 `supports_failure_code=true`；新 worker 只对声明支持的后端发送新字段，旧 worker 仍使用原格式。部署先 backend/frontend，后 agents。若任务已经领取，后端回滚可能使在途新格式回执被旧版本拒绝，回滚前需排空任务。
- Web（五种语言）和 Android（英语/中文）显示“未识别到有效语音”，并提示检查录音内容、音量和麦克风，再决定是否重新转写。仅在 `incomplete + no_speech_detected + final_count=0` 时显示。不触发自动重试。
- 只读探针新增安全枚举 `failure_code`，取后端最终判定；阶段日志允许 `no_speech`。不输出供应商原始消息、录音内容、凭据或签名 URL。

## 验证

- Agents 59 项相关单测：filetrans、sealed/live、阶段故障及质量评分回归；覆盖旧后端兼容、部分文字、混合故障和额外清理失败。
- 后端 38 项：新增无语音回执、输入/采样/任务数不匹配、缺片、未知代码、旧协议、幂等和旧成功版本保护；原有 sealed/live 回归。修正一条历史版本断言：旧文字仍可读，但当前接口正确禁止校对历史版本。
- 只读诊断 7 项：阶段/原因白名单及敏感信息过滤。
- Web 35 项、TypeScript 构建检查、JSON 和五语言结构检查通过。
- Android 9 项（状态分类 2、转写 repository 7）通过，debug APK 构建通过。没有安装到共享模拟器，尚未进行本次 App 画面验收。
- 修改后的真实静音请求确认 `transcription_poll/no_speech`。这验证的是本地 adapter 与真实供应商链路，不替代生产后端/worker 或终端验收。

## 发布后验收与剩余边界

发布 backend/frontend/agents 并更新 Android 后，用新建独立静音录音显式转写一次：API 应为 incomplete、no_speech_detected、0 原文，双端显示无语音提示；普通语音仍成功，已有原文在失败重试后保留。使用新 job UUID 执行 `python3 deploy/aliyun/check_capture_transcription.py --job <UUID> --worker-logs`。

本次只处理实际观测到的顶层 FAILED 代码。供应商 SUCCEEDED 且显式空 transcripts 的原有语义、实时 ASR、上传转写路径没有因此宣称完成无语音统一分类。R9 的真实人声/交叠/真实噪声标注、纪要与待办事实质量、完整持久诊断历史仍未完成；不将合成样本视为真实会议准确率。
