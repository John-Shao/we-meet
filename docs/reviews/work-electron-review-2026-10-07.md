# 桌面成果复核窗口验收（2026-10-07）

上一批 `6921df971` 已推送。本批补齐真实 Electron 窗口的桌面成果同步与独立 Pi 复核交互验收，并修复权限查询失败后继续显示缓存复核内容的问题。没有调用真实模型供应商或部署生产服务。

## 修复行为

React Query 在重新查询失败时仍保留此前成功返回的数据。新增回归测试确认：文件接口或复核接口返回 `source_unavailable` 后，页面仍显示旧报告和引用。

现在任何一个查询失败都会隐藏该复核区域缓存中的文件名、报告和取消入口，禁用创建，并清空选择及发送授权。重新加载成功后可再次查看记录，但必须重新选择文件并授权发送。复核服务开关关闭时，已有且权限检查成功的历史仍可查看。

窗口截图同时确认了复核授权选项挤在一行、长哈希和本地原文超出容器的问题。本批让选择与授权各自换行，长文件身份及原文在容器内折行。

## 验证结果

| 范围 | 结果 |
| --- | --- |
| PiReview / LocalWorkspaceWork / AgentWork | 22 项通过，含两条分别覆盖文件与复核查询失败的缓存回归 |
| 桌面主进程 | 21 项通过、1 项打包原生适配器 opt-in 跳过 |
| 真实 Electron 窗口 | 16 项检查通过，供应商调用 0 次 |
| 构建与静态检查 | 前端生产构建、桌面主进程构建、ESLint、Prettier、脚本语法及 diff 检查通过 |

窗口验收运行当前 bundled renderer、生产 preload/IPC 及 WorkCoordinator，使用隔离加密会话与本地 HTTP fixture。只替换测试进程中的原生适配器传输，不给产品代码增加测试入口，也不替换 renderer 的 contextBridge。窗口保持 contextIsolation 开启、nodeIntegration 关闭；阻止页面访问其他网络服务。

合成本地任务生成 `report.md` 和 `private.csv`。正文不随设备元数据上报；用户只同步前者后，复核列表才出现且仅包含它。创建复核还需独立选择及发送授权。首次创建在服务端合成受理后丢失响应；显式重试复用同一请求键，两次请求只产生一条复核记录。报告、模型、输入/输出用量与引用以文本显示。

随后两次独立合成复核取消：第一次检查原任务保持成功；第二次用于运行中权限撤回的轮询验收。共四次创建请求、三条合成复核、一条合成本地执行，原生执行器没有收到取消调用。撤回后缓存报告和文件名隐藏，恢复访问后选择与授权均清空。退出登录后本地访问被拒绝。

## 证据与复验

从 `src/desktop` 运行 `npm run build:renderer`、`npm run copy:renderer`、`npm run test:review-smoke`。脚本生成忽略目录 `test-results/work-review/receipt.json` 与 `review-completed.png`，清理临时 profile；[脱敏交付 JSON](work-electron-review-2026-10-07.json) 保留本轮回执及所测 renderer 身份。

本轮使用真实开发态 Electron 窗口，登录、API、原生执行器和对话框选择是合成 fixture。API 返回的复核结果用于展示验收，没有经过真实 Pi 或供应商校验；此前真实 Pi Docker 与合成模型的后端验证见 [串联验收](work-local-pi-flow-2026-10-07.md)。本轮不证明真实 OIDC 登录、交互选择器、安装包、签名或集群部署。

下一批实际部署仍需 Kubernetes context/namespace、专用 Docker 节点、镜像仓库和 TLS Secret。当前本机镜像尚未上传，reviewer 配置保留占位值及关闭开关，未推定生产集群为测试环境。
