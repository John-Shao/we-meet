# 客户端与服务端任务协调评审

日期：2026-10-07。范围：统一任务记录 → 客户端原设备领取 → 状态回报 → 用户主动成果同步。基线为此前 dsh / Pi PoC 和本地工作空间集成，原有工作区修改保留。

已实现独立 `work-device/v1` HTTP 协调协议、PostgreSQL WorkDevice / WorkRun 扩展、Electron 主进程加密协调记录和可选云端材料快照。实际运行仍通过独立适配器 `0.2.0` 的 `work-local/v1` stdio 进入原生 dsh；上游 SDK / runtime 固定 `0.1.5rc1`，未修改用户的 dsh 仓库。

服务端固定原设备与 run UUID，云端 worker 排除本地执行。登记应答丢失后保留原 UUID，重启需用户确认并重新授权原目录；回报应答丢失后重发同序号和正文。90 秒租约过期显示 `disconnected`，不自动接管或重复付费调用。取消优先于迟到成果，权限撤销停止交付；原设备可恢复回报。

自动回报仅包含任务信息、设备用量和成果文件清单，原文件及成果正文不会因此上传。用户选定文件后服务端验证清单、字节数和 SHA256，写入不可变成果及已有 Work 下载路径。设备用量明确标记 `device_reported`，不伪装为供应商计费记录，不写 `AIUsageRecord`，保留每日完整预算预留。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 后端 Work 全量测试 / PostgreSQL | 73 通过，2 项真实模型测试未在离线套件启用 |
| 新协调状态机针对性复验 | 8 通过；包含幂等、连续序号、取消竞态、断线、权限撤销、主动同步及预算观测边界 |
| 适配器完整离线套件 | 33 通过，4 项显式 Docker / 真实模型验收未启用 |
| 桌面 Node 契约与独立 wheel 握手 | 19 通过，0 跳过；包含丢失登记/回报应答后的恢复 |
| 前端 Work 路由 | 25 通过；本地同步、原任务恢复、云端设备状态、共享成果和用量标签 |
| TypeScript / ESLint / Ruff | 通过；最终桌面和 renderer 构建通过 |
| 数据库迁移一致性 | `makemigrations --check --dry-run` 无新增差异；测试数据库应用到 work.0004 |
| 真实 Work API → dsh → DeepSeek 联合验收 | 1 通过；实际 PostgreSQL、Node 协调器、非 editable 安装的 wheel、本地原文件和授权云端材料 |
| Electron 页面主动同步验收 | 通过；实际主进程、DPAPI、stdio、dsh、DeepSeek；合成业务账号/API，原生对话框由测试指定选择结果 |
| 密钥检查 | 3449 个源文件、前端/桌面构建及本轮回执未发现实际模型密钥；密钥仅保留在忽略的本地配置中 |

真实 API 联合测试 `7422e13f-e5b5-4a28-98f9-2c44ec7c8e25` 约 30.6 秒完成，5 次模型调用，用量为普通输入 1446、缓存读取 6272、输出 1366 tokens。输出包含本地 `native-marker-9852` 与云端 `cloud-marker-4681`；原文件保持不变。主动同步前服务端成果为空，同步后仅有 `report.md`。此处是隔离测试的合成材料。

Electron 验收另行验证页面点击登记与同步、完整路径与正文不进入自动回报、ticket 不返回页面、打开本地成果、取消前后时序、注销后的访问拒绝及账号 B 看不到账号 A 的配置。截图已检查。它使用模拟业务 API，不替代上方真实 Django / PostgreSQL 联合验收，也不代表已完成安装器或人工目录选择验收。

原始回执位于 `.work-acceptance/work-coordination-20261007/live.json`、`electron/receipt.json` 和 `electron/local-work-completed.png`；安全摘要保存在同名 JSON 评审文件。

## 候选产物与边界

- 桌面：`src/desktop/release/We-Meet-0.3.0-local-work.2-setup.exe`，127653878 字节，SHA256 `5ea7a21bf1c6fb6c19d37e70ad97f5305adb8a4f9b7ad17647fbfcbdcd78ff22`。Authenticode 为 `NotSigned`，构建源树包含本轮未提交修改。
- 独立适配器：`.work-acceptance/work-coordination-20261007/artifacts/we_meet_work_agent-0.2.0-py3-none-any.whl`，SHA256 `87078a00081b611922000da8fef0e5d85d46e69d497b7cebad1da416d0621b6c`，已安装到隔离目录完成真实验收。
- 启用说明：[客户端与服务端协调](../../src/work-agent/COORDINATION.md)。`WORK_LOCAL_AGENT_ENABLED` 默认关闭；生产迁移、开关启用、候选客户端安装均尚未执行。

本机目录不是操作系统沙箱。断网期间云端取消无法立即通知设备；退出账号后的最终回报可能等待同账号再次登录。当前不支持跨设备接管本机执行、自动组织共享、供应商对账或企业设备治理。已有云端执行、沟通准备及历史发布状态保持各自记录。
