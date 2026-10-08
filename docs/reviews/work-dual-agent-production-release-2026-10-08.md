# 双 Agent 生产功能验收（2026-10-08）

桌面 dsh 执行、明确同步成果、服务端 Pi 复核以及 Android 查看报告与原文件的完整链路已通过。生产只针对既有演示账号做灰度，通用云端 Agent 保持关闭；此次不是全用户上线，也不是把桌面 SDK 放入 Android。

| 环节 | 实际证据 |
| --- | --- |
| 业务部署 | 5 个 Deployment、2 个 CronJob 均使用业务镜像 `e80b10e82eebea449076901453cf0669838fbd33aaae5afd176f6ab44b948e61`，schema 不变 |
| 桌面执行 | 独立运行环境 0.3.2 / dsh 0.1.5rc1；DeepSeek 3 次调用、5234 tokens；2 次命令逐项审批 |
| 文件同步 | 原输入未修改；仅显式选择 `report.md` 后同步，SHA-256 `4df347fb2ff89f85e18ee1988332eb9a4594c7605e753598b847fee67061e8dd` |
| Pi 功能通过 | Pi 1.0.4 / qwen3.8-flash；复核 `14143096-6883-41a2-a1d5-aa25189b096a`；1 次调用、输入 981 / 输出 584 tokens；引用、哈希、原文校验通过 |
| 桌面与手机 | 真实生产 API、Electron 页面和 Android WorkScreen/ViewModel/Repository 显示报告；原文件预览内容匹配 |
| 关闭检查 | 四个入口关闭时，重新派发返回 503、终态重领返回 409；业务健康与 Celery 心跳通过 |
| 账号隔离 | 仅 1 个已核验账号准入，其他账号不准入；供应商密钥留在桌面密钥存储或独立 Pi Secret |

业务源为 `e92f9eec4540a9b16dc107a421523beefc87f681`。首个成功复核使用适配器 0.3.4，源 `176cdc607345fefcb1b963a31dd006312267ba91`，发布 CI [37709495283](https://github.com/John-Shao/we-meet/actions/runs/37709495283) 四项通过。对应 Gateway 为 `c6dabc93f8e589965fa23d75b84fc266b80c0a8ca90d2506d54943cdd7ed8055`，Pi worker 为 `5f1f8d6e9d17c9365d5a000ba5ef40e5745257c694528d3c3b02cb638197e426`；升级前 PVC 数据库备份经 quick_check 验证，历史 spec 与备份继续保留。

前三次失败完整保留：第一次预算不足，供应商调用为 0；第二次 1 次调用 / 960 tokens，缺少诊断无法归因；第三次 1 次调用 / 1146 tokens，脱敏诊断证明有 1 条引文不属于被引用文件。修复在 Gateway 侧从已接收快照生成文件名、哈希和有限原文片段约束，严格引用校验继续保留。后续试验均先记录单次意图，再查询同一记录，没有自动付费重试。官方结构化输出约束依据 [百炼文档](https://help.aliyun.com/en/model-studio/qwen-structured-output)。

“协议验收通过”只说明报告交付和来源校验正确。此次模型把合成标记误判为不符合原输入，同时承认缺少原始输入与日志；该判断不能作为任务错误的事实证据。架构整改将缺失信息优先标记为 inconclusive，并在客户端强调仍需核实，保留原始历史意见，不改写已成功的任务。见 [架构整改](work-agent-architecture-review-2026-10-08.md)。

身份采用真实 HTTPS 演示账号 OTP，会话仅在隔离 profile / 内存中使用；原生 OAuth 登录、真实目录选择器交互不属于本次证据。临时 Electron profile、授权目录、Android fixture 包及 ADB reverse 已清理。首个成功试验的退出动作因导航销毁页面调用上下文导致测试收尾报错；随后只读复验页面、退出状态和凭据移除，再完成 Android 验收，没有再次创建复核。

内部 Windows 安装包 `0.4.0-delivery.3` 已从干净源 `b5cbec22c57854a8b2c5e934c6391c8755fcbf6f` 构建并解包审计自包含 0.3.2 运行环境，SHA-256 `c35276b4a7cb2bec5ebe90891638a4711c0685c84031fb13c3f4d2fa434f6975`。动态打包配置解决了旧过滤器漏装新运行环境的问题。尚无 Authenticode 证书和正式运行环境信任公钥，当前包是内部候选；干净 Windows VM、正式签名和真实材料质量评估仍有明确独立范围。
