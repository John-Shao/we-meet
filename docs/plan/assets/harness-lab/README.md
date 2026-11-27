# Work Harness / 技术验证脚本

2026-10-25 首轮实验的脚本副本，不进入产品代码，也不是生产实现。结果与验收边界以 [work-system-architecture-2026-10-25.md](../../../work/archive/design-baseline/work-system-architecture-2026-10-25.md) §3.8、§21.2 为准。

## 范围

- `h01/`：Windows 安装/卸载、自签名、哈希校验、干净环境启动。
- `h02.mjs`：独立 Runtime 经本地 Work Gateway 的 Chat Completions/Responses 测试。
- `h02-supervisor.mjs`：生产 `Supervisor`＋真实 Pi child→受限 egress→本地 Work Gateway 的端到端测试；返回 `CHECKPOINTED` 才通过。
- `h03.mjs`–`h05.mjs`、`h07.mjs`–`h10.mjs`、`h12.mjs`：Harness 准入实验。
- `h06/`：Windows AppContainer + Node permission model 隔离。
- `s1s6/`：S1–S6 首轮验证；S1/S3/S5 使用 PostgreSQL，S2 为设备 journal/租约 mock，S4 为纯策略，S6 仅并发烟雾。
- H11 未触发（H03–H05 已通过），脚本未包含。

## 前置条件

- Node.js 24（Windows x64 已测）。
- `npm install` 安装根依赖；H10 还需 `cd h10/v13 && npm install` 安装 Pi 1.3.0 版本对。
- H01/H06 需要 Windows PowerShell 5.1、.NET Framework `csc.exe`；H01 需要 `HARNESS_NODE_MODULES` 或根 `node_modules`。
- S1/S3/S5/S6 需要 PostgreSQL 16 监听 55432，数据库 `wemeet`，用户/密码 `postgres`/`test`：

```bash
docker run -d --rm --name wemeet-s1s6-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=wemeet -p 55432:5432 postgres:16
```

## 运行示例

```bash
node h03.mjs
node h07.mjs
node h10.mjs
node s1s6/s1.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File h01/run-h01.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File h06/run-h06-inline.ps1
```

H02 会发起真实供应商请求，必须显式提供非生产凭据。Qwen 从 `H02_SECRET_FILE` 指向的 YAML 读取 `agentAIAssistant.envVars.DASHSCOPE_API_KEY`；未指定文件时默认的生产 secret 会被拒绝。即使显式把 `H02_SECRET_FILE` 指向该生产文件，也仍必须设置 `H02_ALLOW_PRODUCTION_SECRET=1` 才解除保护。DeepSeek/Doubao 分别读取进程环境中的 `DEEPSEEK_API_KEY`/`DOUBAO_API_KEY`。

```bash
# 使用已授权的非生产 Qwen secret 文件
H02_SECRET_FILE=/path/to/non-production-secret.yaml node h02.mjs
H02_SECRET_FILE=/path/to/non-production-secret.yaml node h02-supervisor.mjs
# 或使用非生产 DeepSeek/Doubao 环境变量
H02_PROVIDER=deepseek node h02-supervisor.mjs
H02_PROVIDER=doubao node h02-supervisor.mjs
```

`H02_UPSTREAM_URL` 可覆盖供应商端点，仅允许 HTTPS 或回环 HTTP，供隔离 fixture 使用；不要把生产 Key 交给不可信端点。无凭据回归使用临时 fixture secret，不读取生产文件：

```bash
npm run test:h02-supervisor
```

该回归覆盖生产密钥默认拒绝、真实 Supervisor/Pi 全链、usage/receipt、超限请求 413，以及 Key 不进入日志。隔离 fixture 通过不等于真实外部供应商 E2E 已通过。

## 说明

- 运行产物（`runs/`、`final/`、日志、构建目录）已由 `.gitignore` 排除。
- 不包含任何 API Key、连接器凭据或生产数据。
- H01/H02/H06/H10 与 S1–S6 均为部分通过；H10 仅验证 Pi 包版本升级/回退，容器镜像回退未测；S6 只是烟雾，不代表容量承诺。
- S2 的 F13 记录的是路径检查被 junction 切换绕过的漏洞；脚本按失败的安全不变量断言，运行会返回非零退出码，需 Rust 句柄级 Broker 关闭。
