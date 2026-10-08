# 双 Agent 生产功能验收（2026-10-08）

职责、协议、跨端时序和运行维护统一见 [Work Agent 架构](../features/work-agent-architecture.md)；本篇记录具体发布及验收证据。

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

## 架构与走查修复后的最终版本

生产适配器已独立更新至 **0.3.5**，上游 Pi 保持 **1.0.4**、模型保持 `qwen3.8-flash`。Gateway 和 Pi worker 镜像分别固定为：

- `jusi-cn-guangzhou.cr.volces.com/we-meet/work-agent-gateway@sha256:87501e5fb151e859873cd0e1513de896916a986200414d75d3268377dabfb87d`
- `jusi-cn-guangzhou.cr.volces.com/we-meet/work-agent-pi@sha256:1842512b12733f3d33be5f094472731d749954afc0f4c00fbe81c87bca1135fa`

两者来自干净源 `1a316cdac5721c9ac2421322020e59e990861bbf`，其 [CI 37711324716](https://github.com/John-Shao/we-meet/actions/runs/37711324716) 四项通过。前一候选 `9da4aabd1` 的部署保护测试因旧 Helm `env: null` 失败；该镜像没有上线，修复兼容性并保留回归后才发布当前版本。升级前全部业务入口关闭，PVC 数据库备份 quick_check 为 ok，SHA-256 `82171d3239a89bca7d1b7256312dfcc2ca9d27a5e83506cdae32ef1f199c3471`；Gateway UID、TLS/CA、Secret、存储和网络边界保持，历次版本快照及备份继续保留。

0.3.5 对材料不足的新报告保守标记 `inconclusive`，不放宽文件、哈希或引文校验。使用上述实际 Pi worker 镜像完成真实 RPC/合成 SSE 回归：`needs_changes + missing_information` 输出信息不足结论，供应商调用为 0。已有成功生产报告仅只读复验：桌面及 Android 显示“信息不足，仍需确认”，原始 `needs_changes` 和源成果不变，没有第五次付费复核。

生产 Web 已更新到同一源的 `meet-frontend@sha256:266fa1b7d53869b35f348782496510b32fabfe13df0b0db9644927c892665021`。仅改变前端 Deployment 的容器镜像，以完整 spec/UID/resourceVersion 校验；原镜像 `meet-frontend:241a87536` 的快照保留。实际 Ready Pod 的 imageID 匹配 digest，`https://meet.we-meet.online/` 首页及资源与 Pod 内文件逐字节一致，报告结论提示存在；首页 SHA-256 `ce7f0d955491d3403e6555fa44f928327c27e7db041ae171debef6e363b71c48`。第一次检查误用站点域名，前端已按快照回退；纠正为生产入口后更新并复验通过。业务七个消费者、Gateway 及 schema 再次通过检查。

最终 Windows 内部候选为 **0.4.0-delivery.4**，取代上面的 delivery.3：由干净源 `99b64cd5bda9cdbae28418770b0b97ddf39c4947` 构建，其 [CI 37711888151](https://github.com/John-Shao/we-meet/actions/runs/37711888151) 四项通过。安装包 SHA-256 `834fb0dd132bf6b44ddf2e362d17c836afed9d46a2f49cfbca9e6e0f1fc0fcc8`，实际 NSIS 解包检查匹配 201 个编译文件、186 个 renderer 资源和 0.3.2 自包含运行环境；原生能力与授权探测通过，模型调用为 0。工作空间重试校验、升级失败可重试、探测后再校验和并发切换保护均已加入。运行环境 descriptor SHA-256 `6e7c9bc1f446d4ef2d11b8f8cd3bbdb55418e0ae9b11d5a8d90214d3ac18736f`；包为 **NotSigned**，正式签名门槛继续保留。

Android 源 `dd19008bbff4cbec515ccc5f325b3ba7436da073` 的 [CI 37711332562](https://github.com/John-Shao/we-meet-android/actions/runs/37711332562) 通过；真实生产报告及源文件预览检查通过，新增“信息不足”展示断言通过。验收后恢复普通 `com.we.meet` App/AndroidTest 构建，隔离 fixture 包、profile 和 ADB reverse 已清理。

最终生产恢复为**单演示账号灰度**：local/remote/review 为 True，通用云端 Agent 为 False。七个消费者的完整 spec、UID 和镜像核验一致，五个 Deployment 全部 Ready，业务与 AI 的两类健康接口均为 200，Celery 返回两个 pong；演示账号准入，其他账号拒绝，schema 和独立 Gateway 不变。此次开关恢复与配置导出没有供应商调用。

与现场一致的完整 Work overlay 已原子发布到操作员目录 `~/.config/we-meet/values.work-cohort.yaml`，权限 **0600**，SHA-256 `b7db385164d39aa4f962c02975b37359fbee9a637d14453fa1bfb1dcde10be47`；旧配置有独立备份。七个消费者检查通过，缺失或部分 overlay 均被拒绝，只含设置和 Secret 引用，不复制供应商密钥。实际准入 UUID、认证会话和私有快照不提交。

本轮三项工作已完成，脱敏的机器回执见 [JSON 记录](work-dual-agent-production-release-2026-10-08.json)。模型意见仍须人工核实；当前交付不包含全用户放量、通用云端 dsh、iOS、正式 Windows 签名或干净 Windows VM 验收。
