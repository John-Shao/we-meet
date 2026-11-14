# Work 开放裁定（活义务）

> 本文件是开放裁定的**存活载体**：已裁但待生产执行、或复评窗未到的裁定。从 work-project.md 迁出，使项目索引纯化。
> 卡片全文与历史代价见 [归档快照](../archive/work-project-full-2026-11-14.md) §5.0；复评窗未到的卡片不归档。
> 多个 CI 门禁钉住本文件的卡片锚点（V/W/X 与 C16 局限声明）——改卡片标题或关键措辞须同步门禁。

**卡片 V｜work-api 启动链尾闸（＝甲）**：仓库面已落（`work-chain-check.service` 同伴 root 单元＋`work-migrate status -require-up-to-date`＋`work-api.service` 的 `Requires=`/`After=`）。**现网未闭合**：现网 work-api 仍跑没有 `Requires=` 的旧 unit；生效需那笔单独的 rollout 授权。

**卡片 W｜发布闭包与安装名（＝分两组）**：仓库面已落（make-release 闭包＋verify 逐名报 present/MISSING＋work-api.service 安装步骤）。content-backup 三件按丙执行，执行边界（不得读宽）：三处名单未同批改完前不执行删除。**现网生效属生产写授权**，未执行。

**卡片 X｜#119（blocking_operations 视图口径）＝丙**：`blocking_operations` 视图按 latest run 判定，而 `reserved_tokens`/`settled_tokens`/`task_has_blocking_operation` 按全 run 判定；可达性现读判为不可达（状态转移无 terminal-out，写路径复检宽谓词，拒绝码 `run_not_quiescent`）。属潜在陷阱、非现网缺陷。裁定＝只声明不修，默认演进路径记为乙（保留 badge 另加全 run 列）。裁定前不改视图、不加列、不动 SQL 拒绝语义。

**卡片 Y｜#120（工作负载证书寿命/撤销）＝②丙／①不做续期／③825 与 3650 定为 pilot 用值**：仓库面已落（`work-authz` 指纹名单热加载 `RegistryStore`，撤销＝改 `workloads.json`）。**前置 d 未做**：未换二进制、未重启 work-authz，现网仍跑启动期一次性读的旧二进制 ⇒ 不得读成"现网撤销面已成立"。

**卡片 G｜#94（content:// 引用 URI 口径）＝G3**：已于 2026-11-07 整条执行完（口径＋双方向具名用例＋扫描集进 CI）。

**卡片 #96（C16 日志扫描散文盲区）＝甲**：不动规则，门即交付物。规则下限 12 个非空白字符是已知局限（2026-11-08 主签接受），覆盖面由 `c16-content-coverage.test.mjs` 看守（现读抓 1／10）；复评窗 **2026-11-20**，机械触发（src/work 出现带正文键名的 `key=%s` 日志）红了再重裁。