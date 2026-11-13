# Work 当前状态

> 本文渲染 [status.json](status.json)，不手工维护"当前值＋历史值＋更正值"。动态闸门读数用下面的命令现取；历史读数见 [archive/](archive/README.md)。最近核实：**2026-11-14**。

## 一览

| 项 | 值 |
|---|---|
| 阶段 | R0a（云端主场景） |
| 实现 | R0a 已部署试点环境；R0b 实现部分开始 |
| 已部署 | 是（发布包 `work-release-0039`） |
| 迁移台账 | 现网 tip=39；仓库 tip=43（0040–0043 未 rollout） |
| Runtime 已验证 | 否（生产无容器隔离，sandboxProof=false；真实供应商 E2E 未跑） |
| 外部安全审计 | 未执行 |
| 允许真实客户数据 | **否**（仅演示组织＋演示数据；接入前须外部审计 J39） |
| 试点已开始 | 否（E8 未执行） |
| Content Store | 本地 pilot 已上线，零真实请求 |
| 云 KMS | 未接（静态单层加密，范围例外 D-03 B） |

## 试点 go/no-go（机器判据）

闸门是否关闭由 `goNoGo()` 自己打印，不在正文维护活数字。仓库根执行：

```bash
node --input-type=module -e "const p='./docs/plan/assets/work-r0a-ops-2026-10-25/',fs=await import('node:fs'),o=await import(p+'ops-model.mjs'),c=JSON.parse(fs.readFileSync(p+'pilot-checklist.json','utf8')),s=JSON.parse(fs.readFileSync(p+'slo-pilot.json','utf8')),g=o.goNoGo(c,s);console.log('go='+g.go,'blocker='+g.blockerCount,'start='+g.startBlockerCount,'pilot='+g.pilotBlockerCount,'scale='+g.scaleBlockerCount,'measurement='+g.measurementBlockerCount,'slo='+g.sloMeasuredCount+'/'+g.sloMetricCount,'residual='+g.residualCount,'unstatedReopen='+g.unstatedReopenCount)"
```

**2026-11-14 快照**：`go=false blocker=1 start=0 pilot=0 scale=0 measurement=1 slo=0/12 residual=32 unstatedReopen=7`。

读法：三档桶（start/pilot/scale）全空（33 项＝29 done＋4 waived）；红只来自测量面——C17 声明 `requiresMeasuredSlo`，而 12 条 SLO 全 `not_measured`。任一指标带证据翻 `met`/`missed` 即机械回绿。**闸门绿≠已试点**，也≠残口为零（见快照 residual）。

## 当前阻断项

- **SLO 实测（C17）**：12 条指标未测量，闸门因此翻红。
- **外部安全审计（J39）**：接真实客户数据的前置，未执行。
- **Runtime 沙箱隔离**：生产无容器隔离，需真实隔离/网络/资源证据。
- **真实供应商 E2E**：仅一次 Qwen smoke。
- **真实 Content Store 验证**：本地实现零真实请求；重加密/留存清扫未实现。
- **云 KMS 重开条件**：静态单层是范围例外，接触客户数据须重开。
- **0040–0043 rollout 授权**：需窗口当场生产写确认＋同二进制重放预检。

## 入口

- 架构：[architecture.md](architecture.md)
- 安全：[security.md](security.md)
- 运维：[operations.md](operations.md)
- 决策：[decisions/](decisions/README.md)
- 项目状态桩与开放裁定：[work-project.md](work-project.md)