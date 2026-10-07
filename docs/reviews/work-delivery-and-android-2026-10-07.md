# Windows 本地 Agent 交付与 Android 远程任务验收

2026-10-07。按用户顺序完成桌面交付基础和 Android 远程任务接口/界面；iOS 暂不开发。保留既有工作区变更，源码未提交；未部署生产、未覆盖已安装用户 App、未修改上游 dsh。机器记录见 [JSON](work-delivery-and-android-2026-10-07.json)。

## 内部候选

| 产物 | 版本与状态 |
| --- | --- |
| `src/desktop/release/We-Meet-0.4.0-delivery.1-setup.exe` | 187040257 字节，每用户一键安装；Authenticode **NotSigned** |
| 内置本地 Agent | `0.3.1` / dsh `0.1.5rc1` / Python `3.13.9`；独立 launcher、Node/rg 和锁定依赖 |
| `../we-meet-android/app/build/outputs/apk/debug/app-debug.apk` | `0.3.0-work.1`，versionCode 3，`com.we.meet`，168616637 字节；Android Debug 签名验证通过 |

Windows SHA-256：`a6aa971ab93dedb215843000b46a881801e2d2a98bd59c6d4bf815626caa36a0`。

Android SHA-256：`a2d7b2ba0d637d6d0f90b71ce0063b1bf34c344171d856bbff4a4d8bbe5c5c73`。

内置清单 SHA-256：`7abe65cf859d37dcf86ca6750942931fbdd458bfc6074218c47f2b8ac14e05b8`。安装包解包目录所有运行环境文件重新校验通过，实际打包 launcher 的 SDK 握手与原生目录授权通过。扫描桌面完整解包内容及 APK 解压条目，供应商密钥命中 0；密钥留在本机忽略文件/账号加密配置。

## 产品行为

- 最终用户无需另装 Python、Node、pip 或 Docker；模型密钥和目录通过桌面原生选择器导入/授权，页面与手机不持有密钥。
- 运行环境独立版本目录，签名、完整清单、逐文件哈希及 SDK/审批能力探测通过后原子切换；失败不切换，保留上一版本并重新验证回退。活跃任务不允许更新/回退，切换后重新授权目录。
- dsh 工具调用交付执行前必须审批完整脚本/参数，原生弹窗默认拒绝；审批绑定任务、审批 ID 和参数 SHA-256，一次有效。拒绝、取消、超时或重启使本次待批准调用失效，已发生的模型用量保留。
- 桌面发布工作空间别名与设备元数据，手机可向离线或在线桌面发起待办；桌面人工“审阅并领取”后原 UUID 执行。重新登录重新授权，无自动领取、云端转移或不确定状态重跑。
- Android 从侧边抽屉“工作”进入，支持派发、任务分页、状态、取消和成果文本预览。派发应答不确定时锁住原目标与 UUID，重试原请求。
- 目录原始文件/绝对路径与成果正文不随注册/状态上传；用户主动选中文件同步后手机才可查看，受限 UTF-8 预览校验字节数和 SHA-256，不执行 HTML/脚本。

## 验证

| 检查 | 结果 |
| --- | --- |
| PostgreSQL Work 后端 | 76 通过、3 项显式 live 跳过；权限隔离、离线排队、UUID 幂等、撤销后拒绝领取 |
| 独立 Agent | 37 通过、4 项显式 live 跳过；审批前不交付、拒绝/超时/取消/重启、碎片流解析、用量保留 |
| 桌面 Node | 22 通过、0 跳过；实际打包 launcher、签名更新/失败不切换/篡改/回退、ZIP 穿越/ADS/保留名/重复名/符号链接拒绝 |
| Work 前端 | 27 通过，TypeScript / ESLint 通过；审批参数绑定、远程仅 UUID 派发/领取 |
| Android 全应用 JVM | 547 通过、0 失败、0 跳过；Work 新增 3 项含丢失应答/系统状态恢复原 UUID、文件哈希/大小、Moshi 契约 |
| Android Work 仪器测试 | API 29 模拟器 1 项通过；离线工作空间→派发→成果预览，独立 `com.we.meet.fixturework`，截图视觉检查通过，fixture 应用已卸载 |
| 发布边界 | Windows / Android 构建、Ruff、迁移一致性通过；缺少证书的正式发布被预期拒绝 |

真实远程链路使用本机 Django API 桥、隔离 PostgreSQL、实际 Node 协调器、dsh 和 DeepSeek，身份为合成业务账号。手机形状的请求入队，未经领取不执行，原设备手动领取/逐次审批后生成 `report.md`，原始输入未改，仅主动同步选中文件正文。回执 [remote/live.json](../../.work-acceptance/work-delivery-20261007/remote/live.json)：3 次模型调用，输入 708、缓存读取 2304、输出 687 tokens，含审批等待约 81.4 秒；设备用量不进入供应商计费记录。两次命令均审阅实际脚本后按审批 ID+SHA-256 放行，未自动批准模型请求。

Electron 使用真实打包 renderer、dsh/DeepSeek 和临时本地目录，合成业务 API 与受控原生对话框选择，验证本机读写、逐次审批、主动同步、取消、退出/换号隔离；回执 [electron/receipt.json](../../.work-acceptance/work-delivery-20261007/electron/receipt.json) 与两次审批证据在同目录。这不是本轮已安装包、真人选择器或生产 OIDC 验收。

这两份真实模型回执使用内置 Agent `0.3.0`。最终 `0.3.1` 将 HTTP 响应头移至批准及运行状态复核后发送，并强化运行环境可用性探测；最终审批回归及打包 launcher 握手/授权通过，未重复付费模型调用。Android 使用 fake Work API 测试界面；与真实模型远程链路分别成立，尚未完成真实 Android 登录→桌面→手机成果的单条 UI 联调。

截图：[桌面完成页](../../.work-acceptance/work-delivery-20261007/electron/local-work-completed.png)、[Android 成果页](../../.work-acceptance/work-delivery-20261007/android/work-result.png)。回执和截图保留于 gitignored 本机验收目录，不含可复用账号票据。

## 启用与剩余发布条件

按项目流程迁移至 `work.0005`，配置 `WORK_ENABLED=true`、`WORK_LOCAL_AGENT_ENABLED=true`、`WORK_REMOTE_AGENT_ENABLED=true`、`WORK_AGENT_MODEL=deepseek-flash`。新增开关默认关闭，生产迁移/启用未执行。端点与权限见 [后端说明](../../src/backend/work/README.md)，构建与外部签名配置见 [桌面说明](../../src/desktop/README.md)。

用户没有 Windows 签名证书，产品运行时公钥尚未配置。候选只用于内部验收，签名升级入口关闭；签名测试仅使用隔离 fixture 密钥，未设为产品信任根。正式发布须提供 Windows 证书和产品 Ed25519 公钥，并验证最终 Authenticode 签名。整套 Electron App 目前通过安装包手动升级/回退，没有后台更新源。

本轮没有实际安装/升级/卸载候选或干净 Windows 验收。Android 为 debug 候选、未发布商店；仍需真实账号跨端 UI 验收。cwd 不是 OS 沙箱，当前批准完整命令而非逐文件 diff，取消不能撤回已写磁盘；离线取消要等设备恢复联络。Android SavedStateHandle 支持系统恢复，不保证强制停止/重启设备后意图持久化。只允许同账号、当前组织、原设备执行，没有跨设备接管。

## 后续证据

同日后续已补齐两端实际界面/HTTP 的联合验收（最终 Agent `0.3.1`），及隔离衍生安装包的实际安装、升级、回退、卸载。见 [联合验收](work-cross-device-acceptance-2026-10-07.md)；本页前文保留当时验收范围，不能将后续隔离身份/衍生安装包结论等同真实登录或原产品干净 Windows 验收。
