# 客户端本地工作空间集成验证

2026-10-07，Windows x64，桌面候选版 `0.3.0-local-work.1`。已完成原生本地文件执行闭环，候选安装包已构建；尚未安装替换现有桌面，也未部署云端业务改动。

## 交付行为

- 桌面“新工作 / 周报 / 表格分析”默认打开本地工作空间，支持切换云端材料。
- 主进程选择目录并确认原生执行权限，随后通过自有 `work-local/v1` stdio 连接独立安装的适配器。
- 适配器使用官方 `deepseek-harness-sdk/runtime-bin==0.1.5rc1`、`sdk-minimal` 和真实 `cwd`；材料不复制为服务端快照，成果写入 `工作空间/WeMeet成果/<run UUID>/output/`。
- 密钥由原生文件选择器导入、经 DPAPI 保存；业务账号凭据不进入 SDK 子进程。主窗口、主 frame、origin、参数和账号代次均在主进程检查。
- 任务 UUID 幂等、取消优先、历史保留、重启重新授权、成果内容和路径校验均已接入。正常退出账号 / 客户端取消本机任务。
- 桌面和适配器可独立更新；依赖锁与非 editable wheel 安装脚本已提供。不修改用户的 dsh 源码仓库，不附着其既有原生 UI 会话。

## 验证结果

| 范围 | 结果 | 实际覆盖 |
| --- | --- | --- |
| Agent 单元与契约回归 | 32 通过，4 显式 opt-in 跳过 | HTTP 云端兼容、本地真实目录 fixture、取消、幂等、重启、修改文件拒绝、单所有者、模型预算与用量 |
| 本地 Python 真模型 | 通过 | 直接读本机 orders.csv，去重并仅统计 paid，JSON 结果 east=100 / south=200，成果在原目录，用量完整 |
| Node 主进程桥接真模型 | 通过 | `LocalWorkClient → stdio → 原生 dsh → DeepSeek → 本机 report.md`，文件包含仅存在原目录的 marker |
| 桌面回归 | 15 通过 | 既有认证、退出代次、网络转发及本地 stdio / UTF-8 / 密钥文件；包括独立 wheel 安装后的适配器握手 |
| Work 页面回归 | 21 通过 | 四个测试文件，包括本地授权前不能提交、丢失应答复用 UUID、恢复 / 取消、文本成果和原生打开 |
| Electron 页面端到端 | 通过 | 实际 bundled React 页面、DPAPI 配置、目录授权、独立安装的原生 dsh、DeepSeek、成果打开路径、取消前置 / 正在运行任务、拒绝原始路径注入、退出拒绝访问、账号 B 无账号 A 配置 |
| 构建与静态检查 | 通过 | Python Ruff、相关前端 ESLint / Prettier、TS / Vite / Electron / NSIS、git diff 检查 |

Electron 测试使用本地合成业务身份和独立 profile，原生对话框由测试指定选择结果，系统文件打开由测试捕获路径。它验证实际 IPC / 安全存储 / 原生适配器链路，不等同于人工目录选择、系统应用打开或安装升级验收。模型来自用户授权的 DeepSeek API，未记录密钥。长目标和目录名的布局已检查截图并修复溢出。

测试过程还修复了加载期间退出被误报为“启动失败”的生命周期问题，以及 Windows UTF-8 BOM 密钥文件导入。JSON 成果测试按 UTF-8 字节解析，兼容原生 PowerShell 写入的 BOM，保持文件原字节及哈希。

## 产物和边界

安装包：`src/desktop/release/We-Meet-0.3.0-local-work.1-setup.exe`。独立适配器 wheel：`.work-acceptance/local-work-20261007/artifacts/we_meet_work_agent-0.1.0-py3-none-any.whl`。具体哈希与脱敏测试摘要见 [JSON 回执](work-local-agent-2026-10-07.json)。安装包未签名，当前为内部候选；工作区存在先前 PoC 及其他改动，manifest 标记 dirty，不声明仅凭当前 HEAD 可复现。

工作空间是工作目录，**没有 OS 沙箱隔离**；dsh 拥有当前 Windows 用户的本机执行能力。提供给模型的内容仍发送至 DeepSeek。任务和用量当前仅在本机账号数据库中，尚未同步到 Django WorkTask / PostgreSQL 组织配额账本。取消不撤销此前的文件修改；模型请求已经发起时可能计费，缺失用量保持未知。成果限定 UTF-8 Markdown / TXT / CSV / JSON，未保证全部办公文件格式都能解析。

Pi 目前沿用此前服务端对照路径，本次本地原生集成聚焦 dsh。运行、独立升级和回退见 [本地说明](../../src/work-agent/LOCAL.md)。原始本地证据在 `.work-acceptance/local-work-20261007/` 和 `src/desktop/test-results/local-work/`，均按仓库规则不入 Git。
