# Windows 环境解锁操作单（卡片 K＝K1，实测退 K2）

> 日期：2026-11-11
> 裁定出处：work-project.md §5.0 卡片 K【2026-11-11 主签裁定＝K1】，预授权路径"K1 失败退 K2，两条都不通走 K3"。
> 本文只写环境与步骤，不写 F13 复现实现（依赖 M2 Broker，设备面当前零代码）。

## 1. 现读事实（2026-11-11 实测）

| 项 | 读数 | 取数法 |
|---|---|---|
| 系统 | Windows 11 **家庭中文版** build 26300 | `(Get-CimInstance Win32_OperatingSystem).Caption` |
| 当前令牌 | 非提升（IsInRole Administrator＝False） | WindowsPrincipal 现读 |
| 账户组 | `DEEP_LEARNING\shaoj` **在 Administrators 组** | `Get-LocalGroupMember -Group Administrators` |
| Windows Sandbox | 包不存在（Get-AppxPackage 计数 0）；家庭版无官方支持 | 现读 |
| ETW | 非提升可列会话（logman query -ets 成功）；**起 trace 需提升，未验** | 现读 |
| AppContainer | 可建（历史实验已验，harness-lab 记录在架构文档 §首轮执行记录） | 历史记录 |
| Docker | Linux 容器（无 Windows 容器能力） | 历史现读 |

## 2. K1 判定＝本机不可行（不执行）

Windows Sandbox 官方要求 Pro/Enterprise/Education；本机家庭版不满足。
不采用非官方破解安装（不受支持、升级即碎、安全边界不可信——与"不为过测试放宽控制"同向）。
此判定是环境事实，不是放弃实机路线：按预授权退 **K2**。

## 3. K2 执行步骤（主签本人操作，助手不代提权）

1. 开始菜单搜 `PowerShell` → 右键"以管理员身份运行" → UAC 同意（shaoj 在管理员组，只需同意不需凭据）。
2. 在提升窗口验证三件（把输出贴回本单 §5 登记表）：
   ```powershell
   ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
   logman create trace F13Probe -p Microsoft-Windows-Kernel-File 0xffffffffffffffff 5 -o C:\work-k2\f13.etl -ets
   logman stop F13Probe -ets; logman delete F13Probe -ets
   New-Item -ItemType Directory C:\work-k2\dacl-probe | Out-Null
   icacls C:\work-k2\dacl-probe /grant "${env:USERNAME}:(OI)(CI)F" | Out-Null
   icacls C:\work-k2\dacl-probe
   ```
   判据：第一条 True；第二条起停 trace 无拒绝；第三条 DACL 含当前用户完全控制。
3. 隔离纪律（K2 的代价补偿）：一切实验文件只落 `C:\work-k2\`；F13 脚本（M2 期产出）必须自带 cleanup 段并在运行前打印将触碰的路径闭集；禁止脚本写用户目录。
4. 完成后 `Remove-Item C:\work-k2 -Recurse` 前先把 etl 证据归档到工作区 `_archive/`。

## 4. F13 复现的就绪判据（环境侧）

- 提升令牌可用（§3 第 2 步第一条 True）
- ETW Kernel-File trace 可起可停（§3 第二条）——junction 竞态的打开时序证据靠它
- DACL 可写可验（§3 第三条）——S4 六条硬条件之⑤⑥的实测面
- **实现侧前置**：F13 复现脚本要等 M2 Broker（目录 handle 打开逻辑）存在才有被测对象；本单只解锁环境，不产 F13 结论。signoff 的"F13 未实机复现"证据边界到实机证据产出前不变。

## 5. 执行登记（主签回填）

- [ ] §3 第 2 步三条验证输出（贴此处）
- [ ] 执行日期：____
- 若任一条失败：记失败原文，走 K3 登记（重开条件＝首个真实客户组织前，或 EV73 归属的 I 行开工时），并在 work-project.md 卡片 K 回写。

## 6. 边界

- 本单零代码零部署零 migration；不改 signoff 证据边界。
- 提权动作永远由主签执行；助手只准备步骤与只读探测。
- K2 不留 Sandbox 兜底是已接受代价（卡片 K 原文），用 §3 第 3 步隔离纪律补偿。

## 7. EV72／EV73／EV123 OS 级零请求／零写取证（提升窗口执行）

本段是主签在提升 PowerShell 中执行的操作单；助手不代提权。所有原始证据只落 `C:\work-k2\`，完成后先把 ETL/TXT/JSON 归档到工作区，再清理临时目录。

### 7.1 前置

1. 提升窗口第一条必须为 `True`：
   ```powershell
   ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
   ```
2. `pktmon`、`logman`、`tracerpt` 可执行；本地 Work 栈（Keycloak/work-api/work-gateway/work-pg16）已启动。
3. 记录 Electron 主进程、viewer renderer、Broker 的 PID 与二进制 SHA256；E2E receipt 的 `device`/`profileHash` 同时归档。

### 7.2 启动系统观测

```powershell
New-Item -ItemType Directory C:\work-k2\ev123 -Force | Out-Null
logman create trace EV123Net -p Microsoft-Windows-Kernel-Network 0xffffffffffffffff 5 -o C:\work-k2\ev123\net.etl -ets
logman create trace EV123Dns -p Microsoft-Windows-DNS-Client 0xffffffffffffffff 5 -o C:\work-k2\ev123\dns.etl -ets
logman create trace EV123File -p Microsoft-Windows-Kernel-File 0xffffffffffffffff 5 -o C:\work-k2\ev123\file.etl -ets
logman create trace EV123Pipe -p Microsoft-Windows-Kernel-Pipe 0xffffffffffffffff 5 -o C:\work-k2\ev123\pipe.etl -ets
pktmon start --capture --pkt-size 0 --file-name C:\work-k2\ev123\pktmon.etl
```

### 7.3 运行无手势窗口

在**另一个非提升**终端执行（E2E 自己完成真实 artifact.write、打开安全 viewer，然后只等待、不点击）：

```powershell
$env:E2E_VIEWER_IDLE_ONLY = "1"
$env:E2E_VIEWER_IDLE_MS = "10000"
$env:E2E_VIEWER_IDLE_MARKER = "C:\work-k2\ev123\idle-marker.json"
node scripts/work-e2e-smoke.cjs
```

marker 文件出现即观测窗口开始；E2E 会在窗口结束后写 `src/desktop/test-results/work-e2e/idle-receipt.json`，其中 `acceptanceRestCount=0`、`prepareLocalAcceptancePipeFrameCount=0`、`viewerGestureObserved=false`。

### 7.4 停止与判据

窗口结束后停止观测并转文本：

```powershell
pktmon stop
pktmon etl2txt C:\work-k2\ev123\pktmon.etl --out C:\work-k2\ev123\pktmon.txt --timestamp
logman stop EV123Net -ets; logman delete EV123Net -ets
logman stop EV123Dns -ets; logman delete EV123Dns -ets
logman stop EV123File -ets; logman delete EV123File -ets
logman stop EV123Pipe -ets; logman delete EV123Pipe -ets
tracerpt C:\work-k2\ev123\net.etl -o C:\work-k2\ev123\net.txt -of TEXT
tracerpt C:\work-k2\ev123\dns.etl -o C:\work-k2\ev123\dns.txt -of TEXT
tracerpt C:\work-k2\ev123\file.etl -o C:\work-k2\ev123\file.txt -of TEXT
tracerpt C:\work-k2\ev123\pipe.etl -o C:\work-k2\ev123\pipe.txt -of TEXT
```

必须同时满足：

- `idle-receipt.json` 三项零值成立；PostgreSQL `acceptance` 计数为 0，journal/workspace 文件哈希与窗口前一致。
- `pktmon.txt` 在 marker 时间窗内无 viewer PID 的非 loopback 包；`dns.txt` 无 `evil.test` 或任何非预期外部域名查询。
- `file.txt` 在 marker 时间窗内无 viewer/Broker PID 对授权 workspace、Work journal、`work_e2e` 数据库文件的写事件；Electron 自身缓存/日志路径单列，不混入业务零写判据。
- `pipe.txt` 无 `prepareLocalAcceptance`／`acceptLocalArtifactVersion` 相关帧；应用层 pipe log 与 REST 计数均为 0。
- **正对照**：去掉 `E2E_VIEWER_IDLE_ONLY` 再跑一次，必须出现 viewer PID 的 loopback 请求、`prepareLocalAcceptance` pipe 帧、REST acceptance 与 file/DB 写，证明观测器没有静默失效。

### 7.5 归档

把 `C:\work-k2\ev123\` 下的 ETL、TXT、marker、PID/哈希清单与 `idle-receipt.json` 复制到工作区证据目录，记录每个文件的 SHA256、采集时间窗和正对照结果。该证据只闭合 OS 观测缺口；外部 J39 审计仍是独立未完成项。