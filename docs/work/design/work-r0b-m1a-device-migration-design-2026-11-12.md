# Work R0b M1a 设备侧 migration 设计单（已实现基线指针＋仍活义务）

> 【2026-11-16 按章节收敛】M1a 四批（0040–0043）与 M1b 本机审批读／采纳面（0044／0045）已落仓库，详细设计权威自此是**代码、迁移、契约、测试**，不再是本文 prose。设计单**全文逐字快照**已移入 [archive/design-baseline/](../archive/design-baseline/work-r0b-m1a-device-migration-design-2026-11-12.md)（原文不删不改 prose，仅按新位置调整相对链接）。本文只保留**仍活的义务与开放裁定**（§5.F／§10／§11／§16.6／§17.10，逐字保留、编号沿用原 §）与章节索引——归档不得隐藏活义务，故这几节留在活文档。
>
> 本文不是安全放行：未经外部独立安全复核，不得称「经独立复核／审计通过」（J39）。当前状态与 rollout 范围见 [status.json](../status.json)。

## 0. 已实现范围与权威来源

| 内容 | 权威来源 |
|---|---|
| M1a 表族与域命令（0040–0043） | `src/work/migrations/increments/` ＋ `src/work/internal/migrate/` 测试 |
| M1b 本机审批读／采纳 REST 面（0044／0045） | 同上 ＋ `src/work/internal/api/` handler 与 PG 用例 |
| 设备签名验真与服务端网关（0046–0049，M3 线） | `src/work/internal/gateway/` ＋ `src/work/internal/devicesig/` ＋ `src/device/` |
| 错误码 | `src/work/contracts/error-codes.json` ＋ `src/work/internal/apierr/` 测试 |
| 当前状态／已裁 rollout 包范围 | [status.json](../status.json)（包＝0040–0045／39→45；0046 起属 M3 线，未裁 rollout） |

## 0.1 章节索引（原 § → 现位置）

| 原章节 | 现位置 |
|---|---|
| §1 范围与不做 ／ §2 现读基线 ／ §3 命名与范围对账 | 归档快照 |
| §4 表族总览 ／ §5 逐表规格 | 归档快照（**§5.F 延后一张仍活，见本文**） |
| §6 域命令签名／shape／幂等键 ／ §7 与 Rust agent shape 对照 | 归档快照 |
| §8 四条继承债 ／ §9 落笔分批建议 | 归档快照 |
| §10 待裁项 | **本文（仍活：唯一开放项 O-19）** |
| §11 边界与复评 | **本文（仍活）** |
| §12 批一补充设计 ／ §13 批一落笔实录 | 归档快照 |
| §14 批二补充设计 ／ §15 批三补充设计 | 归档快照 |
| §16 批三落笔实录 | 归档快照（**§16.6 未测控制穷举仍活，见本文**） |
| §17 批四补充设计 | 归档快照（**§17.10 批四不做与重开条件仍活，见本文**） |
| §18 批四落笔实录 | 归档快照 |

引用口径：冻结增量（0040–0043）注释与既有台账里的「M1a 设计单 §N」引用照旧解析——仍活五节在本文，其余节在归档快照的同名 § 下（快照逐字保留原编号）。

## 仍活义务与开放裁定（逐字保留）

### 5.F 延后一张：`work.work_run_classification`

控制面 §4.1 有该行（`(org_id,task_id)`、`task_kind=user_task/configuration_probe`、`probe_id?`），用途是把配置探测任务与普通任务分列授权与过滤。**六个域命令都不读它**，它服务的是 R0a 供应商探测线（0024 `provider_probe_grant`）。M1a **不建**，理由＝写者与读者都不在本期；登记为 §10 的 O-8（若主签要求 M1a 一次落齐 §4.1 全部设备侧行，则它随 0043 落，代价是多一张无本期消费者的表，会撞 :142 的 `want` 串）。


## 10. 待裁项（本文不自决，逐条带原文与代价）

**【2026-11-12 状态更新】O-1／O-2／O-3 已由主签同日逐项单选裁完＝卡片 P-a／Q-a／R-a（台账 §5.0 三张卡各自记依据与代价），下表三行原文保留、就地加已裁标注。其余 O-4–O-12 共 9 项仍待裁，属非阻断的实现细节，落笔时逐项裁；O-12 决定其余 14 个命令的 shape 何时补。**

**【2026-11-12 二次更新：O-11／O-12 已裁，新增 O-13】**主签再逐项单选 **O-12＝甲**（每批落笔前补该批 shape）与 **O-11＝丙**（批一先单独落，余批再定序）。按甲已产出 **§12 批一补充设计**（11 个命令的完整 shape）。写 shape 时现读又查出一处阻断缺口＝**O-13**（device-session ticket 的载体无表，铸票在 hello 之前而 session 行尚不存在）。⇒ **本表现状：已裁 5 项（O-1／O-2／O-3／O-11／O-12），仍开放 8 项（O-4–O-10 与 O-13），合计 13 项**；其中**只有 O-13 阻断批一**，O-4–O-10 分别属批二／三／四。取数法＝数下表以「O-」起头的行，未入 doc-derived-counts 门禁，增删项时须重数并更新日期。

**【2026-11-12 三次更新：O-13 已裁＝乙（卡片 S-b），批一阻断清空】⇒ 本表现状：合计 13 项、已裁 6 项（O-1／O-2／O-3／O-11／O-12／O-13）、仍开放 7 项（O-4–O-10），且开放的 7 项全部属批二／三／四，**批一已无待裁前置**。上面两条状态标注里的「已裁 5／开放 8」与「只有 O-13 阻断批一」均以本条为准，原文保留。

**【2026-11-12 四次更新：批三前置四项＋动作载体已裁，本表只剩 2 项开放】**主签在「批三开工」同日逐项单选 **O-5＝甲**（`device_dispatch.execution_id` 留列不写）、**O-6＝甲**（`reason_code` 只列设备侧七值，取消原因落 `work.run.terminal_reason`）、**O-9＝甲**（不给 `operation` 加 `prepare_id`，幂等权威仍是 `logical_key`＋`request_hash`）、**O-10＝甲**（attestation 两键换表读／`journal_unavailable` 保留／`seal_checked` 删除），另裁**动作引用载体＝丙**（新建 `work.local_action`，批三由 3 张变 4 张）——依据与代价见 **§15 抬头两段**，下表四行已就地加已裁标注（原文保留）。⇒ **本表现状：合计 13 项、已裁 11 项（O-1／O-2／O-3／O-4／O-5／O-6／O-9／O-10／O-11／O-12／O-13）、仍开放 2 项（O-7／O-8），两项均属批四**；**批三已无待裁前置**。上面三条状态标注里的「已裁 5／开放 8」「已裁 6／开放 7」均以本条为准。取数法＝数下表以「O-」起头的行（13），已裁＝行内含「已裁＝」标注者（11）。

**【2026-11-12 表数现读更正（附取数法，本条为权威值）】M1a 总表数＝15**（不含 §5.F 延后的 `work.work_run_classification`；含它＝16）。取数法＝§5 的表规格小节 5.A1–A4／B1–B2／C1–C3／D1–D3／E1–E2 共 **14** 张＋§15 丙新增 `work.local_action` **1** 张；**已落地 10 张**（`grep -c '^CREATE TABLE' src/work/migrations/increments/0040_device_identity_and_workspace_grants.sql`＝9、`…/0041_local_run_orchestration.sql`＝1），**余 5 张**＝批三 4（`device_dispatch`／`device_receipt`／`device_run_finish`／`local_action`）＋批四 1（`artifact_replica`）。**台账卡片 T 那句「总表数由 14 变 17」是误计**：17 既不等于它自己括号里的和（9＋1＋4＋1＝15），括号里的「批三 4」也是卡片 T 之前的旧分批（`readonly_approval_grant` 已按 T 移入批一，T 之后＋丙之前应为 9＋1＋3＋1＝14）。凡写「17」处以本条为准，原文保留不删。

**【2026-11-12 五次更新：批三落笔前又查出三处「已签规则缺载体」，逐项单选后本表扩到 16 项】**主签在「再处理 2. 批三 0042」同日逐项单选 **O-14＝甲**（配额由调用方预留、命令只复验）、**O-15＝甲**（`approval_decision` 加可空 `nonce` 列＋部分唯一索引）、**O-16＝甲**（本批定义 `final_operation_set_hash` 的显式有序公式并跨侧传播），三条的原文依据、落地与代价见 **§16.1**。⇒ **本表现状：合计 16 项、已裁 14 项、仍开放 2 项（O-7／O-8，均属批四）**；**批三已落笔为增量 0042**（实录见 §16）。上面四条状态标注里的「已裁 11／开放 2（合计 13）」以本条为准（开放项仍是同两个，合计与已裁数变了）。取数法＝数下表以「O-」起头的行（16），已裁＝行内含「已裁＝」标注者（14）。**表数不变＝15**（O-15 是给已上线表加列，不新增表；O-14／O-16 各不新增表）。

**【2026-11-12 六次更新：批四落笔前裁四项、登记三项，本表现状见下】**主签在「裁 O-7／O-8 开批四」同日逐项单选 **O-7＝甲**、**O-8＝甲**、**O-17＝乙**、**O-18＝丙**（四项裁定的原文依据、落地方式与已付代价统一见 **§17.1**）。O-17／O-18 是批四落笔前现读查出的两处「已签规则缺载体／已签文本与生效体不符」，随本节登记；写 shape 时又查出第三处＝**O-19**（用户保存路径的 `local_ref` 在签名域内没有载体），已按「proof 域外无签名标量入参」落笔并把三种被否方案记进行内，**属非阻断**（不决定 0043 能否落地，只决定该列将来是否升级为签名字段）。⇒ **本表现状：合计 19 项、已裁 18 项、仍开放 1 项＝O-19**。上一条（五次更新）里的「合计 16 项、已裁 14 项、仍开放 2 项（O-7／O-8）」以本条为准（那两项现已裁完，新增三项）。取数法＝数下表以「O-」起头的行（19），已裁＝行内含「已裁＝」标注者（18），开放＝无该标注者（1）。**表数同步更正＝16**：O-17＝乙 新增 `work.consumed_possession_nonce`（§17.3），M1a 总表数 15→16（不含 §5.F 延后那张，含它＝17）；「已落地」现读＝**14**（`grep -c '^CREATE TABLE'` 于 `0040*.sql`＝9＋`0041*.sql`＝1＋`0042*.sql`＝4），**批四余 2 张**＝`artifact_replica`＋`consumed_possession_nonce`。上文「表数现读更正」段的「总表数＝15、已落地 10、余 5」以本条为准，原文保留不删。

**【2026-11-12 七次更新：批四已落笔为增量 0043，本表现状与 M1a 表数同时收口】**主签指令「裁 O-7／O-8 开批四」之后，`0043_local_artifact_replica_finalize` 已本地落地（**实录见 §18**，四栽原文与代价见 §17.1，逐条落地证据见 §18.1–§18.4）。⇒ **本表现状：合计 19 项、已裁 18 项、仍开放 1 项＝O-19**（用户保存路径 `local_ref` 的签名字段化，属 M1b／I4 重建 proof 帧时一并裁，不阻断 M1a 任何一批）。取数法（现读，两条都要跑）＝`awk '/^## 10\./,/^## 11\./' 本文件 | grep -c '^| O-'`＝**19**、其中含「已裁＝」标注者 **18**；全文 `grep -c '^| O-'`＝**23** 是多计了 §17 抬头那张四行裁定表（它重复 O-7／O-8／O-17／O-18 四行，不是新项），凡引用 23 处以 19 为准。**表数同步收口＝总 16、已落地 16**：`grep -c '^CREATE TABLE'` 于 `0040*.sql`＝9＋`0041*.sql`＝1＋`0042*.sql`＝4＋`0043*.sql`＝2＝**16**，与上一条的「总表数 15→16、批四余 2 张」相加一致，M1a 四批的表已全部落地；含 §5.F 那张延后表则总 17。**批次状态自此＝批一＋批二＋批三＋批四已实现，M1a 的 migration 面没有余下批次**。外部正证到手＝head_sha `9a2f2488ddca780aed7de504a249d2801b8406f0` 三笔 workflow（Work R0a gates／meet Workflow／Release guard）全 completed／success；**半径仍是 migration＋换二进制：现网台账仍 39，0040–0043 一律未 rollout**，rollout 定序仍按 O-11＝丙 待主签单选。上一条的「已落地 14、批四余 2 张」在批四落笔后由本条顶替，原文保留不删。

| 号 | 主题 | 原文／现读依据 | 选项与代价 |
|---|---|---|---|
| O-1 | 表清单按 §3 对账后口径确认（不建 `local_operation`／`operation_journal`／`device_permit`，`device_lease` 改名 `execution_lease`） | 偏移 1–3 逐条原文 | **甲＝按本文对账**（代价＝设备计划 §4 要加带日期更正标注，原文保留）／乙＝照设备计划字面建四张表（代价＝与 control §4.1 权威冲突、造出第二个单次性权威、0021 注释指向不存在的表） **【2026-11-12 已裁＝甲，卡片 P-a】**13 张表、租约表名 `execution_lease`、不建三张误读表；设备计划 §4／§8 已加带日期标注，原文保留 |
| O-2 | `consume_device_ack` 与 `record_device_model_result` 的归属 | 偏移 4–5 逐条原文 | **甲＝ack 进 M1a（第七命令）、model_result 延后 I5**／乙＝两者都真砍（代价＝`operation_resolution` 三列成无主列；`device_local` 用量写不进账本，与 E=B 保留本机推理冲突） **【2026-11-12 已裁＝甲，卡片 Q-a】**ack 进 M1a 当第七命令；`record_device_model_result` 与 `device_adapter` 延后 I5，M1a 不扩闭集。**附带验收边界见 §11**：M1a 阶段本机用量不计量、EV114 不在 M1a 证据门内 |
| O-3 | 是否新增设备网关专用组角色 | §2.2 三处角色定义＋:47 `want` 串；架构 I2/I7「文档里有角色但没人能发凭据」 | **甲＝不新增，复用 `work_api`／`work_worker`**（代价＝gateway 与 worker 同身份，靠 allowlist 与 NetworkPolicy 分隔）／乙＝新增 `work_device`（代价＝三处同改＋:47 串变＋凭据签发/轮换/撤销/告警归属都要落，属 I7 半径） **【2026-11-12 已裁＝甲，卡片 R-a】**不新增组角色，:47 与 :142 两串都不变、三处角色定义一处不动；**部署清单必须写明「独立工作负载身份≠新 PG 组角色」**，见 §6.7。重开条件＝I4 真建 gateway 时按乙重议 |
| O-4 | `device_run_binding.grant_set` 用受校验 jsonb 还是另建子表 | §5.C1；0020 helper 先例 | **甲＝jsonb＋helper**（代价＝反查要展开 JSON）／乙＝子表（代价＝多一张表＋多一道锁，§4.1 未要求） **【2026-11-12 已裁＝甲】**`grant_set` 用受校验 jsonb＋`work.binding_grant_set_valid` helper（函数名现读 0040 原文核对），不建子表。裁定与批一表范围同批给出（台账卡片 T、本文 §13.1），**本行标注属同日传播补齐**——此前只记在卡片 T 与本节，未落到本表行内 |
| O-5 | `device_dispatch.execution_id` 留列不写还是删列 | §5.D1；B03 §3.1 对 `local_content.sync状态` 的同一手法 | **甲＝留列不写**（代价＝一列本期无写者）／乙＝删列（代价＝R0c 恢复 egress 时要再加回来，且 0021 已发布注释提到它） **【2026-11-12 已裁＝甲】**留列不写，本期无写者；`delivery_state` 五值闭集保留，只有 `not_applicable`／`superseded` 有写者（§15.4） |
| O-6 | `device_run_finish.reason_code` 是否扩取消路径词汇 | §5.D3；本机 §3.4 七值闭集 vs 控制面 §5 `approval_rejected` | **甲＝本期只列七值，取消路径 reason 落 `work.run.terminal_reason`**（代价＝两处词汇）／乙＝扩闭集（代价＝新值须同改本机 §3.4、控制面 §9 与 EV，属新增闭集成员，架构 §6.1 明禁单向加闸） **【2026-11-12 已裁＝甲】**本期只列设备侧七值，取消路径 reason 落 `work.run.terminal_reason`（§15.2 `decide_local_approval` 的 `approval_rejected`） |
| O-7 | `artifact_replica.state` 本期单值 `published` 是否可接受 | §5.E2；控制面 §4.1 未给值域 | **甲＝单值**（代价＝将来 cloud 支恢复时要扩）／乙＝现在定多值（代价＝造出没有写者的状态值，违「孤立状态」规矩） **【2026-11-12 已裁＝甲】**照 §5.E2 落 `CHECK (state IN ('published'))`，不造 `pending`／`failed`；已付代价写死：恢复 cloud 副本支时必须新增量 `DROP CONSTRAINT`＋`ADD`（CHECK 不可 `CREATE OR REPLACE`），落笔口径见 §17.2 |
| O-8 | `work_run_classification` 是否随 M1a 落 | §5.F | **甲＝延后**（代价＝§4.1 设备侧行未一次落齐）／乙＝随批四落（代价＝无本期消费者，撞 :142 `want` 串） **【2026-11-12 已裁＝甲】**0043 **不建**该表；控制面 §4.1 的设备侧行清单本期保持少一行（带日期更正属批四传播，§17.10）。判据＝§9 写者闭合：落一张「注册了没人写」的表正是 `:147` 那条 `want` 串要拦的事，行内原写的 `:142` 属行号漂移，现读见 §17.9 |
| O-9 | `prepare_id` 是否需要在 `operation` 上加列做服务端去重 | §6.1；控制面 §4.1 幂等权威是 logical_key＋hash | **甲＝不加列**（代价＝设备必须保证同 prepare_id 映射同 logical_key）／乙＝加列（代价＝改既有已上线表＋新唯一键＋全链重放） **【2026-11-12 已裁＝甲】**不加列；设备必须保证同 `prepare_id` 映射同 `logical_key`，服务端幂等权威仍是 `logical_key`＋`request_hash`（§15 抬头） |
| O-10 | 0021 四个 attestation 键的处置（`journal_unavailable` 换不了、`seal_checked` 必须删） | §8 债 4 逐键原文 | **甲＝两键换表读、`journal_unavailable` 保留 attestation、`seal_checked` 删除**（代价＝已签文本「I4 落表后应替换为表读并把断言键删掉」要加带日期更正）／乙＝四键全保留（代价＝`seal_checked` 指向一张永不存在的表，降级裁决可被空断言过闸） **【2026-11-12 已裁＝甲】**`lease_or_revocation_checked` 换读 `execution_lease`＋`device.status`、`device_unreachable` 换读 `device_session`、`journal_unavailable` 保留 attestation、`seal_checked` 删除；重述落点＝批三 §15.3 第 2 条（按 #87 同句重述 `SECURITY DEFINER`＋`search_path`，保留 0021 其余全部判定） |
| O-11 | 四批是否同包 rollout、以及批一是否先单独裁 | §9；每批半径＝migration＋换二进制 | 主签单选定序；本文不预设 **【2026-11-12 已裁＝丙】**批一（0040）先单独落，批二–四等批一拿到外部正证后再定序；每批半径仍是 migration＋换二进制，是否同包届时另裁 **【2026-11-12 的"丙"回答的是落笔顺序；11-13 对"是否同包 rollout"这半句已裁＝甲（0040–0043 整包一次上，链尾 39→43），该单选不含执行授权；前置只读读数与执行前三道闸见 work-project.md §9 同日"批 C 第三格"行，原文逐字保留】** **【2026-11-14 再单选＝扩包到 0040–0045（链尾 39→45）：0044／0045 已落仓库、包未执行，按现读链尾重切，取代甲的包范围，甲原文逐字保留；仍不含执行授权】** |
| O-12 | 写者闭合所需的其余 14 个命令，其完整 JSON shape 何时补 | §9「shape 覆盖边界」；卡片 I 只点名六函数 | **甲＝每批落笔前补该批的 shape**（代价＝设计分四轮，但每轮都紧贴该批的表与守卫）／乙＝先出一份覆盖全部 21 个命令的补充设计单再落任何一批（代价＝一轮更大的设计工作，且批一的身份/授权面要等编排面定完才动，半径最小的那批被推迟） **【2026-11-12 已裁＝甲】**已产出 §12＝批一 11 个命令的完整 shape。**计数更正**：本行原写「其余 14 个／全部 21 个」，现读修正为**其余 19 个／全部 26 个**——§12.1 按 §1.4 端点逐行对账新增 5 个名（`confirm_device_pairing`／`mint_device_session_ticket`／`renew_device_certificate`／`list_devices`／`list_workspace_grants`）；取数法＝§6 的 7＋§9 原列 14＋§12.1 新增 5，未入 doc-derived-counts 门禁 |
| O-13 | **device-session ticket 的载体（阻断批一）** | 本机 §2.2「hello 另需由当前桌面身份换得的单次 device-session ticket（TTL 60s…云端只存 hash）」＋§1.4 `POST /devices/{id}/session-tickets` 在 hello **之前**铸票，而 `session_id` 由服务端在 hello 分配 ⇒ 本文 §5.A3 把 `ticket_hash` 放 `device_session` 上**顺序错了**（§12.2 更正 3） | **甲＝`device_pairing` 的 `purpose` 闭集扩为三值（pair／renew／session），三种一次性挑战共表**（代价＝表名与内容不符，session ticket 不是 pairing，须在控制面 §4.1 加带日期更正说明该表是「设备一次性挑战」载体；好处＝表数保持 13、不新增 catalog 面）／**乙＝新建 `work.device_session_ticket`，照 0024 `provider_probe_grant` 的一次性 token 形**（代价＝表数 13→14，超出卡片 P-a 确认的 13 张，须同批更正计数＋多一份 catalog＋全链重放；好处＝名字与语义一致、票据证据独立、`device_pairing` 不被撑成杂物表）／丙＝`device` 上单槽 `pending_ticket_hash`＋`pending_ticket_expires_at`（代价＝同设备只能有一张未消费票据，第二次 mint 覆盖第一次即丢证据，且 `device` 多三列可变状态；好处＝零新表零新列于挑战表） **【2026-11-12 已裁＝乙，卡片 S-b】**新建 `work.device_session_ticket`，规格见 §5.A4；表数 **13→14**、批一 **5→6 张**；`device_session.ticket_hash` 由 `session_ticket_id`（FK）取代；§12.6／§12.8 写集已补齐，**批一阻断解除**。代价已付＝本文与台账凡写 13 张处同批加带日期更正（原文保留） |
| O-14 | **`prepare_local_operation` 的配额账户载体（阻断批三）** | §6.1 的 `p_action` 闭合键集 20 键无 `account_key`／`period_id`，而既有 `reserve_quota` 必须传这两值；云端取自部署配置（`runflow/activities.go:929`／`:953`），SQL definer 读不到。控制面 §4.2 该行只写拒绝时「不预留配额」 | **甲＝调用方预留、命令只复验**（代价＝M1b／I4 必须补调用方，本批写集去掉 `quota_reservation`；好处＝不改已签帧、不造第二套账户约定）／乙＝`p_action` 加两键（代价＝改已签本机 §3.1 帧，且设备侧能影响记账账户，须另加白名单）／丙＝SQL 按既有默认约定推导并自建账户（代价＝把部署配置变成 SQL 内硬约定，自建账户的 limit／enforcement 是新语义） **【2026-11-12 已裁＝甲】**落地与复验谓词见 §16.1／§16.2；`consume_device_permit` 的最新预留非 `held`／`unknown` 即 `quota_reservation_not_held` |
| O-15 | **`decide_local_approval` 的 nonce 单次消费载体（阻断批三）** | 本机 §4.3 原文「服务端对HTTP字段逐项与proof比较并**原子消费nonce**」，而 `approval_decision` 只有七列无 nonce，全库亦无一次性 nonce 表 | **甲＝`approval_decision` 加可空 `nonce` 列＋部分唯一索引**（代价＝改 R0a 已上线表，纯加列、R0a 路径留 NULL 行为不变；好处＝单次性权威与决定事实同表同事务、零新表）／乙＝新建一次性 nonce 表（代价＝表数 15→16、多一份 catalog 面，与 O-13＝S-b 取舍同向）／丙＝用 `audit_event.metadata` 承担（代价＝把单次性权威放进审计表，违「审计是事实记录不是权威」的既有分工） **【2026-11-12 已裁＝甲】**索引＝`work_approval_decision_nonce_once (org_id, nonce) WHERE nonce IS NOT NULL`；跨审批单次消费由 `r0b_actions_test.go` 的第二个 pending 审批负例钉住 |
| O-16 | **`final_operation_set_hash` 的重算公式（阻断批三，跨侧合同）** | 控制面 §6.4 第 3 条只写「等于服务端按本 Run 的 Operation id/state/result hash 重算的值」；`device_checkpoint.pending_operation_set_hash` 是设备自报、0041 只校格式，库里无任何公式 | **甲＝本批定义显式有序公式＋跨侧传播**（代价＝新定义一条跨侧合同，M3 的 Rust agent 必须照此实现；好处＝`finish_state_mismatch` 真有判别力）／乙＝只校格式＋与自报值相等（代价＝第 3 条核心判据空转，服务端不再独立重算）／丙＝用 PG `jsonb_agg::text` 规范化（代价＝设备侧要复刻 PG 的键序规则而非通用 canonical JSON，更易漂） **【2026-11-12 已裁＝甲】**公式＝本 Run 全部 Operation（含被取代者）、按 `operation_id::text` 升序、元素 `{"operation_id":"…","state":"…","result_hash":"…"}`、`result_hash` 取最新 completed 回执值（无则空串）、`sha256_text('[' ‖ join(',') ‖ ']')`；落点＝`work.local_operation_set_hash`，传播见 §16.1 |
| O-17 | **`rebind_run_workspace` 的 nonce 从未被消费（§12.12 第④条与已上线生效体不符）** | §12.12 判定顺序第④条原文「验签＋**原子消费 nonce**」；现读 `0041:646-833` 的生效体只判 `nonce IS NULL`、把原值写进审计 metadata，全库没有任何单次性载体 ⇒ 重放同一 proof、换一个新 `client_request_id` 就能第二次改绑 | **甲＝记债不修**（代价＝§12.12 第④条继续是假陈述，改绑面留一条可重放的 possession proof）／**乙＝新建通用一次性 nonce 表并同批重述 rebind 补上消费**（代价＝表数 15→16、一条已上线命令行为收紧：同 `client_request_id` 的重放仍走幂等早退分支返回原结果，只有**换 request_id 复用 nonce** 的第二笔从成功变拒绝）／丙＝复用 0042 的 `approval_decision.nonce` 部分唯一索引（代价＝审批决定表承担非审批域的 nonce，三个签名域挤进同一列，违控制面 §1.2「不复用其他签名域」） **【2026-11-12 已裁＝乙】**表＝`work.consumed_possession_nonce`（§17.3），`purpose` 闭集 `user_version`／`workspace_rebind` 两值在 0043 内各有写者；重述落点＝§17.7（只插入消费块，0041 其余判定逐字保留） |
| O-18 | **`finalize_local_artifact` 的静止门槛按 Task 级还是本 Run 判定** | 控制面 §9:586 行写「`run_not_quiescent`＝采纳/新 Run 准入与 `finalize_local_artifact` 静止条件」、:606 行把 `acceptance_blocked_unresolvable` 也归给 finalize；而 §6.4 第 4 条原文是「阻塞判定**按本 Run 计算，不复用 task 级** `task_has_blocking_operation`」，Task 级判定「保留但只用于新 Run 准入与采纳门槛」 | **甲＝复用 Task 级 `run_not_quiescent`**（代价＝本 Run 可收尾、但 Task 里另有未账动作时成果发布被无关动作锁死，正面撞 §6.4 第 4 条）／乙＝两道都查（代价＝同甲，且把采纳门槛塞进 worker 命令）／**丙＝只查本 Run 无 `unknown`／`unresolved`，复用批三同一谓词与同一拒绝码 `run_has_unreconciled_operation`**（代价＝§9:586／:606 两行归属要加带日期就地更正、原文保留；好处＝**零新增拒绝码**、与 0042 已落地的两个强制点同形） **【2026-11-12 已裁＝丙】**落地＝§17.5 判定顺序第 6 条；:606 那行的更正顺带记一件事——采纳门槛已由 0021 的 `work.acceptance` `BEFORE INSERT` 触发器兜住，本批**不产生新拒绝** |
| O-19 | **用户保存路径的 `local_ref` 载体（批四写 shape 时发现，不阻断落笔）** | `UserVersionProof` 的闭合 21 键（控制面 §1.2:31）里**没有** `local_ref`，本机 §7.5 六步里也没有 receipt；而 0017 的 `artifact_version_location_shape`（:210-214）要求每个 `local_only` 版本 `local_ref IS NOT NULL` ⇒ 服务端要么拒落该版本，要么接受一个签名域外的指针 | **落笔已按甲执行＝proof 域外的无签名标量入参 `p_local_ref text`**（代价＝该列是客户端自报、服务端无法验真的指针，与 agent 路径不对称——后者有 `device_receipt.local_result_ref` 可对；好处＝已签键集一字不减，且去重 `request_hash` 把它折进去，改指针必换 hash）／乙＝给 `UserVersionProof` 加第 22 键（代价＝改已签跨侧合同帧，须同批改控制面 §1.2 与本机 §7.5 两处闭集＋设备侧实现；M3 未开工正是低成本窗口）／丙＝用户保存不写 `local_ref`（直接违反 0017 已上线 CHECK，落不进去）／丁＝服务端按本机 §7.1 的路径约定自行合成（代价＝自造一条无签名的跨侧合同，且用户保存的目录本来不在 Run 授权集内）。**重开条件**＝M1b 接 Bearer 面、设备侧统一重建 proof 帧时按乙把该键并入签名域并删掉入参，届时要连 `local_ref` 的可验真路径（谁写、写在哪个卷、与 `device_receipt` 的关系）一起定 **【2026-11-14 主签复核＝维持开放、留待 M3 重建 proof 帧时按乙一并裁：M1b Bearer 面已落仓库，但设备侧统一重建 proof 帧属 M3（未开工），可验真路径需 M3 上下文；本次不改跨侧帧、不删 `p_local_ref` 入参，O-19 仍为 §10 唯一开放项】** |

**另需传播的活指令**（裁定后同批扫，不静默改）：设备计划 §4 M1a 表族清单与「六函数」句、§8 待开卡表的「M1a migration 表清单细化」行、work-project.md 卡片 I 与 §5.1 的 M1a 开工行、架构 §6 I4 行（`device_run_seal`／`issue_run_seal` 已移出但 I4 描述仍含它们）、控制面 §4.2 段末「I4 落表后应替换为表读」句。


## 11. 边界与复评

- 本文是**设计单**，不是实现，也不是安全放行。未经外部独立安全复核，不得称「经独立复核/审计通过」；主签复核结论起 **7 日延迟复评**。
- **另一道闸门与本裁定无关、仍然生效**：[安全与 Host 复核签收单](work-r0b-security-host-signoff-2026-10-31.md) 的自决闸门原文「第一批九项（S11/S3/S5/S6/S12/S13/S15/S10/S2）各自完成『自决结论＋延迟复评＋该条证据门槛』之前，R0b 不进入签收、**本机实现不开工**」，以及「**未复评完不开工**…这条约束不因自决而放宽」。I1 解除的是 21:1x 那道**排期冻结**的设计单部分，**不解除签收单那道安全闸门**；两道闸门口径不同、不得互相顶替，本文也不得被读成「实现可以开工」。
- **M1a 的验收边界（卡片 Q-a 的代价，必须随每批完成报告写明）**：`record_device_model_result` 与 `usage_source` 的 `device_adapter` 扩展延后到架构 I5，因此 **M1a 阶段 `device_local` 模型用量不计量**（无写者），预留按既有路径处置。任何 M1a 完成报告**不得声称「本机用量已计量」**；**EV114 不在 M1a 的证据门内**——架构 §6.1 原文把它排在 I5（「I5→EV63/EV102/EV114/EV118/EV121」）。落点＝§6.4 的「本期不做」那段与 §8 债 3；债 3 的状态自此是**已裁挂账到 I5**，不再是待裁。
- 本文不修订四份设计正文（任务 #6）、不改 EV 归属（任务 #43）、不动 `migrations/`、不动 `src/frontend/**`、不部署、不 push。
- 本文引用的行号均为 2026-11-12 现读注记，**以符号名为准**（J40=A）；落笔前须重读，行号会漂。
- 与卡片 E=B 的 B04/B09 移出决定、卡片 L=L2、J=J1、M=M-a、N=N-a 一致；不重开已裁范围。
- §10 任一项裁定后，按 memory `feedback-adjudication-propagation-sweep` 做传播扫（runbook／演练清单／README／脚本），就地加带日期标注、不删原文不删行，改后复跑文档门禁。


### 16.6 未测控制穷举（本批交付边界，**不得读成「批三已验完」**）

本批新增 5 个用例只覆盖下列六件事：载体写入与服务端分类、分类低报被拒、prepare 重放同 attempt、不变量 3 第一强制点零副作用、许可 jti 重放＋CAS 单次、finish 的 hash 不符拒绝＋不写终态＋rejected 留证＋重放、nonce 跨审批单次消费＋同 request_id 重放。**其余控制面已落地但无专用例**，逐条列出（取数法＝对照 0042 原文的分支与本批用例名，不是凭印象）：

| # | 未测控制 | 重开条件（要补什么才算闭环） |
|---|---|---|
| 1 | `prepare` 取代分支全部：两桶计数（主动 ≤5／`approval_expired` ≤3／`source_changed` ≤3／`resend_undelivered` ≤1／`reauthorized` 不限量）、reason↔`changed_fields` 配对、`workspace_rebound` 与 `reauthorized` 的互反判据、旧动作条件式终结＋`release_quota`＋旧 dispatch 标 `superseded`、`supersede_no` 递增、同一旧动作只能被取代一次 | EV71 的「全部拒绝且不建新 Operation」逐码断言（`supersede_not_allowed` vs `supersede_limit_exceeded` 分桶），＋一条主动桶第 6 次与被动桶第 4 次的正负对照 |
| 2 | (A) 目的地闸的「目的地在设备外」支 | 本期不可达（E=B），**需构造 `org_private`／`org_remote` 夹具**才能跑；R0c 恢复 egress 时必须补，否则该支永远只有代码没有证据 |
| 3 | `consume_device_permit` 的负例族：`scope_hash` 篡改、TTL >5s／超 lease、`aud` 不匹配、approval 非 approved、`quota_reservation_not_held` | 每条一个 `expectCode`，且 `scope_hash` 负例必须**构造上必然不同**（改一个字节），不能靠截时间 |
| 4 | `record_device_receipt` 全部：seq 连续性、同 seq 异 payload 冲突、`started` 不覆盖 `completed`（部分唯一索引）、旧 fence 仅核账、撤权设备拒收、completed→`issue_operation_resolution` 的终态与 resolution 行、两个水位推进 | 一批多元素夹具（含乱序与重放），断言 `recorded`／`conflicts` 两个数组与 `device_session.last_receipt_seq`／`execution_lease.last_receipt_seq` |
| 5 | `finish_local_run` 的 **accepted 正例**：`deliverable_versions` 必须是本 Run 已发布 local_only 版本、本 Run 阻塞门（与 task 级判定分别测）、`waiting(reconcile)` 两步走、`cancel_requested` 下 completed 拒／failed 转取消且**不覆盖 terminal_reason**、lease→released、binding→finished、readonly grant→invalidated、逐个 `revoke_runtime_execution` | 需先有批四的 `finalize_local_artifact` 或夹具直插 published local_only 版本；**「本 Run 可收尾而新 Run 准入被挡」必须两侧分别断言**（控制面 §6.4 第 4 条末句） |
| 6 | `finish_local_run_state` 的 canceled 直接调用面（控制面取消收尾路径） | 与 `request_security_cancel`／`consume_cancel_intent` 同批测 |
| 7 | `consume_device_ack` 全部：applied／journal_row_missing／conflict 三支、低 revision 不回退、**只写水位不写业务事实** | 断言 `operation_resolution` 的 state/code/settlement_state 在 ack 前后逐字不变 |
| 8 | `decide_local_approval` 的 remember 分支（插 grant、TTL＝min(24h, grant 到期, 申报值)、`tool_set` 越界拒、rejected 时 remember 必 false）、**rejected 终止整 Run**（`approval_rejected` 落 `run.terminal_reason`）、proof 与标量逐项不等的负例 | EV46/EV70 的「同类只读授权期内零新增审批行」需 remember 正例＋后续 prepare 命中；rejected 侧断言 Run 终态与原因未被覆盖 |
| 9 | `revoke_readonly_grant`／`list_readonly_grants` 全部（含「不取消已派发动作」、失效项仍可见） | 撤销后断言已 dispatch 的 Operation 状态不变、读面仍返回该行 |
| 10 | 四张新表的不可变触发器与 `device_dispatch` 的 `delivery_state` 白名单边 | 逐列 UPDATE 负例（照 `r0b_transition_test.go` 的 `IS DISTINCT FROM` 手法），＋一条未登记边负例 |
| 11 | O-15 nonce 索引的**并发**单次性 | 本批只测串行第二审批；并发需两连接同 nonce 竞争，断言恰一成功 |
| 12 | O-16 公式的**跨侧一致性** | M3 设备实现前无法对拍；届时必须用同一组 Operation 事实两侧各算一次并逐字节比对 |

**口径**：本批的完成声明只到「增量落地＋写者闭合＋16 条探针有判别力＋上表六件事有正反例」。**上表 12 项是已识别的缺口，不是「大概没问题」**；批四与 M1b 落笔时按各自重开条件补，补完前不得声称 EV70/EV71/EV98/EV100/EV113/EV120 已跑通（§9 给批三列的那六个 EV 目前**一个都没有专用例**）。
- **批一的证据门**：§9 的写者闭合判据（`function_privilege_sweep_pg_test.go:142` 的 `want` 串不变）＋三条 FK 债偿还的只读悬空计数为 0＋S4 五步路径算法的表基础就位（`root_ref`／`root_identity_hash`／`purpose`／TTL 上界）。**F13 实机竞态仍属卡片 K／M5，不在批一**（表就位不等于竞态已复现）。


### 17.10 批四不做（逐条带判据或重开条件）

1. **不建 `work_run_classification`**（O-8＝甲）。传播：控制面 §4.1 设备侧行清单加一条带日期更正，写明本期不建、写者与读者都在 R0a 供应商探测线。
2. **不恢复 cloud 副本支**（E=B 未解），`location` 闭集只有 `local`，`state` 只有 `published`。重开条件＝R0c 恢复 egress 时新增量扩两个 CHECK ＋ 落 `finalize_cloud_replica`。
3. **不清扫副本表与 nonce 表**（retention 都不清）。这不是遗漏：清扫 nonce 等于允许重放，清扫副本等于让本机读取与采纳失去依据。
4. **格式（`media_type`）白名单没有服务端载体**：`local_execution_policy` 没有格式列，§7.1 步 4 的「格式符合输出 profile」在 SQL 侧只能校非空＋长度。重开条件＝管理员面要按组织限格式时给 `local_execution_policy` 加一列受闭集校验的 `allowed_formats[]`（新语义，届时另裁）。
5. **用户保存路径不写副本行**：不对称是有意的（§17.2 末条）。若将来要求「每个 `local_only` 版本都有副本行」，那等于把无签名证据的声明也记成副本事实，须连带裁 O-19 的乙方案一起做。
6. **finalize 不加两类闸**：无 `device_receipt.state`／`outcome` 闸、无输出字节闸——两条 signed 文本都没有它们，加了就是自造判据。重开条件＝M1b 落调用方时按 Temporal 侧真实顺序补前置断言，并在同批把 §6.6 的拒绝码清单补齐。
7. **不按「同 Run 内同 hash 只允许一份」收紧幂等**：本批用 `publish_artifact` 的 `(artifact, content_hash)` 形状。同一 Run 把同一份字节写到两个 `logical_name` 下会得到两个版本（不是缺陷，是 R0a 既有语义）。要改需先裁：这是版本容器语义，不是 bug 修复。
8. **nonce 并发无专用例**：§17.3 末条那笔 23505 竞态只能靠两连接对拍证明，批四用例先覆盖串行两笔（第二笔 `unauthorized`）。与批三 §16.6 缺口表第 11 项同族，一起补。
9. **`publish_ack` 不是真签名**：与 0042 的 `server_signature` 同口径（`'sha256:' || sha256_text(...)`），ES256 与 Bearer 面属 M1b／I4。本批所有 `signature` 只做格式检查，与 0040／0041／0042 一致。
10. **传播清单（任务 #37 逐条落）**：控制面 §9:586／:606／:611 三行（O-18＝丙 的归属更正，以及「(B) 谓词与分类唯一写者」这句话的精确化——版本表的 `classification` 列有**两个**插入者：finalize 推导、用户保存取 proof 值并经 base／clipboard 下界约束；§9 那句指的是 (B) 推导唯一，不得读成列级唯一）、§4.1:272 副本行、§4.2:331 finalize 行、§7.1 四步、本机文档 §7.1／§7.3／§7.5、`work-project.md` 卡片 I 与 M1a 计数、台账卡片 I 的批四行。


> 【2026-11-16 标注，上面各节原文逐字保留】§17.10 第 9 条的「真签名」在网关线已部分落地：GW7／GW8 由 hello_ack 分发服务端公钥 JWK，operation_resolution／receipt_ack／reconcile_ack 走服务端 ES256 签名＋设备 fail-closed 验签（`src/work/internal/devicesig/`、`src/device/src/frame/`）。但 SQL 侧 `signature` 列仍是内部 sha256 占位、设备侧生产消费接线与 live transport 未做，故该条重开条件不因此自动关闭。§16.6 的未测控制缺口同理：本批未新增那些用例，缺口照旧挂账。
