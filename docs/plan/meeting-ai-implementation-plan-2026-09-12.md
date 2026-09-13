# 会议 AI 分阶段落地计划

日期：2026-09-12
状态：已按用户指令进入阶段 1，首批数据与只读服务基础已实现，详见 [阶段 1 执行记录](meeting-ai-phase1-2026-09-12.md)。阶段 0 的真实业务样本质量与 Android 实机验证仍待完成，详见 [阶段 0 执行记录](meeting-ai-phase0-2026-09-12.md)。产品范围以 [V2 产品规划](meeting-ai-product-plan-v2-2026-09-12.md) 为准；本文件细化其 P0/P1/P1-T/P2/P3，不重新定义功能范围。
目标：交付“线上会议 / 独立 AI 录音 → 会议笔记 → 智能纪要 → 任务跟进与助手通知”，首版同时提供经过验证的语音翻译与同声传译。

## 1. 决策与实施边界

2026-09-13 进度：阶段 1 第六批完成独立采集控制、原文与说话人协议，详见 [第六批执行记录](meeting-ai-phase1-batch6-2026-09-13.md)。当前开关默认关闭，真实音频链路与 M1 整体验收仍待完成。

| 项目 | 当前决策 | 实施处理 |
| --- | --- | --- |
| 总结 | 已选 `qwen3.8-flash` | 实时总结、结束速记、完整纪要共用模型，分阶段提示词与预算 |
| 翻译 | 已选 `qwen3.5-livetranslate-flash-realtime` | 双向语音和连续同传共用协议客户端，分别实现音频调度 |
| 实时 ASR | 建议 `qwen-audio-3.0-asr-flash-streaming`，尚未确定 | 阶段 0 对比样本后形成默认选型；接入采用可替换适配层 |
| 文件 ASR | 建议 `qwen-audio-3.0-asr-flash-filetrans`，尚未确定 | 文件转写与说话人区分先验证，上传产品入口在扩展阶段开放 |
| 资料命名 | 会议笔记 / AI 录音 / 智能纪要 / 纪要助手 | 一个记录体系；助手复用已有 IM 能力 |
| 终端 | Web 与 Android 核心流程需对齐 | 阶段 0 已找到同级 `../we-meet-android`，已有前台服务；独立录音与实机行为仍需验证 |

当前可复用：MeetingSession、录制与转写、纪要服务、人工编辑保护、任务转换/同步、文档与 IM 分发。需新增或改造：独立记录与采集模型、来源权限、流式 ASR 适配、Qwen 总结客户端配置、实时总结水位、录音恢复、翻译频道。

本计划不把模型规格当作实测效果。部署地域、凭证权限、实际并发额度、ASR 默认模型、移动端工程位置在阶段 0 落表；这些信息未齐时，数据契约与页面设计仍可推进，真实调用和对应端上线必须等待条件满足。

## 2. 总体顺序与里程碑

主线：阶段 0 验证与契约 → 阶段 1 数据基础 → 阶段 2 在线会议真实链路 → 阶段 3 独立录音与完整产品 → 阶段 4 联调灰度。阶段 5 为首版后的扩展。

翻译线：阶段 0 验证外部 Agent → 阶段 1 同期迁入协议客户端 → 阶段 2 双向语音 → 阶段 3 连续同传与笔记关联 → 阶段 4 共同验收。

| 阶段 | 对应 V2 | 可评审交付物 | 建议时间盒 |
| --- | --- | --- | --- |
| 0 验证与契约 | P0 准备 | 模型验证记录、端能力清单、数据/API/事件契约、页面状态稿 | 2–3 个工作日 |
| 1 数据与服务基础 | P0 | 统一记录、权限、兼容迁移、分项处理状态与重试框架 | 1–2 周 |
| 2 在线会议与模型链路 | P1 前半 | 一场真实会议的原文、实时总结、速记、完整纪要和可定位引用 | 1–2 周 |
| 3 独立录音与产品闭环 | P1 后半 + P1-T | 首页/笔记/纪要、独立录音、任务、文档、助手和翻译 | 2–3 周 |
| 4 联调与灰度 | P1/P1-T 发布 | 迁移演练、质量报告、端验收、灰度与回退记录 | 1–2 周 |
| 5 资料复用与深化 | P2/P3 | 先上传与协作，后图文增强等独立增量 | P2 另排 2–4 周，P3 单项估算 |

以上是排期建议，不是已承诺工期。假设后端与音频/Agent、Web 前端、Android 能并行工作，QA/产品持续参与，模型账号和部署资源可用；主线首版约 **6–10 周**。原生端工程或音频基础需补建时重新估算；不能以移动网页验收替代 Android 后台录音验收。若只有一名开发者，按下述依赖顺序串行实施，在阶段 0 后重估，不沿用并行工期。

里程碑：M0 契约可实施；M1 数据迁移可演练；M2 在线会议内部可用；M3 线上+独立录音+翻译功能齐备；M4 完整首版发布。M2 是内部增量，不将其包装成已覆盖独立录音的首版。

## 3. 阶段 0：验证选型并冻结契约

| 编号 | 工作 | 主责角色 | 交付与完成条件 |
| --- | --- | --- | --- |
| A01 | 盘点线上配置、历史数据与部署资源 | 后端/运维 | 确认模型地域与权限、队列/存储能力、旧通知规则；记录缺失项，不读取或提交实际密钥到文档 |
| A02 | 用授权样本验证 ASR、总结与翻译 | 音频/Agent、后端、QA | 跑通真实调用；比较中文、中英混合、专业词、重叠发言、长会议；记录效果、时延、失败和 usage，确定 ASR 默认方案 |
| A03 | 冻结统一数据、权限与事件契约 | 后端、前端 | 明确 record/session/capture/segment/version ID、时间轴、partial/final、状态、取消与幂等；前后端可按同一契约开发 |
| A04 | 页面状态与端能力确认 | 产品、Web、Android | 确定首页、录音中、结束速记、笔记、纪要及翻译面板的正常/空/失败状态；验证麦克风、锁屏、来电和后台限制 |

复用评估包含外部 `jusi-meet-suite` 的 Qwen Agent、客户端与依赖链；确认哪些可直接迁移，哪些必须改为 we-meet 的权限与上报逻辑。阶段 0 即验证尾段结束、纯文本翻译事件、单音轨与多人来源差异，不等 UI 完成才发现协议不兼容。

出口：样本集、质量指标定义与候选阈值已登记，核心调用可用，阶段 1 的字段/API/事件与权限表冻结。某个供应商调用受阻只阻塞该接入，不阻塞统一基础实施。

## 4. 阶段 1：统一记录与可靠处理基础

当前增量：首批数据基础已推送；[第二批](meeting-ai-phase1-batch2-2026-09-12.md) 实现 B02/B03 的来源解析、权限边界回归、回填核对及 B05 Web 查询扩展。生产迁移、端页面切换和实际 Worker 尚未验收，M1 保持进行中。

[第三批](meeting-ai-phase1-batch3-2026-09-12.md) 已接入显式生成入口、不可变输入/输出版本及受保护的 Worker；已做数据库并发与模拟供应商测试，尚未完成真实模型/队列联调和线上自动链路切换。M1 仍在进行中。

[第四批](meeting-ai-phase1-batch4-2026-09-13.md) 已补充准确场次的转写送达账本、连续序号确认及 Agent 退出收尾，并把送达状态固定到纪要快照。该状态仅证明已输出文字的送达，整场音频覆盖仍未验证；下一批接入用户鉴权与幂等生成请求。

[第五批](meeting-ai-phase1-batch5-2026-09-13.md) 已实现用户鉴权/幂等生成与重试请求、待投递请求恢复命令，以及 Web 明确场次的进度、版本和引用入口。新写入口默认关闭；真实队列/模型联调、独立采集协议和 Android 对齐仍待实施，M1 继续进行。

| 编号 | 工作 | 主责角色 | 交付与完成条件 |
| --- | --- | --- | --- |
| B01 | 新增 MeetingRecord、CaptureSession、媒体片段映射 | 后端 | online 关联确定场次；audio/upload 不依赖假 Room；一场多次录制归属一份笔记 |
| B02 | 记录权限与来源范围改造 | 后端 | 列表、原文、纪要、问答、媒体、分享按 record/session 授权；参与关系不直接等于读权限 |
| B03 | 兼容回填与旧链接解析 | 后端 | 先可空外键、回填、双写、兼容读取；来源不明材料单列；演练后再决定收紧约束 |
| B04 | 处理任务与版本状态 | 后端/Agent | 转写、实时总结、最终纪要、文档、通知分项状态；重试、取消、错误可辨；旧任务不能覆盖新版本 |
| B05 | 建立共享前端类型与查询层 | Web、Android | 缓存键和深链明确 record/session；服务端错误映射成一致状态；契约可供录音与会后页面复用 |

实现要点：转写段有稳定 ID；媒体片段分别记录时间起点、有效时长和中断区间。任务幂等键建议由记录、操作类型、输入版本及生成版本组成，重试复用；显式重生成创建新版本。最终生成只消费确认原文，输入未收齐时说明覆盖范围。

出口 M1：同房间两场会议不混读；跨租户/无权访问拒绝；同一回调重复执行不重复建记录；迁移数量、来源映射和旧深链核对通过。新增数据仍可在旧应用回退后保存，不安排破坏性删列。

## 5. 阶段 2：先跑通线上会议的真实 AI 链路

2026-09-13：[阶段 2 第九批（累计第十五批）](meeting-ai-phase2-batch9-2026-09-13.md) 已支持记录独立结束后的速记／最终纪要、再次开始的版本隔离及参会采集状态提示；继续翻译协议线和独立录音能力，真实采集与仅文字清理验收仍待部署测试。

2026-09-13：[阶段 2 第八批（累计第十四批）](meeting-ai-phase2-batch8-2026-09-13.md) 已接入 Agent 认领、心跳、真实收尾和会中开始／结束按钮；继续补记录独立结束时的总结时机与参会状态提示。

2026-09-13：[阶段 2 第七批（累计第十三批）](meeting-ai-phase2-batch7-2026-09-13.md) 已实现在线采集控制后端、独占写入认领及送达确认后结束；开关默认关闭，继续接 Agent 执行器和会中控制按钮。

2026-09-13：[阶段 2 第六批（累计第十二批）](meeting-ai-phase2-batch6-2026-09-13.md) 已实现会中笔记阅读、精确 LiveKit 场次解析及新旧自动纪要分流。继续补真实采集控制与收尾。

2026-09-13：[阶段 2 第五批（累计第十一批）](meeting-ai-phase2-batch5-2026-09-13.md) 已实现长会有界分段提炼、复用缓存、引用重绑定和进度；全源保留，不静默截断。继续会中入口与新旧流水线路由。

2026-09-13：[阶段 2 第四批（累计第十批）](meeting-ai-phase2-batch4-2026-09-13.md) 已实现明确开启后的服务端自动三阶段总结、幂等开关、并发/权限/关闭约束与队列恢复；部署和真实音频验收待用户执行。

2026-09-13：[阶段 2 第三批（累计第九批）](meeting-ai-phase2-batch3-2026-09-13.md) 已实现实时/速记/会后阶段版本、水位和显式页面入口；自动更新与长会分段继续下一批。

2026-09-13：[阶段 2 第二批（累计第八批）](meeting-ai-phase2-batch2-2026-09-13.md) 已贯通 ASR 源观察、终态封存、快照与纪要页面；任务收尾与整场音频覆盖分别表达。

2026-09-13：[阶段 2 第一批（累计第七批）](meeting-ai-phase2-batch1-2026-09-13.md) 已实现 Qwen ASR Agent 适配、尾段收齐、原文时间和幂等身份；新配置仍需部署及真实音频测试。阶段 1 的部署验收并未自动完成。

| 编号 | 工作 | 主责角色 | 交付与完成条件 |
| --- | --- | --- | --- |
| C01 | 接入阶段 0 确定的实时 ASR | 音频/Agent | 适配现有 provider 工厂；统一 final 落库、时间戳与在线身份；重连不重复原文 |
| C02 | Qwen3.8 总结客户端与生成结构 | 后端 | 会议总结独立配置 provider/model/base_url/凭证；结构化 schema 校验与来源校验；其他 LLM 调用按原配置运行 |
| C03 | 实时→速记→完整纪要 | 后端/Agent | 增量水位、尾段收齐、分段/全量 token 预算；移除现有最后 60,000 字节截断；三阶段共用记录和版本 |
| C04 | 会中控制与基础阅读 | Web、Android | 云录制与智能纪要独立控制；文字/实时总结可读；引用可定位原文，有媒体时联动播放 |
| C05 | 仅文字保存链路 | 后端/Agent、端开发 | 临时片段、缓存和失败重试完成清理；关闭记录有真实状态；通过验证后才展示该模式 |

首期先保留已有原文通道作为迁移回退选项，但每个采集会话只能有一个正式原文写入者；候选 ASR 对比结果单独存放。翻译模型自带源 ASR 不作为第二套正式转写重复落库。

实时总结不逐字触发调用；根据稳定文本量和时间间隔合并更新。最终总结根据已收齐材料重新核对全场，包含开头决定、后续变更和未决问题。原文不足、模型失败、行动项为空是不同结果，不能统一存成成功空列表。

出口 M2：真实线上会议能从采集到完整纪要，原文和引用一致，长会开头/结尾均覆盖；结束录制不结束会议；结束速记的覆盖范围明确；失败可按步骤重试且不重复花费在已完成的后续动作上。通过内部验收后可小范围验证，不视作完整首版发布。

## 6. 阶段 3：独立录音、资料工作区与跟进闭环

| 编号 | 工作 | 主责角色 | 交付与完成条件 |
| --- | --- | --- | --- |
| D01 | 独立 AI 录音采集与恢复 | Web、Android、后端/Agent | 无会议号即可开始、暂停、继续、结束；退出重入恢复同一记录；有限本地缓冲、分片续传与去重 |
| D02 | 首页和资料库 | Web、Android | 首页/会议笔记/智能纪要三入口；进行中置顶；来源与权限筛选；同笔记与纪要不重复建历史条目 |
| D03 | 笔记工作区与结束页 | Web、Android | 文字/纪要、发言人与信息；速记更新完整版；播放器按实际资产和权限显示；跨暂停定位正确 |
| D04 | 纪要版本和任务转换 | 后端、前端 | 人工编辑保留；负责人/时间可留空并核对；确认后复用任务服务，重试不重复创建 |
| D05 | 独立文档与纪要助手 | 后端、前端 | 文档分享权限独立；人工内容不被自动覆盖；按记录/版本/接收者去重通知；分享前可审阅范围 |
| D06 | 本次记录问答 | 后端、前端 | 在线与独立录音都按授权 record 检索；答案带引用；无权限/无依据时不泄露或编造 |

录音时若会后说话人区分尚不可用，只展示真实可获得的说话人标签，不把语言或猜测姓名当作成员身份；阶段 0 确定的必要文件转写适配可以先在录音内部使用，不必等上传入口开放。

平台要求：Web 在验证过的生命周期内支持录音，页面离开和设备异常给出真实状态；Android 单独验证前台服务、锁屏、来电、蓝牙、后台恢复。若原生端条件缺失，可单独发布已验收 Web 端，但总体 Android 对齐里程碑保持未完成并明确标注。

出口 M3：线上会议与独立录音都走完“开始→暂停/停止→速记→笔记/纪要→确认行动项→任务→通知”；所有入口可找回同一记录。没有强制人工核对才能阅读的阻塞，任务创建仍须用户确认。

## 7. 翻译并行线：随首版交付

详细协议见 [Qwen 翻译接入方案](meeting-ai-translation-qwen-2026-09-12.md)。这条线需要独立音频开发容量；没有并行人力时会延长主线时间。

| 编号/顺序 | 接入内容 | 依赖 | 验收门槛 |
| --- | --- | --- | --- |
| T01 协议迁入 | 客户端及必要依赖、VAD/Manual 参数化、纯文本事件、语言能力表、内部上报 | A02/A03；可与阶段 1 并行 | 使用本项目鉴权配置，文本-only 目标正常返回，尾段 finish 能完成 |
| T02 双向语音 | 指定来源音轨、A/B 双会话、按键与自动路由、原文/译文/译音 | T01、B02/B04 | 先验证中英；逐句完成、暂停播报、断线、方向切换与费用归属正确 |
| T03 连续同传 | 连续输入、多发言人、目标语言频道、个人订阅、原声混音 | T02、线上采集契约 | 多人/多频道不串音、不回录；退出个人收听不停止别人；权限在服务端控制 |
| T04 关联与收尾 | 翻译面板、final 译文关联笔记、独立录音适配、使用量和失败恢复 | T03、D01/D03 | 切换不播旧队列、关闭不丢尾段、原文不重复落库，翻译失败不影响原始录音 |

可在阶段 2 展示双向翻译内部增量；阶段 3 完成连续同传，阶段 4 一起灰度。只开放实际验证过且具备所需输出模态的语种；不因模型支持清单就一次性开放所有语种。视觉增强和译音文件留存不作为首版交付条件。

## 8. 阶段 4：验收、灰度与回退

质量工作贯穿各阶段，本阶段集中做跨模块和发布验证。

| 类别 | 必测场景 | 发布门槛 |
| --- | --- | --- |
| 数据与权限 | 同房间两场、跨租户、独立录音私有、仅纪要分享、下载/搜索/问答/通知权限 | 样本中无跨来源混读和越权；迁移差异全部解释 |
| 保存与恢复 | 麦克风拒绝、断网/重连、进程重启、重复回调、容量不足、尾段超时 | 无静默丢录音；有缺失时明确范围；可恢复或明确终止 |
| 模型质量 | 长会前后冲突、专业词、多语言、多人、无行动项、模糊负责人/日期 | 达到阶段 0 建立并经评测确认的质量阈值；不把缺省值伪装成识别结果 |
| 幂等与版本 | 多次重生成、人工编辑、任务重复提交、文档失败、通知失败后重试 | 不覆盖人工内容，不重复任务，不产生重复完成通知 |
| 翻译 | 两种模式、多个语言频道、重叠发言、切换/停止、译音回灌 | 权限/来源/停止语义通过；端到端 P50/P95 达到已登记目标 |
| 终端与负载 | Web 支持浏览器、Android 实机、并发会议/频道、队列积压、限流 | 达到登记的设备矩阵与目标并发；资源释放、延迟和成本可观测 |

沿用并扩展现有后端录制权限、场次材料、纪要编辑/章节/文档/IM、任务同步测试，以及 Agent 转写测试；增加真实音频集成验证和关键端到端流程。模拟模型响应验证边界，真实样本验证质量，二者不能互相替代。

灰度顺序：测试环境迁移演练 → 内部测试租户 → 选定租户 → 扩大范围。每批观察完整的录音、生成、通知与恢复周期；进入下一批需保存率、时延、错误、权限、成本数据可解释，无未解决的阻塞缺陷。

建议开关按租户与能力拆分：统一记录读取、Qwen 总结、新 ASR、独立录音、语音翻译、同传频道、仅文字模式。开关与 provider 选择固定到活动会话/生成任务，避免中途切换产生混合来源。停止新增会话不强行终止进行中的录音；正常收齐尾段后释放资源。

回退：保留兼容读取和旧模型配置；经运维显式切换新任务，正在执行任务完成或被明确取消。新建笔记与版本仍能读取，保留已生成资料；通知重试复用原事件键。首版灰度期间不执行删列或不可逆清理迁移。

出口 M4：验收报告、迁移演练结果、功能开关清单、告警/排障和回退操作可审阅；Web 与 Android 分别标记结果，全部首版承诺满足才宣布完整交付。

## 9. 阶段 5：首版后的扩展

P2 按以下顺序增量交付，每项独立验收：

1. 上传音视频：格式/大小/时长校验、续传、转码、文件 ASR、说话人区分，复用 record 与生成流水线。
2. 材料校正与检索：说话人合并/拆分、原文版本、全文定位、历史纯文字翻译、授权检索。
3. 协作与导出：评论/@、文本/字幕/媒体导出、独立文档更新差异与人工采纳；扩权明确可见。

P3 分别立项：图文摘要/主题图、翻译视觉输入、音视频裁剪、跨记录增强、会前议程和硬件同步。按实际使用数据与需求确定顺序，不追加到首版发布门槛。

## 10. 开工顺序与任务管理

2026-09-13：[阶段 3 第十三批（累计第三十三批）](meeting-ai-phase3-batch13-2026-09-13.md) 接通录音页纪要、修订、问答与引用回听，修复逐字稿分页契约及早期中文问号文案；继续统一资料库与跨浏览器记录入口。

2026-09-13：[阶段 3 第十二批（累计第三十二批）](meeting-ai-phase3-batch12-2026-09-13.md) 将已发布独立逐字稿接入 Qwen 纪要来源快照、权限和精确引用；继续录音页纪要入口。

2026-09-13：[阶段 3 第十一批（累计第三十一批）](meeting-ai-phase3-batch11-2026-09-13.md) 接入 Web 转写／取消／重试、固定版本逐字稿分页和文字回听；继续独立录音纪要来源适配。

2026-09-13：[阶段 3 第十批（累计第三十批）](meeting-ai-phase3-batch10-2026-09-13.md) 连接独立 Qwen 转写 Worker、逐片校验和尾句送达；继续 Web 转写控制与原文展示。

2026-09-13：[阶段 3 第九批（累计第二十九批）](meeting-ai-phase3-batch9-2026-09-13.md) 完成独立 ASR 单次执行、封存输入、版本发布与失败保留协议；继续连接独立 Worker 和 Web 转写入口。

2026-09-13：[阶段 3 第八批（累计第二十八批）](meeting-ai-phase3-batch8-2026-09-13.md) 完成受保护逐片回放、哈希校验、定位／倍速及缺片暂停；继续独立转写和资料版本链路。

2026-09-13：[阶段 3 第七批（累计第二十七批）](meeting-ai-phase3-batch7-2026-09-13.md) 连接 Web 录音入口、麦克风生命周期、逐片上传、回执恢复、缺片结束和本机下载；继续回放与独立 ASR。

2026-09-13：[阶段 3 第六批（累计第二十六批）](meeting-ai-phase3-batch6-2026-09-13.md) 新增浏览器 PCM 采集层、账号隔离的 IndexedDB 日志、回执释放及跨标签排他，原生 Chromium 合成音源检查通过；继续连接用户入口与上传恢复。

2026-09-13：[阶段 3 第五批（累计第二十五批）](meeting-ai-phase3-batch5-2026-09-13.md) 新增真实 WAV 私有分片保存、校验回执、缺片封存与受保护下载；继续浏览器采集、恢复与 ASR 连接。

2026-09-13：[阶段 3 第四批（累计第二十四批）](meeting-ai-phase3-batch4-2026-09-13.md) 实现基于所选原文快照的 Qwen 记录级问答、准确引用校验、私人请求恢复和单次执行。长输入与语义质量仍需评测，独立录音／资料工作区继续推进。

2026-09-13：累计第二十三批完成一次[阶段性技术评审及修复](meeting-ai-technical-review-2026-09-13.md)：在线采集停止截止时间、旧会中问答跨场次／权限边界、前端旧流清理。当前测试范围与配置见[部署说明](meeting-ai-deployment-handoff-2026-09-13.md)。完整计划仍在进行，待 Docs 上游契约补齐并继续记录问答等独立工作。

2026-09-13：[阶段 3 第三批（累计第二十二批）](meeting-ai-phase3-batch3-2026-09-13.md) 补齐人工修订历史分页和按原快照回溯；继续交付链路与技术走查，文档远程创建的幂等契约列为待解决依赖。

2026-09-13：[阶段 3 第二批（累计第二十一批）](meeting-ai-phase3-batch2-2026-09-13.md) 接入人工确认行动项转任务、跨版本相同文字去重、删除回执及现有任务状态回显。继续会后资料交付与历史版本能力，部署实测由用户执行。

2026-09-13：[阶段 3 第一批（累计第二十批）](meeting-ai-phase3-batch1-2026-09-13.md) 实现人工纪要修订与 Web 编辑入口，AI 重生成和人工版本分别保留；继续接入确认行动项与任务转换。M3 整体验收未完成。

用户已于 2026-09-13 明确授权：每批开发和必要检查完成后自动提交、推送；无阻塞继续下一批或下一阶段；开发完成后进行技术评审、代码走查并修复问题。用户负责部署和实测，持续反馈问题；开发侧不自行生产部署或把未实测项目标成通过。此约定延续到后续批次，不重复请求提交/推送许可。

首批直接进入 A01–A04；契约确认后开始 B01/B02/B04，B03 依赖数据模型，B05 与后端接口并行。T01 可独立推进；C02 可在 MeetingSession 适配层上提前验证，但正式落库必须遵守 B04 版本契约。

建议以表内编号建立实施任务，每项记录主责人、依赖、改动范围、验收证据和当前状态。角色名称在开工时落实到人员；所有条目初始为“待开始”，文档创建或页面占位不能计为功能完成。

优先代码落点：

- 数据/权限：`src/backend/core/models.py`、`src/backend/core/api/viewsets.py` 及对应迁移、服务与录制权限测试。
- ASR/翻译：`src/agents/multi_user_transcriber.py`、Agent plugins、转写写入及会话上报；外部 Qwen Agent 只作为复用来源。
- 生成：`src/backend/core/services/llm_client.py`、`meeting_summary.py`；沿用 `task_action_item_sync.py` 与现有文档/IM 服务。
- Web：`src/frontend/src/features/meetings/`、`features/recording/components/TranscriptSidePanel.tsx`，新增独立录音与笔记工作区并共用查询层。
- Android：`../we-meet-android`，构建入口 `gradlew.bat :app:assembleDebug`；阶段 0 已发现 API 36 模拟器，负责人和真机矩阵仍需落实。

本文件为实施计划；实际进度和验证结果以阶段执行记录为准。阶段 1 迁移仅在本地隔离测试数据库执行，尚未生产发布。


Latest implementation: [Batch 34: unified library queries](meeting-ai-phase3-batch14-2026-09-13.md). D02/D03 Web workspace integration follows; overall M3 remains incomplete.


[Batch 35: Web library and record workspace](meeting-ai-phase3-batch15-2026-09-13.md) connects D02 and standalone D03 cloud discovery. Full M3 and final review remain pending.


[Batch 36: full transcript search](meeting-ai-phase3-batch16-2026-09-13.md) adds search and revision fences. Docs source located at `../we-meet-docs`; D05 dependency implementation can proceed.


[Batch 37: Docs idempotency upstream](meeting-ai-phase3-batch17-2026-09-13.md), Docs `docs-dev` commit `c4a3089a`, migration 0037. Meet delivery integration follows.


[Batch 38: strict Docs client](meeting-ai-phase3-batch18-2026-09-13.md) uses a dedicated idempotent route; Docs `bf2a0636` fixes mixed-version replica safety. Durable delivery workflows follow.

- Batch 39: immutable export preview and durable intent; core migration 0166, 9 tests passed. Keep MEETING_SUMMARY_EXPORT_ENABLED off pending delivery worker and UI. See [batch 39](meeting-ai-phase3-batch19-2026-09-13.md).

- Batch 40: fenced asynchronous Docs delivery and read-only reconciliation; 24 delivery tests plus 37 preview/client regressions passed. Celery worker + beat required; export UI follows. See [batch 40](meeting-ai-phase3-batch20-2026-09-13.md).

- Batch 41: document export UI for AI/current/history revisions; 26 frontend and 10 backend tests passed, native Chromium desktop/mobile recovery verified, production build passed. Deploy Docs + migrations + worker/beat before enabling export for integration testing. See [batch 41](meeting-ai-phase3-batch21-2026-09-13.md).

- Batch 42: IM sibling now provides durable admin message receipts and migration 011; deploy it before the future minutes-assistant integration. Six database scenarios, three API scenarios and existing admin tests passed. See [batch 42](meeting-ai-phase3-batch22-2026-09-13.md).

- Batch 43: strict signed IM delivery client, 32 tests passed. Requires IM 99c90e3 and migration 011; notification orchestration follows. See [batch 43](meeting-ai-phase3-batch23-2026-09-13.md).

- Batch 44: atomic final-summary completion events, frozen recipients, private notification ledger/API; migration 0167. 12 notification + 16 version + 9 capture summary checks passed. Keep MEETING_SUMMARY_NOTIFICATIONS_ENABLED off pending worker and UI. See [batch 44](meeting-ai-phase3-batch24-2026-09-13.md).

- Batch 45: [private notification delivery and recovery](meeting-ai-phase3-batch25-2026-09-13.md). 35 tests passed; migration 0168 required. IM 99c90e3 + schema 011, Celery worker/beat required. Notification flag remains off pending Web status/retry and version deep links. No real messages sent.

- Batch 46: [notification UI and exact-version links](meeting-ai-phase3-batch26-2026-09-13.md). 27 frontend + 6 backend tests, native Chromium desktop/mobile and production build passed. Notification stack is ready for deployment validation; flag stays off by default. Record sharing is next.

- Batch 47: [summary-only sharing preview and grants](meeting-ai-phase3-batch27-2026-09-13.md). 13 tests passed; migration 0169 required. MEETING_SUMMARY_SHARING_ENABLED defaults off. Explicit record-summary grants do not send messages or grant originals/media/Docs access. Web confirmation is next.

- Batch 48: [summary sharing and revocation UI](meeting-ai-phase3-batch28-2026-09-13.md). 7 new UI tests + 20 summary/notice regressions passed; native Chromium desktop/mobile and production build passed. Migration 0169 and sharing flag required. No real grants or messages. M3/M4 remain incomplete.

- Batch 49: [shared interpretation channels and listener leases](meeting-ai-phase3-batch29-2026-09-13.md). 13 tests passed; migration 0170 required. MEETING_INTERPRETATION_ENABLED remains off and worker name empty. No dispatch/audio in this batch; worker lifecycle is next.

- Batch 50: [shared interpretation worker lifecycle](meeting-ai-phase3-batch30-2026-09-13.md). 15 worker + 13 channel tests passed; migration 0171 required. Start/worker/stop deadlines and current recipient grants enforced. Dedicated audio Agent and Web listening remain next; interpretation flag stays off.

- Batch 51: [shared interpretation Agent grants](meeting-ai-phase3-batch31-2026-09-13.md). 11 new control/lease tests + 12 private translation regressions passed. Dedicated multi-source audio runtime is next; channel flag remains off. No model calls.

- Batch 52: [shared interpretation audio Agent](meeting-ai-phase3-batch32-2026-09-13.md). 53 Agent tests passed. Dedicated qwen_interpretation_agent.py start workload required; Web listening follows and channel flag stays off. No real model calls.

- Batch 53: [shared interpretation Web protocol](meeting-ai-phase3-batch33-2026-09-13.md). Subscription identity and conservative remaining leases; 5 frontend and 28 backend tests passed. Web lifecycle/UI follows; channel flag stays off.

- Batch 54: [meeting interpretation Web listening](meeting-ai-phase3-batch34-2026-09-13.md). 31 frontend and 54 Agent tests, native Chromium desktop/mobile, production build passed. Dedicated Agent + migrations 0170/0171 + worker/beat required. Channel stack ready for deployment validation; flag remains off by default. Full M3/M4 and final review remain pending.

- Batch 55: [confirmed translation archives](meeting-ai-phase3-batch35-2026-09-13.md). Migration 0172, 20 new and 28 regression tests passed. MEETING_TRANSLATION_ARCHIVE_ENABLED defaults off; Agent delivery and Web retention controls/reader follow. Originals and their revisions are unchanged.


Batch 56: shared confirmed-translation delivery and opt-in archive reader completed. See [phase 3 batch 36](meeting-ai-phase3-batch36-2026-09-13.md). Agent/backend/frontend tests and browser/build checks passed; private and independent recording translation remain pending.


Batch 57: owner-only private translation archive backend and direction-scoped receipts completed. See [phase 3 batch 37](meeting-ai-phase3-batch37-2026-09-13.md). 55 backend tests passed; no migration. Disabling private translation now stops existing workers on heartbeat. Agent/Web integration follows.


Batch 58: private translation Agent delivery, Web opt-in, bidirectional archive reader and unknown-usage handling completed. See [phase 3 batch 38](meeting-ai-phase3-batch38-2026-09-13.md). Agent 68, frontend 19 and backend 19 tests passed, with browser/build checks. Independent recording and final review remain pending.


Batch 59: independent live-ASR backend, append-only input offers and owner-only confirmed-text preview completed. See [phase 3 batch 39](meeting-ai-phase3-batch39-2026-09-13.md). 43 focused/regression tests passed; migration 0173 applied only in isolated databases. Live flag defaults off; Agent/Web follow.


Batch 60: independent live-ASR Worker completed; run python capture_live_transcriber.py separately from sealed ASR. See [phase 3 batch 40](meeting-ai-phase3-batch40-2026-09-13.md). 34 Agent and 29 backend tests passed. No migration; Web integration follows.

- Batch 61: [independent live transcription Web controls and confirmed preview](meeting-ai-phase3-batch41-2026-09-13.md). Explicit opt-in; 16 component tests and isolated browser regressions passed. No new migration.

- Batch 62: [independent realtime, quick and final summary backend](meeting-ai-phase3-batch42-2026-09-13.md). New opt-in MEETING_CAPTURE_STAGED_SUMMARY_ENABLED; existing explicit automation consent required. No migration; isolated regressions passed.

- Batch 63: [live summary Web controls and end-of-recording transition](meeting-ai-phase3-batch43-2026-09-13.md). Explicit consent, exact draft citations and in-progress ASR status; 29 Web/26 backend tests plus isolated browser flows passed. No migration.

- Batch 64: [Android canonical record, staged summary and citation API](meeting-ai-phase3-batch44-2026-09-13.md). Implemented in we-meet-android/main; 12 JVM tests, Debug build and design guard passed. Native screens and capture lifecycle continue next.


- Batch 65: [Android record library and staged-summary screens](meeting-ai-phase3-batch45-2026-09-13.md). Default-off WE_MEET_RECORDS_NATIVE; Debug builds, 12 JVM tests, design guard and 5 isolated emulator UI tests passed. Native originals, notification links and capture lifecycle continue next.


- Batch 66: [Android full-original search and speaker filters](meeting-ai-phase3-batch46-2026-09-13.md). Revision-fenced reads and exact online session validation; 16 JVM and 6 isolated emulator UI tests passed. No migration. Native exact-version links and capture lifecycle follow.


- Batch 67: [Android exact-version notification links](meeting-ai-phase3-batch47-2026-09-13.md). Strict configured-origin parsing and explicit all-version navigation; 21 JVM and 7 isolated UI tests passed. Native flag also gates the App Link alias. Actual domain/login integration remains for deployment testing.


- Batch 68: [private translation audio mount authorization](meeting-ai-phase3-batch48-2026-09-13.md). Exact ready track/participant/run/generation checks, bounded status freshness and late-unlock fencing; 35 frontend regressions, TypeScript, ESLint and production build passed. No migration or provider calls. Native capture and final review remain pending.


- Batch 69: [Android independent capture and WAV protocol](meeting-ai-phase3-batch49-2026-09-13.md). Fixed operation keys, device leases and strict audio receipts; 25 JVM tests, Debug build and design guard passed. No real microphone or network operations. Durable native buffering and foreground capture follow.

- Batch 70: Android encrypted capture journal; 8 isolated Keystore/SQLite tests passed. See [batch 50](meeting-ai-phase3-batch50-2026-09-13.md). Capture service/UI and final review remain pending.

- Batch 71: Android durable capture recovery coordinator; 17 isolated tests passed. See [batch 51](meeting-ai-phase3-batch51-2026-09-13.md). Foreground acquisition/UI and final review remain pending.

- Batch 72: Android PCM acquisition adapter and bounded pump; 17 JVM tests passed. See [batch 52](meeting-ai-phase3-batch52-2026-09-13.md). Foreground service/UI and physical-device validation remain pending.

- Batch 73: Android microphone foreground service; 4 service lifecycle + 17 recovery/storage tests passed with synthetic PCM only. WE_MEET_CAPTURE_NATIVE defaults false. See [batch 53](meeting-ai-phase3-batch53-2026-09-13.md). UI and physical-device validation remain pending.

- Batch 74: Android recording UI and account-bound notification return; 6 UI/service tests + 7 record UI regressions passed. Synthetic PCM only. See [batch 54](meeting-ai-phase3-batch54-2026-09-13.md). Native ASR/summary/playback/actions and physical-device validation remain pending.

- Batch 75: Android ASR protocol + encrypted durable paid intents; 7 JVM and 4 instrumented tests passed. See [batch 55](meeting-ai-phase3-batch55-2026-09-13.md). Native ASR controls/preview follow; no real model calls.

- Batch 76: Android explicit ASR controls, durable unknown-request recovery and live confirmed-text preview; 17 isolated UI tests passed. See [batch 56](meeting-ai-phase3-batch56-2026-09-13.md). Native summary controls follow; no real model calls.

- Batch 77: Android staged-summary and automation protocol with durable paid intents; 14 JVM and 8 isolated instrumentation tests passed. See [batch 57](meeting-ai-phase3-batch57-2026-09-13.md). Native controls follow; no real model calls.

- Batch 78: Android staged-summary/automation controls and exact quick-version citations; 19 isolated UI tests passed. See [batch 58](meeting-ai-phase3-batch58-2026-09-13.md). Native playback/actions and cross-client consistency follow.

- Batch 79: Web summary and automation intents now survive same-tab reload, fail closed on storage errors and retain uncertain HTTP 408 outcomes. 23 tests, TypeScript, ESLint and production build passed. See [batch 59](meeting-ai-phase3-batch59-2026-09-13.md). Native playback follows.

- Batch 80: Android sealed-audio playlist and bounded authenticated WAV download; 16 JVM tests, Debug build and token checks passed. See [batch 60](meeting-ai-phase3-batch60-2026-09-13.md). Native playback lifecycle/UI follows.

- Batch 81: Android bounded playback engine and AudioTrack focus handling; 15 JVM and 2 isolated silent-audio SDK tests passed. See [batch 61](meeting-ai-phase3-batch61-2026-09-13.md). Native player UI/lifecycle follows.

- Batch 82: Android player/source seeking, lifecycle and recording exclusion; 30 isolated tests plus default Debug/token and light/dark checks passed. See [batch 62](meeting-ai-phase3-batch62-2026-09-13.md). Web receipt validation and remaining first-release work follow.

- Batch 83: Web summary/automation write receipts validate before resolving durable intents; malformed 2xx remains unknown. 44 tests, TypeScript, ESLint and production build passed. See [batch 63](meeting-ai-phase3-batch63-2026-09-13.md). Native reviewed actions follow.

- Batch 84: Android human-review/history and explicit task-conversion protocols with encrypted recovery; 15 JVM + 8 isolated instrumentation tests and Debug/token checks passed. See [batch 64](meeting-ai-phase3-batch64-2026-09-13.md). Native editing/confirmation UI follows.

- Batch 85: Android human-summary editing/history and exact citations; 20 isolated UI regressions, Debug/token and light/dark checks passed. See [batch 65](meeting-ai-phase3-batch65-2026-09-13.md). Task confirmation/navigation follows.

- Batch 86: Android reviewed-action confirmation, explicit assignees/dates and native task navigation; 19 isolated UI regressions, default Debug/token and light/dark checks passed. See [batch 66](meeting-ai-phase3-batch66-2026-09-13.md). Native Q&A/delivery follows.

- Batch 87: Android private Q&A protocol with exact snapshot/receipt checks and encrypted recovery; 16 JVM + 8 isolated instrumentation tests and Debug/token checks passed. See [batch 67](meeting-ai-phase3-batch67-2026-09-13.md). Q&A UI follows.

- Batch 88: Android private Q&A workspace, explicit original selection and exact answer/citations; 13 isolated UI regressions, Debug/token and light/dark checks passed. See [batch 68](meeting-ai-phase3-batch68-2026-09-13.md). Native delivery/notification work follows.

- Batch 89: Android document delivery and private notification protocols with validated receipts and durable recovery; 17 JVM + 8 isolated tests and Debug/token checks passed. See [batch 69](meeting-ai-phase3-batch69-2026-09-13.md). Native delivery UI follows.

- Batch 90: Android private assistant delivery status, exact minutes links and explicit retry confirmation; 16 isolated tests, Debug/token and light/dark checks passed. See [batch 70](meeting-ai-phase3-batch70-2026-09-13.md). Document export UI follows.

- Batch 91: Android reviewed document copies, frozen retries and native Docs navigation; 18 UI regressions, Debug/token and light/dark checks passed. See [batch 71](meeting-ai-phase3-batch71-2026-09-13.md). Native summary sharing follows.

- Batch 92: Android scoped summary-sharing preview/confirmation and durable recovery; 17 JVM + 7 isolated tests and Debug/token checks passed. See [batch 72](meeting-ai-phase3-batch72-2026-09-13.md). Native sharing UI follows.

- Batch 93: Android explicit summary sharing/revocation workspace, scoped selection and effective-access previews; 13 isolated UI tests, Debug/token and light/dark checks passed. See [batch 73](meeting-ai-phase3-batch73-2026-09-13.md). Native online capture/translation alignment and first-release gaps follow.

- Batch 94: Android exact-occurrence online capture controls and join-token-only notices with durable recovery; 16 JVM + 7 isolated tests and Debug/token checks passed. See [batch 74](meeting-ai-phase3-batch74-2026-09-13.md). In-meeting UI follows.

- Batch 95: Android exact-occurrence in-meeting controls and independent participant notices; 17 isolated tests, enabled/default Debug builds, token and light/dark checks passed. New WE_MEET_ONLINE_AI_NATIVE defaults off. See [batch 75](meeting-ai-phase3-batch75-2026-09-13.md). Native translation and remaining first-release gaps follow.

- Batch 96: Android private translation protocol and encrypted source/consent-preserving recovery; 15 JVM + 11 isolated tests and Debug/token checks passed. See [batch 76](meeting-ai-phase3-batch76-2026-09-13.md). Native event/audio lifecycle and controls follow.

- Batch 97: Android translation event validation and exact, expiring track subscriptions; 16 JVM tests, enabled/default Debug and token checks passed. See [batch 77](meeting-ai-phase3-batch77-2026-09-13.md). Native translation workspace follows; real call/device timing remains deployment testing.

- Batch 98: Android connection-bound translation state, explicit sound consent and ordered manual speech; 24 JVM regressions and Debug/token checks passed. See [batch 78](meeting-ai-phase3-batch78-2026-09-13.md). Native workspace and SDK transport follow.

- Batch 99: Android personal voice-translation workspace, explicit sound/retention, manual turns and lifecycle recovery; 20 isolated regressions, enabled/default Debug, token and light/dark checks passed. See [batch 79](meeting-ai-phase3-batch79-2026-09-13.md). Shared interpretation follows; native archive browsing and device timing remain pending.

- Batch 100: Android shared-channel/listener/renewal protocols with separate durable intents; 17 JVM + 12 isolated tests and Debug/token checks passed. See [batch 80](meeting-ai-phase3-batch80-2026-09-13.md). Shared event/audio lifecycle and native channel UI follow.

- Batch 101: Android shared interpretation events and explicit, expiring listening state; 25 JVM regressions and Debug/token checks passed. See [batch 81](meeting-ai-phase3-batch81-2026-09-13.md). Shared native SDK transport and channel/listener UI follow.

- Batch 102: Android shared interpretation channel/listener workspace with foreground leases and durable recovery; 23 isolated tests, enabled/default Debug, token and light/dark checks passed. See [batch 82](meeting-ai-phase3-batch82-2026-09-13.md). Native retained-translation browsing follows.

- Batch 103: Android retained translation list/detail with exact archive pagination and original-material ACLs; 8 JVM + 12 isolated UI tests, Debug/token and light/dark checks passed. See [batch 83](meeting-ai-phase3-batch83-2026-09-13.md). Native write-intent recovery alignment follows.

- Batch 104: Android ASR/summary/automation/review/task/question intents retain their original key/body through access loss; 21 isolated + 7 JVM tests, Debug and token checks passed. See [batch 84](meeting-ai-phase3-batch84-2026-09-13.md). Web online-capture recovery follows.

- Batch 105: Web online-capture controls persist exact occurrence-bound intent and validate frozen receipts; 31 tests, TypeScript, ESLint and production build passed. See [batch 85](meeting-ai-phase3-batch85-2026-09-13.md). Text-only retention foundations and remaining first-release work follow.

- Batch 106: durable text-only audio cleanup foundation with upload/ASR fencing and verified deletion; 43 unique backend tests and migration/lint checks passed. Migration 0174 and a separate cleanup worker/beat task required. See [batch 86](meeting-ai-phase3-batch86-2026-09-13.md). Failed-ASR expiry and client retention flows remain pending; text-only upload stays disabled.

- Batch 107: text-only audio hard expiry, bounded ASR retry window and public cleanup status; 108 backend regressions and lint/diff checks passed. See [batch 87](meeting-ai-phase3-batch87-2026-09-13.md). No new migration; storage admission and client retention flows follow.

- Batch 108: opt-in text-only WAV/live-ASR admission with authenticated storage compatibility checks; 122 unique backend regressions and lint/diff checks passed. See [batch 88](meeting-ai-phase3-batch88-2026-09-13.md). New MEETING_CAPTURE_TEXT_ONLY_ENABLED defaults off; Web/native retention flows follow.

- Batch 109: Web text-only audio memory queue and fail-closed retention metadata, with nine real-browser storage invariants and 21 unit regressions verified. See [batch 89](meeting-ai-phase3-batch89-2026-09-13.md). Recording selector, consent and controller lifecycle follow.

- Batch 110: Web text-only recording consent, admission, expiry shutdown and cleanup status; 50 unit regressions, text/media browser UI flows, TypeScript/lint and production build passed. See [batch 90](meeting-ai-phase3-batch90-2026-09-13.md). Android retention and remaining first-release work follow.

- Batch 111: Android text-audio admission and retention protocol (fb3c7028); 26 JVM and 9 isolated capture-recovery tests, Debug/test and token checks passed. See [batch 91](meeting-ai-phase3-batch91-2026-09-13.md). Native cache/lifecycle and UI follow.

- Batch 112: Android memory-only text audio and durable explicit incomplete recovery (4ca9d4bf); 24 isolated device and 19 JVM tests, Debug/test and token checks passed. See [batch 92](meeting-ai-phase3-batch92-2026-09-13.md). Native service/consent/status UI follows.

- Batch 113: Android text-only recording consent, service expiry shutdown, explicit incomplete finish and verified cleanup UI; Android `77103709`, 21 isolated device scenarios, default builds and visual checks pass. Continue native cloud recording and standalone translation. See [batch 113](meeting-ai-phase3-batch93-2026-09-13.md). M3/M4 remain incomplete.

- Batch 114: exact-session, manager-only cloud-video discovery and separate rollout flag; 14 new + 10 online-capture tests pass. Read-only foundation; durable controls and native UI follow. See [batch 114](meeting-ai-phase3-batch94-2026-09-13.md). M3/M4 remain incomplete.

- Batch 115: durable cloud-video start/stop reservations, immutable original receipts, stale-state fencing and concurrent-start tests; migration 0175. 27 cloud scenarios pass; worker execution/reconciliation and native UI follow. Keep rollout off. See [batch 115](meeting-ai-phase3-batch95-2026-09-13.md).

- Batch 116: bounded exact-source LiveKit video transport and original-output lookup; cloud webhook source binding is fixed. 62 unique fake-transport/database/session scenarios pass. Command executor and Android UI follow; rollout remains off. See [batch 116](meeting-ai-phase3-batch96-2026-09-13.md).

- Batch 117: single-execution cloud command worker, leased outcome lookup, source quarantine/stop and bounded Celery recovery; migration 0176. 53 isolated scenarios and task registration pass. Lifecycle events and Android UI follow; standalone translation/final review remain. See [batch 117](meeting-ai-phase3-batch97-2026-09-13.md).

- Batch 118: exact-worker cloud lifecycle events, monotonic recording state, pending-command completion and bounded occurrence-scoped notices; 132 unique isolated scenarios pass. No migration; keep rollout off pending Android integration. See [batch 118](meeting-ai-phase3-batch98-2026-09-13.md).

- Batch 119: Android cloud recording protocol and encrypted exact-intent recovery (`46ecbf08`); 8 JVM + 5 isolated device tests and builds/token checks pass. Native panel follows; rollout remains off. See [batch 119](meeting-ai-phase3-batch99-2026-09-13.md).

- Batch 120: Android cloud recording panel (`3759a2f5`), explicit confirmation, exact-source foreground reads and durable recovery UI; 8 isolated UI + 8 JVM tests, builds/token/visual checks pass. WE_MEET_CLOUD_RECORDING_NATIVE defaults false. Standalone translation and final review follow. See [batch 120](meeting-ai-phase3-batch100-2026-09-13.md).

- Batch 121: opt-in Web 100 ms PCM tap shares the recording microphone, bounds unacknowledged frames and isolates consumer failures; 24 unit tests, real Chromium tap/recording checks and production build pass. No backend/rollout change; standalone translation transport follows. See [batch 121](meeting-ai-phase3-batch101-2026-09-13.md).

- Batch 122: Android same-microphone PCM tap (`d19b2fef`), bounded leases, source checks, tail draining and recording failure isolation; 18 JVM + 7 isolated service tests and builds/token checks pass. Defaults remain off; translation session/transport follows. See [batch 122](meeting-ai-phase3-batch102-2026-09-13.md).

- Batch 123: standalone recording translation reservations and immutable exact-source controls; migration 0177, default-off secure gateway settings. Gateway execution and clients follow; M3/M4 remain incomplete. See [batch 123](meeting-ai-phase3-batch103-2026-09-13.md).

- Batch 124: signed capture translation tickets, one-worker claim, one-time begin, expiring heartbeats and immutable finish metering; 40 isolated scenarios pass. Gateway transport and clients follow. See [batch 124](meeting-ai-phase3-batch104-2026-09-13.md).

- Batch 125: bounded standalone WS gateway, same-source PCM, bidirectional manual controls, lease-supervised startup/drain and strict backend responses; 45 agent tests pass. Archive integration and clients follow. See [batch 125](meeting-ai-phase3-batch105-2026-09-13.md).

- Batch 126: retained recording translation archives with actual capture provenance, exact owner-only readers and durable gateway final delivery; migration 0178, 93 unique backend + 29 agent scenarios pass. Client integration and final review remain. See [batch 126](meeting-ai-phase3-batch106-2026-09-13.md).

- Batch 127: Web/native per-turn PCM draining without stopping original recording (Android d3d4d332); 26 Web, 20 JVM, 8 service scenarios plus real Chromium/build checks pass. Translation client integration follows. See [batch 127](meeting-ai-phase3-batch107-2026-09-13.md).

- Batch 128: strict Web recording translation protocol, metadata-only recovery and same-microphone WS transport; 24 Web and 61 agent scenarios plus real Chromium/build checks pass. UI, playback and native integration follow. See [batch 128](meeting-ai-phase3-batch108-2026-09-13.md).

- Batch 129: Web recording translation controls and bounded output playback; 12 unit scenarios, real Chromium two-direction/one-microphone and responsive checks, TypeScript/lint/build pass. Archive UI, Android and final review follow. See [batch 129](meeting-ai-phase3-batch109-2026-09-13.md).

- Batch 130: exact owner-only saved recording translation UI, bounded validated pagination and private-content lifecycle; 20 Web scenarios and TypeScript/lint/build pass. Android, deployment wiring and final review follow. See [batch 130](meeting-ai-phase3-batch110-2026-09-13.md).

- Batch 131: Android strict recording translation protocol and encrypted metadata recovery (0eeb4084), plus Web immutable source revision validation; 12 JVM, 5 device and 8 Web scenarios pass. Native transport/UI and final review follow. See [batch 131](meeting-ai-phase3-batch111-2026-09-13.md).

- Batch 132: Android same-microphone WS translation (211834a1), plus cross-client completion deduplication; 22 JVM and 13 Web scenarios pass, including a real loopback WebSocket. Native playback/UI and final review follow. See [batch 132](meeting-ai-phase3-batch112-2026-09-13.md).

- Batch 133: Android recording translation controls and bounded playback (90f6e937); 13 isolated device scenarios and enabled/default builds pass. Native archive UI and final review follow. See [batch 133](meeting-ai-phase3-batch113-2026-09-13.md).

- Batch 134: Android owner-only saved recording translation archives (cbe73696); 10 isolated device scenarios, builds and light/dark inspection pass. Worker deployment wiring and final review follow. See [batch 134](meeting-ai-phase3-batch114-2026-09-13.md).

- Batch 135: five optional AI Workers, exact WSS gateway ingress and partial-release image preservation; eight render/script scenarios, Helm lint, shell and Compose checks pass. See [deployment configuration](meeting-ai-worker-deployment-2026-09-13.md) and [batch 135](meeting-ai-phase3-batch115-2026-09-13.md). Final technical review follows.

- Batch 136: final review fixed cross-login refresh/retry races in Web and Android (76c97d32), plus buffered SSE authority checks. Focused, full-suite and build evidence: [review batch 136](meeting-ai-phase4-batch116-2026-09-13.md). Recovery review continues.

- Batch 137: preserve uncertain commands and validate source-bound success acknowledgements; 111 backend and 104 Web scenarios pass. Deploy backend before frontend. See [review batch 137](meeting-ai-phase4-batch117-2026-09-13.md).
