# 云文档成员授权不依赖邮箱

Android 从公共通讯录选择用户，向 Meet 提交用户 UUID；Meet 查询同组织有效成员的真实 sub 和姓名，再通过 S2S 请求 Docs 直接授权。首次使用者由 Docs 按 sub 建号，无需邮箱或接受邮件邀请。

新增 `/api/v1.0/docs/member-access/` GET/POST 接口。GET 返回已授权成员的 Meet UUID；POST 支持每批 1–100 人、reader/commenter/editor，逐用户返回 added/existing/failed。客户端传入的 actor_sub、收件人 sub、email 均不能参与身份判定。Docs 独立检查调用者的文档管理权限，响应必须逐人确认；不兼容的旧后端明确失败。

代建文档要求 sub，email 仅可选通知。会议纪要接收者按 sub 筛选。聊天授权仍保留原有会话来源与角色聚合规则，不自动授权后入群用户。

完整协议及历史邀请处理说明见 we-meet-docs/docs/member-identity-protocol.md。发布顺序为 Docs 后端 → Meet 后端 → Android APK，无数据库结构迁移。已有 sub 绑定的权限继续使用，历史邮箱待接受邀请不自动猜测归属。
