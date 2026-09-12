# 会议 AI 阶段 0 执行记录

日期：2026-09-12。状态：**阶段 0 执行中；本地盘点、公共契约和三类核心模型的真实连通验证已完成，业务样本质量与端录音验证未完成，M0 尚未整体通过。**

## 1. 本轮结果

| 任务 | 状态 | 已完成 | 剩余 |
| --- | --- | --- | --- |
| A01 环境/资源 | 部分完成 | 仓库、部署配置、模型工厂、容器与 SDK 环境盘点；指定百炼凭证与北京 Workspace 已验证可调用 | 目标 we-meet 测试/线上环境、账号并发额度、真实历史数据回填盘点 |
| A02 模型验证 | 核心连通通过，业务评测待完成 | 7 项 mock 测试；真实短/长总结、实时 ASR、中英双向翻译、连续同传与纯文本翻译通过 | 业务样本、候选 ASR 对比、多人/噪声/长会议质量与并发成本实测；文件 ASR 另验 |
| A03 公共契约 | 开发基线已形成 | [数据/API/事件/权限/状态契约 v0.1](meeting-ai-phase0-contract-v1.md) | 阶段 1 将契约实现为迁移/接口/端类型，并做兼容性测试 |
| A04 页面与终端 | 部分完成 | 页面状态表；定位 Android 工程、构建入口、前台服务；发现已安装 App 的模拟器 | 独立录音实现后做麦克风、后台、来电、蓝牙、弱网及真机验证；确认负责人员 |

代码基线：we-meet `ce967f41`；Android `3de74dd6`；外部复用项目 `d8ccb1f`。只读检查外部项目，不修改其业务代码。此记录不代表生产健康检查或真实模型效果报告。

## 2. A01：环境与配置证据

| 范围 | 观察结果 | 对实施的影响 |
| --- | --- | --- |
| 后端总结 | `LLMClient.from_settings()` 绑定 Ark/Doubao；总结服务三次生成，原文硬截最后 60,000 字节 | 独立 Qwen 总结配置；移除截尾；分项失败与输入覆盖明确 |
| ASR | 工厂默认 deepgram，可选 kyutai/doubao；本地 development 配置为 kyutai | 默认代码值不等于实际部署；新增适配层后按会话固定正式原文提供者 |
| 转写写入 | ingest_id 重试保持稳定，最多三次；失败后返回，不具备持久待补传队列 | 独立录音阶段需 ACK、持久补传与缺口状态；不能宣称当前无丢失 |
| 数据/队列/存储 | Compose 定义 PostgreSQL、Redis、Celery、MinIO、LiveKit；本地可见 PostgreSQL 与测试 Redis | 配置存在不等于完整服务可用；本轮没有完整会议服务运行证明 |
| 现有测试容器 | `meet-pytest` 的 /app 挂载 `jusi-team/jusi-meet-suite/src/backend` | 不在此容器运行并声称本仓库后端测试通过；后续需独立挂载/测试容器 |
| 百炼配置 | 用户指定后已定位 `D:/workspace/jusi-team/jusi-meet-suite/deploy/k8s_deploy/meet-secrets.values.yaml` 的 runtimeSecrets.data；包含 API Key 与 Workspace；翻译部署 manifest 指定 cn-beijing | 凭证仅在测试进程内读取，不复制进本仓库；真实调用结果在下表更新 |
| 运行依赖 | 本机 Python 3.13，pytest/websockets 可用；openai/dashscope 未安装 | 可用标准库执行总结 HTTP smoke；ASR SDK 依赖在隔离环境准备，不改全局生产环境 |
| 通知 | 已有纪要优先推送来源会话，否则推送本场已识别用户；文档授予实际参会用户读取 | 新默认策略必须显式迁移，不能直接替换为仅主持人并丢失既有分发 |

初次盘点在常见配置路径未找到凭证；随后按用户提供路径找到 `k8s_deploy` 下配置并完成真实调用。未读取真实会议正文或执行生产数据库查询，因此没有历史总量、孤立材料数量或真实账户配额结论。

拟新增配置：`MEETING_SUMMARY_PROVIDER`、`MEETING_SUMMARY_MODEL=qwen3.8-flash`、`MEETING_SUMMARY_BASE_URL`、`MEETING_SUMMARY_API_KEY`（服务端密钥引用）；翻译继续按已拟定的 `QWEN_TRANSLATION_MODEL`、`DASHSCOPE_REGION`、`DASHSCOPE_WORKSPACE_ID`、`DASHSCOPE_API_KEY`。实施时注册 settings 与部署注入，不仅在文档写变量名。端点必须与地域/凭证匹配，不自动猜生产地域。

## 3. A02：模型与验证记录

总结采用用户已选 `qwen3.8-flash`。实时 ASR 暂定优先候选 `qwen-audio-3.0-asr-flash-streaming`，文件候选 `qwen-audio-3.0-asr-flash-filetrans`；尚未用实测把候选提升为最终默认。官方表列明实时模型无说话人分离，文件模型支持；线上可沿用音轨身份，独立混合麦克风不能因此承诺实时分人。[官方 ASR 能力矩阵](https://help.aliyun.com/zh/model-studio/asr-model)（2026-09-12 核对）。

翻译采用已选 `qwen3.5-livetranslate-flash-realtime`；协议迁入保留 session.finish/finished 的正常收尾。官方说明未发送 finish 会影响尾段结果。[官方客户端事件](https://help.aliyun.com/zh/model-studio/live-translator-client-events)。外部客户端现有测试不覆盖全部多人频道、纯文本输出与 we-meet 权限适配。

| 检查 | 实际执行 | 结果与边界 |
| --- | --- | --- |
| 转写幂等/重试基线 | we-meet/src/agents 下 `python -m pytest tests/test_transcript_writer.py -q -p no:cacheprovider` | 2 passed；mock HTTP，无真实采集/后端写入 |
| 翻译协议基线 | jusi-meet-suite/src/agents 下 `python -m pytest tests/test_qwen_live_translate.py -q -p no:cacheprovider` | 5 passed；mock WebSocket，覆盖握手/错误清理/参数与音频拒绝/空闲重连/语音段断线；无真实模型 |
| Android 设备发现 | `adb devices`、系统 SDK 与包查询 | emulator-5554，API 36，已安装 com.we.meet；没有执行录音、锁屏或来电验收 |
| 合成样本/配置预检 | `python bin/meeting-ai-phase0.py` | 合成段 ID/正文检查通过；默认不调用模型；未上传用户会议 |

### 真实调用结果（用户指定凭证，北京地域）

完整脱敏结果：[meeting-ai-phase0-results.json](meeting-ai-phase0-results.json)。测试音频由 Windows System.Speech 本地合成：中文 Huihui 11.78 秒，英文 Zira 10.775 秒，均为 16kHz/单声道/PCM16；没有录制麦克风、调用会议接口或发送 IM。

| 模型/测试 | 实测结果 | 本次观察值 |
| --- | --- | --- |
| Qwen3.8 短总结 | PASS；取消周五上线，整理测试清单，负责人/日期保持 null；发言中的指令示例未当作安排 | 4.187 秒，输入 246 / 输出 147 tokens |
| Qwen3.8 长总结 | PASS；505 段、107,536 字节 JSON 输入，保留开头审计记录决定与后面的取消上线决定，来源为 s0/s3 | 10.161 秒，输入 26,666 / 输出 197 tokens；这是合成填充，非真实 120 分钟会议 |
| 实时 ASR | PASS；中文 final 文本与合成源句一致，收到 task-finished | 输入 11.78 秒；任务会话 14.407 秒；全过程含建立连接 23.100 秒 |
| 中→英逐句语音 | PASS；有完整英文 final、译音数据和 session.finished | 输出 PCM 533,760 字节；会话 14.207 秒 |
| 英→中逐句语音 | PASS；有中文 final、译音数据和 session.finished | 输出 PCM 372,480 字节；会话 14.367 秒 |
| 中→英连续同传 | PASS；server_vad 自动分为 3 个 response，3 段 final，正常结束 | 输出 PCM 549,120 字节；会话 14.205 秒 |
| 中→英仅文本 | PASS；收到 response.text.text / response.text.done，无译音字节，正常结束 | 会话 13.912 秒；验证纯文本事件与音频文本事件不同 |

上述语音会话时间包含按真实速度发送输入，不是首字/首段译音延迟，也不是 P95。音频字节收到不等于端侧播放/音质已验收；尚未测试多人混音、回声、频道权限和弱网。双向分别调用只验证两个方向，不等于完整自动语言路由产品已接入。

ASR usage 两次出现 duration=11，连续翻译也有多次 usage 事件。本轮按事件保留原始用量，不直接相加当账单；接入时需验证每类 usage 是累计值还是增量，并按任务/response 去重。总结输入/输出用量已记录，本轮不据单段推算整场业务成本。

真实总结 smoke 命令：先在进程环境注入 `MEETING_SUMMARY_BASE_URL` 与 `MEETING_SUMMARY_API_KEY`，运行 `python bin/meeting-ai-phase0.py --live-summary`；也可使用下述已验证的配置读取方式。默认只读固定合成样本，单次有输出预算和超时；控制台不打印密钥、完整端点或模型正文。返回 PASS 仅表示 API/最小结构与引用有效，语义需人工复核，不代表 A02 整体通过。

```powershell
python bin/meeting-ai-phase0.py --secrets-file D:\workspace\jusi-team\jusi-meet-suite\deploy\k8s_deploy\meet-secrets.values.yaml --region cn-beijing --live-summary
```

可选参数：`--long-summary` 构造超过旧截断阈值的合成转写；`--live-asr --audio <已授权短WAV>` 验证实时转写；`--live-translation --target en/zh --translation-mode manual/server_vad` 验证语音模式；`--text-only` 验证纯文本输出。音频限制 30 秒，单次 WebSocket 流程限制 60 秒，不自动重试。`--output` 保存测试正文与结果时，使用明确的测试目录；不要将真实会议原文提交仓库。

### 待运行的业务评测集

| 样本组 | 建议规模 | 重点 |
| --- | --- | --- |
| 中文清晰单人 / 中英混合 / 专业词 | 各至少 3 段，1–5 分钟 | 字错率、术语、数字/日期、字幕 final 延迟 |
| 两人交替 / 重叠发言 / 远场噪声 | 各至少 3 段 | 在线身份映射、线下分人、误识别与静音过滤 |
| 完整会议 | 至少 3 场，覆盖 15/60/120 分钟 | 开头决定与结尾变更、章节覆盖、行动项、长上下文与成本 |
| 翻译 | 中英两个方向至少各 5 段，单人/多人、按键/连续分别跑 | 稳定译文与译音延迟、语义、回录、尾段和语言切换 |
| 无声 / 无任务 / 无结论 / 指令型发言 | 各至少 1 段 | 不伪造决定/负责人，不执行发言中的指令 |

使用获授权的样本并登记参考转写、发言人标注、关键决定/行动项与允许的云端用途。公开测试音频只用于接口连通，不用于代表业务质量。当前未取得业务样本；不从用户飞书截图提取真实会议内容上传模型。

候选验收目标（工程目标，待首轮实测校准，非供应商承诺）：

- 清晰中文 CER ≤10%，领域热词召回 ≥90%；混合语言和重叠发言单列，不混成一个平均数。
- 完整纪要主要决定/行动项的语义支持率 ≥95%；关键决定召回 ≥90%；来源 ID/记录/时间范围结构校验 100%。无明确负责人时不补账户。
- 实时字幕 final 延迟 P95 ≤3 秒；实时总结覆盖滞后 P95 ≤30 秒；结束速记 ≤10 秒；60 分钟会议最终纪要 P95 ≤120 秒。字幕从对应语句结束计时；总结从确认输入水位计时；会后从结束请求计时，同时另记等待尾段耗时。
- 连续同传首段译音端到端延迟 P95 ≤5 秒；停止后新播旧频道音频为 0；重复任务/重复完成通知/跨记录引用为 0。
- 小样本只报告逐项时延和观察值；达到足够调用数量后再评估 P95。费用按每次实际 usage、模型/地域和当前价格归因，不提前宣称单场固定成本。

## 4. A04：Android 与 Web 能力清单

Android 工程已找到：`D:/workspace/jusi-meet/we-meet-android`。Kotlin/Compose，app/core-design/core-directory/feature-assistant/feature-docs/feature-im；通过 composite build 引用同级 `jusi-light-im/sdk/android`。app 配置 minSdk 29、compile/targetSdk 34；README 部分基线可能滞后，以实际配置为准。

| 能力 | 证据 | 判定 |
| --- | --- | --- |
| 麦克风/蓝牙权限 | app manifest 声明 RECORD_AUDIO、BLUETOOTH_CONNECT | 已有声明，不等于已获权限或真实采集通过 |
| 会议后台服务 | ConferenceForegroundService，camera/microphone/mediaPlayback，START_NOT_STICKY | 可复用服务组织方式，但生命周期绑定会议，不能直接承诺独立录音恢复 |
| 独立采集/续传 | 检查的会议/录制入口仍围绕 LiveKit Room | 新增 CaptureSession 与独立端采集需要实现 |
| 构建入口 | README：`gradlew.bat :app:assembleDebug`；SDK 路径和 adb 可用 | 本轮未重建或重装 App，未改变现有会话 |
| 设备 | API 36 模拟器已装 App | 可做基础 UI/权限验证，蓝牙、来电、厂商后台限制仍需真机 |
| 设计规范 | Android docs/page-backgrounds.md、设计规范.md、app-ux-device-matrix.md | 页面开发沿用现有 tokens 与设备矩阵 |
| Web | 已有 TranscriptSidePanel、录制控制与会议详情 | 可复用读取与控制，不能当作独立浏览器 MediaRecorder 已实现 |

已固定页面状态见 [契约第 7 节](meeting-ai-phase0-contract-v1.md#7-页面状态基线)。原生录音涉及的设备行为在阶段 3 实现后逐项验收；本轮不通过打开普通会议来替代缺失的独立录音功能。

## 5. 剩余条件与下一步

1. 已解决百炼凭证与核心模型访问问题。下一步在目标 we-meet 测试环境注册配置并验证调用链，不把本地直连当作应用已接入；文件 ASR 与账号并发额度仍待核实。
2. 提供允许云端测试的音频/转写目录，运行上述业务评测；本轮合成接口验证已足够确认核心连通，不重复调用代替真实业务评测。
3. 在明确的 we-meet 测试数据库上盘点历史场次与孤立材料，单独准备本仓库测试容器；不能使用当前另一个项目的挂载冒充本仓库。
4. 指定 Android/Web/后端的执行责任人；已有本地契约足以作为 B01/B02/B04 的开工输入，但本轮不自动跳过 M0 的模型实测门槛。

结论：核心模型连通与阶段 1 数据设计输入已就绪；阶段 0 剩余工作是业务质量、目标应用环境与终端行为验证。**模型直连成功不代表业务程序已接入或全部阶段 0 验收通过。**
