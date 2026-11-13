# Work 项目状态桩

> 性质：活文档，但只承担**状态桩**职责——当前阶段、可部署性、阻断项、开放裁定、入口链接、最近更新时间。
> 详细设计见 [design/](design/)，架构/安全/运维见 [README.md](README.md) 起的六份短文档，当前状态以 [status.json](status.json) / [status.md](status.md) 为准。
> 瘦身前的完整台账（开放卡片全文、近期变更记录）已逐字归档至 [work-project-full-2026-11-14.md](archive/work-project-full-2026-11-14.md)；历史靠 git 追溯。
> **代码、迁移、契约和测试是详细设计的权威来源；本桩不复制实现细节，不维护"当前值＋历史值＋更正值"。**

## 1. 当前阶段与可部署性

| 问题 | 回答 |
|---|---|
| 当前阶段 | R0a 已实现并部署试点环境；R0b 设计自查完成、外部审计未执行、实现部分开始 |
| 能否部署 | 试点环境已部署（发布包 `work-release-0039`，迁移台账 tip=39）；0040–0043 在仓库未 rollout |
| 能否上真实客户数据 | **否**。接真实客户数据前必须外部安全审计（J39，未执行）；当前仅演示组织＋演示数据 |
| 试点是否开始 | 否（E8 未执行）；go/no-go 当前 no-go（C17 SLO 未实测） |
| 最近状态更新 | 2026-11-14 |

## 2. 入口链接

- 阅读入口与权威来源表：[README.md](README.md)
- 当前状态：[status.md](status.md) / [status.json](status.json)
- 架构：[architecture.md](architecture.md) ｜ 安全：[security.md](security.md) ｜ 运维：[operations.md](operations.md)
- 决策：[decisions/](decisions/README.md) ｜ 活设计：[design/](design/) ｜ 历史：[archive/](archive/README.md)

## 3. 试点闸门取数命令

闸门是否关闭由 `goNoGo()` 自己打印，不在正文维护活数字。仓库根执行：

```bash
node --input-type=module -e "const p='./docs/plan/assets/work-r0a-ops-2026-10-25/',fs=await import('node:fs'),o=await import(p+'ops-model.mjs'),c=JSON.parse(fs.readFileSync(p+'pilot-checklist.json','utf8')),s=JSON.parse(fs.readFileSync(p+'slo-pilot.json','utf8')),g=o.goNoGo(c,s);console.log('go='+g.go,'blocker='+g.blockerCount,'start='+g.startBlockerCount,'pilot='+g.pilotBlockerCount,'scale='+g.scaleBlockerCount,'measurement='+g.measurementBlockerCount,'slo='+g.sloMeasuredCount+'/'+g.sloMetricCount,'residual='+g.residualCount,'unstatedReopen='+g.unstatedReopenCount)"
```

当前读数与解读见 [status.md](status.md)（机器来源 [status.json](status.json)），用上面命令现取，不在本桩手抄活数字。闸门绿≠已试点，也≠残口为零。

## 4. 开放裁定卡片（活义务）

> 卡片全文与代价见[归档快照](archive/work-project-full-2026-11-14.md) §5.0。此处只留当前裁定与状态；复评窗未到的卡片不归档。

**卡片 V｜work-api 启动链尾闸（＝甲）**：仓库面已落（`work-chain-check.service` 同伴 root 单元＋`work-migrate status -require-up-to-date`＋`work-api.service` 的 `Requires=`/`After=`）。**现网未闭合**：现网 work-api 仍跑没有 `Requires=` 的旧 unit；生效需那笔单独的 rollout 授权。

**卡片 W｜发布闭包与安装名（＝分两组）**：仓库面已落（make-release 闭包＋verify 逐名报 present/MISSING＋work-api.service 安装步骤）。content-backup 三件按丙执行，执行边界（不得读宽）：三处名单未同批改完前不执行删除。**现网生效属生产写授权**，未执行。

**卡片 X｜#119（blocking_operations 视图口径）＝丙**：`blocking_operations` 视图按 latest run 判定，而 `reserved_tokens`/`settled_tokens`/`task_has_blocking_operation` 按全 run 判定；可达性现读判为不可达（状态转移无 terminal-out，写路径复检宽谓词，拒绝码 `run_not_quiescent`）。属潜在陷阱、非现网缺陷。裁定＝只声明不修，默认演进路径记为乙（保留 badge 另加全 run 列）。裁定前不改视图、不加列、不动 SQL 拒绝语义。

**卡片 Y｜#120（工作负载证书寿命/撤销）＝②丙／①不做续期／③825 与 3650 定为 pilot 用值**：仓库面已落（`work-authz` 指纹名单热加载 `RegistryStore`，撤销＝改 `workloads.json`）。**前置 d 未做**：未换二进制、未重启 work-authz，现网仍跑启动期一次性读的旧二进制 ⇒ 不得读成"现网撤销面已成立"。

**卡片 G｜#94（content:// 引用 URI 口径）＝G3**：已于 2026-11-07 整条执行完（口径＋双方向具名用例＋扫描集进 CI）。

**卡片 #96（C16 日志扫描散文盲区）＝甲**：不动规则，门即交付物。规则下限 12 个非空白字符是已知局限（2026-11-08 主签接受），覆盖面由 `c16-content-coverage.test.mjs` 看守（现读抓 1／10）；复评窗 **2026-11-20**，机械触发（src/work 出现带正文键名的 `key=%s` 日志）红了再重裁。

## 5. 0040–0043 rollout 前置（只读取数）

rollout 定序＝甲（整包一次上，链尾 39→43），**不含执行授权**；执行前三道闸：工作树脏（须先 commit）、卡片 Y 前置 d 与本次 rollout 同门、同二进制重放预检未做。只读前置取数脚本（仓库内，主机侧只读执行、跑完即删）：

- `docs/plan/assets/work-r0a-ops-2026-10-25/preflight/rollout-preflight-ledger-read.sh`
- `docs/plan/assets/work-r0a-ops-2026-10-25/preflight/rollout-preflight-package-shape-read.sh`

取数命令形状（判据取脚本自身退出码 `HOST_SCRIPT_RC=0`）：

```bash
ssh -i ~/.ssh/id_ed25519 -o BatchMode=yes johnshao@<work-ecs> 'cat > /var/tmp/pf.sh && sed -i "s/\r$//" /var/tmp/pf.sh && sudo -S -p "" bash /var/tmp/pf.sh < ~/sudo-pass.txt; rc=$?; rm -f /var/tmp/pf.sh; echo HOST_SCRIPT_RC=$rc' < docs/plan/assets/work-r0a-ops-2026-10-25/preflight/rollout-preflight-ledger-read.sh
```

2026-11-13 只读现读：`tip_version=39`、`ledger_rows=39`、`open_runs=1`（`active=1`）、`held_reservations=1`、`outbox_pending=0`、`RELEASE_DIRTY=0`、`package_migrations_dir=ABSENT`；最新包 work-release-0039（在装件逐字节 SAME），已装 work-migrate 内嵌 0038/0039 而对 0040–0043 零命中（必须先出链尾 43 的新包）。详见[归档快照](archive/work-project-full-2026-11-14.md) §9 批 C 第三格。

## 6. 维护规则

- 本桩只留当前状态与开放裁定；过程快照即写即归档（[archive/](archive/README.md)），不在活文档累积。
- 数字必须来自实际运行（`goNoGo()`、ci-contract、ops 门），标注日期；不手抄活数字、不写"原文保留／同日更正"层叠。
- 新增 Work 文档默认拒绝：须说明"代码为何表达不了"，否则进台账或归档。
- 行尾 LF。