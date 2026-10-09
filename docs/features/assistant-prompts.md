# 后端管理助手提示词

客户端原有提示词迁入 AIPrompt。迁移 0199 清空旧目录，创建 12 条新记录：四个通话场景（英语旅行、日语旅行、商务、口语陪练）和八条系统指令（默认助手、翻译语言识别、摄像头控制、结束通话、三个工具说明、摄像头状态同步）。迁移只执行一次；后续后台修改不被启动或请求覆盖。旧记录的 UUID 失效，旧提示词选择回退到后台默认指令；旧客户端场景 ID 在新客户端加载配置时转换为新提示词 UUID。

管理后台 AI prompts 可编辑正文、名称、排序、启停。`code` 是稳定用途标识，请保留已有标识；`scope=call` 是用户可选场景，`scope=system` 是系统指令，不出现在用户场景列表，也不能通过场景 UUID 被误选。

- `call.scene.travel`、`call.scene.travel_ja`、`call.scene.business`、`call.scene.practice`：通话场景。
- `call.default`：默认通话指令。
- `translation.language_detection`：语言识别模板，支持 `{source_language}`、`{target_language}`。
- `call.tool.camera`、`call.tool.end_call`：工具调用规则。
- `call.tool.description.set_camera_enabled`、`call.tool.description.get_camera_state`、`call.tool.description.end_call`：工具说明。
- `call.tool.camera_state`：摄像头状态同步模板，支持 `{camera_state}`。

通话配置接口返回启用的 call 场景，带 UUID、code、label、content。通话分配接口读取当前后台正文，并返回 `instructions` 和 `tool_instructions`；客户端按实际可用工具拼接规则及说明，不再用本地场景正文覆盖后台结果。双语互译语言识别会话返回渲染后的 `instructions`，AOQ/WebRTC 共用。手动指定方向不申请语言识别会话，因此不依赖该模板。双语互译场景仍只记录偏好，不自动把通话场景提示词发送给翻译模型。

客户端保留场景历史标识、界面文案、工具名称、参数结构和执行逻辑，不保留提示词正文。必需的系统提示词被停用、缺失或为空时，后端在分配付费模型连接前返回 503，不回退到旧硬编码正文。提示词在新建会话时读取；后台修改不打断已建立的会话。

发布顺序：先发布后端并执行迁移 0198、0199，再发布新客户端。0199 会删除旧提示词记录，反向迁移不会恢复旧正文。2026-10-09 已发布生产环境并完成迁移（Helm revision 461）；旧目录的 5 条提示词已备份并清除。

验证：全新测试库完整迁移后，145 项后端接口/目录测试通过；Android 84 项单元测试、45 项设备回归通过；Debug App/测试 APK 构建、Release Kotlin 编译及设计规范检查通过。

真实模型回归：隔离的本地信令服务调用当前后端视图并下发后台语言识别模板，Ethan 音色的 WebRTC 自动中译英测试通过，覆盖译文、译音能量、AudioTrack 播放、回放和结束。首次尝试在媒体连接阶段发生传输断开，重试通过。探针使用模拟器和合成语音，鉴权/租约由接口测试另行覆盖；不代表已部署生产或完成真机音频验收。

生产验证：正式接口与 Release 包共七项真实模型/目录测试通过，发布记录见 `docs/reviews/managed-assistant-production-2026-10-09.md`。
