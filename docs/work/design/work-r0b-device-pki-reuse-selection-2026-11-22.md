# Work R0b 设备 PKI 复用选型现读单（零代码）

日期：2026-11-22
状态：现读单，**不是裁定、不是实现授权**。主签 2026-11-22 单选＝甲（先出选型现读单），本单只回答 ADR-0026 的第①②③问并给出可裁的分叉。
**同日追加（2026-11-22）：本单落笔后主签另裁 P1＝甲（托管 `crypto.Signer` 适配 spike），上两行逐字保留；该裁定只定"先做哪个"，见 §6 原位注记——不得据此读成任何替换已开工、已装依赖或已部署。**
范围：设备面证书签发（`deviceca`）与其信任锚分发。不涉及 journal 加密、不涉及设备执行语义、不涉及现网部署。
权威来源：`src/work/internal/deviceca/`、`src/work/cmd/work-api/main.go`、`src/work/cmd/work-gateway/main.go`、`src/work/internal/api/devices.go`、`src/work/migrations/increments/0058_device_certificate_issuance.sql`、`src/device/src/transport/{mod.rs,link.rs}`、`docs/work/design/work-r0b-device-design-2026-10-30.md` §2.1、`docs/work/design/work-r0b-control-design-2026-10-30.md` §10。

## 1. 现读：我们的 CA 今天到底被要求做什么

| 编号 | 要求 | 现读事实（file:line） |
|---|---|---|
| C1 | 由**公钥**签 24h clientAuth 叶子证书，subject 承载身份 | `IssueDeviceCert`：`cn=deviceID(uuid)`、`ou[0]=orgID`、`KeyUsage=DigitalSignature`、`ExtKeyUsage=ClientAuth`、`NotBefore=now-1m`、`NotAfter=now+24h`、serial＝128bit 随机，P-256（`ca.go:79-98`，`DeviceCertTTL` 在 `ca.go:29`）；CA 全程只见公钥，私钥留设备（CNG） |
| C2 | 身份映射**必须由服务端签发**、客户端不可自报 | 网关握手取 peer cert 的 CN/OU 还原 `(deviceID, orgID)`（`internal/gateway/service.go:120-123` 调 `deviceca.DeviceIdentity`，`ca.go:151-163`），body 里自报身份被拒 |
| C3 | 信任锚是**单个 CA root**，两处独立加载 | work-api：`WORK_DEVICE_CA`＋`WORK_DEVICE_CA_KEY` → `LoadCA`（`cmd/work-api/main.go:73-86`）；网关：`-ca-cert` 文件建 `ClientCAs`（`cmd/work-gateway/main.go:37,55-72`，TLS1.3＋`RequireAndVerifyClientCert`）；设备：`DeviceLinkConfig` 的 "The device CA root, PEM"（`src/device/src/transport/mod.rs:114`） |
| C4 | 返回链**恰两元素** `[leaf, CA.Raw]` | `ca.go:97`；换层级＝改这个形状，连带设备侧 presented chain 与网关验证链 |
| C5 | CA 私钥在**服务进程内存**里 | `LoadCA` 解析 PKCS#8/SEC1 EC 私钥并持有（`load.go:19-49,51-66`）；`bootstrap.go` 的 `s.deviceCA`，未配置时证书面在**任何库写之前** 503 fail-closed（`cmd/work-api/main.go:67-72` 注释＋`devices.go:465`） |
| C6 | 签发在事务外，台账只记 `cert_serial`/`cert_not_after`＋PEM | 0058 顶部注释：`work.device` 的 cert 列由 0040 建，0058 加"续期不得把 serial 改小/改写、只前进不回滚"，且**故意不约束 serial 单调**因为 CA 铸随机 128bit serial（`0058:39-45,97-106`）；重签必然得到新 serial（同注释 :57-58） |
| C7 | 撤销**不依赖 CRL/OCSP** | 网关只做链验证＋身份映射，判活靠 DB（`device.status`；0021/0051 系列＋批2-7b 的 `TestDeviceFixtureRunLeaseLossKillsSidecar` 走的就是撤销→续租拒），24h TTL 是 mTLS 层唯一硬边界；`0058:32` 亦记"pair_device 要求 status='active' 但握手需要 CA 签的 client cert"这一前置关系 |
| C8 | CA 轮换/层级/托管**明确未做**，属 J39 独立复核面 | `ca.go:1-16` 与 `load.go:16-18` 两处自陈"加载配置里的 CA **不是**生产托管"；控制面 §10 把"设备CA/证书轮换"列为 J39 复核项 |

读法结论：**模板语法（C1–C4）我们已经有了且被真 exe 证据压过；缺的是 C5 的托管与 C8 的轮换/层级。** 这一点直接决定下面的排序。

## 2. 候选现读（版本与许可截至 2026-11-22，均经仓库现读，不采信记忆）

| 候选 | 许可 | 活跃度与版本 | 与 C1–C8 的贴合 | 引入的形态冲击 |
|---|---|---|---|---|
| **A. 继续 stdlib 模板＋把 CA 私钥移到托管**（阿里云 KMS／PKCS#11／TPM，做成一个 `crypto.Signer` 适配器） | 无新许可面（stdlib） | — | C1–C4 **逐字不变**（`x509.CreateCertificate` 的签发者参数本就是 `crypto.Signer`，`ca.go:92` 传 `c.Key` 即此接口）；直接命中 C5；C7 语义不动；C8 的层级/轮换仍不自建 | 最小：新增一个 Signer 适配包与配置项，链形状、serial、台账、网关/设备信任锚、真 exe CNG interop 全部原样 |
| **B. cloudflare/cfssl 以库形态嵌入**（`signer`／`signer/local`） | **BSD-2-Clause**（GitHub API 现读） | 未归档，push 2026-11-19，**latest release v1.7.2（2026-11-19）** ⇒ 更正"cfssl 已停滞"的常见直觉 | 库形态替掉 C1–C4 的模板装配；cfssl 的 local signer 存在 raw-subject 路径（仓库 `signer/local/rawsubject_test.go` 现读存在），即"按 CSR 原样 subject 签"是其支持面之一，但**必须 spike 验证 CN=deviceID/OU=orgID 是否逐字保留**；profile/expiry 对应 C1 的 24h；不提供 C8 的成熟层级方案 | 中：Go 依赖树新增（影响 SBOM/许可门与 42 包门禁），进程形态与部署不变 |
| **C. smallstep step-ca 作为独立 CA 服务** | **Apache-2.0**（GitHub API 现读；**不是 AGPL**，此点亦更正） | 未归档，push 2026-11-16，latest release v0.30.2（2026-03-23）；**存在 CVE-2026-40097 影响 `certificates >=0.24.0,<0.30.0-rc3`** ⇒ 若采纳必须钉 ≥0.30.2 并进 SBOM/scanner 门 | 唯一正面解决 C8（root+intermediate 层级、provisioner 授权、轮换、可选 ACME、CRL/OCSP 现成）；但官方模板文档明确"多数情况下 **CSR 里只有公钥被使用**，x509 扩展/subject 由模板决定" ⇒ C1/C2 的 CN/OU 身份承载必须改走模板＋claim 映射，属**契约级改动**；签发改为跨进程调用 ⇒ C6 的"事务外签发"多一次网络跳与超时/重试语义（重签必得新 serial 这件事要和 0058 的"只前进不回滚"重新对齐）；C4 的 `[leaf, CA.Raw]` 两元素链在层级下变三元素，网关 `-ca-cert` 与设备 root PEM 的信任锚分发要重裁 | 最大：新增一个要部署/备份/轮换/限流的服务与其自身存储，且改动信任锚分发面 |
| **D. cert-manager／公共 ACME** | — | — | **不成立**：我们的签发授权来自服务端 DB 事实（pairing confirm＋owner＋device status），主体是 uuid 身份而非可被 HTTP-01/DNS-01 验证的域名实体；C2 的信任锚分发与 24h clientAuth 语义都不是 ACME 的目标形状 | 已排除，理由留此以免日后重议 |

## 3. ADR-0026 三问的答复

- **第①问（有无具名开源候选覆盖同一契约）**：有，但要按契约拆两半答。"证书模板装配"这半有 B（cfssl）覆盖、部分有 C 覆盖；"密钥托管＋轮换＋层级"这半只有 C 完整覆盖，B 不解决，A 用托管后端解决一半（托管到位、层级仍自研）。
- **第②问（是否安全关键路径）**：是——PKI 全项。按纪律默认选开源。**但这里要如实记下判据的一个反向作用**：现读的 C1–C4 已被真 exe mTLS/CNG 取证压过（GW19a/GW20/GW21），而"成熟组件"带来的不是零风险而是**不同的风险面**（C 的 CVE-2026-40097 即在同一组件族内）。因此纪律的正确读法不是"凡自研必替换"，而是"**把没有取证积累的那一段交给有维护履历的实现**"——即 C8/C5，而不是 C1–C4。
- **第③问（成本随时间升还是降）**：C5/C8 至今未沉没（现网 tip 仍 39，0046–0062 未入裁定 rollout 包，生产 CA 尚未定，设备信任锚尚未向任何真实设备分发）⇒ 现在决定形态最便宜；一旦有真实设备装成并信任单一 root，层级化与轮换的成本会陡升。

## 4. 建议（供裁定，不含执行）

**建议顺序＝A → B → C，且第一步只做 A 的 spike。** 理由链：①我们的真实缺口是托管与轮换（C5/C8），不是模板语法（C1–C4 已有取证积累）；②A 用 `crypto.Signer` 适配即可命中缺口且不动链形状、serial、台账、信任锚分发与既有 interop 取证；③B 是"库形态的开源替换"，若主签要求把模板也交出去，B 的形态冲击远小于 C，且许可（BSD-2）与活跃度现读均无阻碍；④C 只有在"多 CA／层级／轮换自动化"成为硬需求时才值得付那笔形态代价，并且须同时重裁 C4 链形状、C6 重试语义与 C3 信任锚分发。

代价也要说清：A **不消除** J39 的"设备CA/证书轮换"独立复核项，只是让它有明确落点；它把密钥托管问题交给外部托管面（KMS/PKCS#11），因而新增一条**运维与许可**依赖，但不会新增服务实例。

## 5. 无论选哪条，替换批必须重跑/重裁的影响面（现读枚举，避免日后漏）

- 门禁：Go 全量 `./... -p 1`（42 包）＋ api/gateway PG 整包；真 exe CNG mTLS interop（GW19a/GW20/GW21 与批2-7b 系列，`WORK_DEVICE_BIN` 须为 staged 夹具布局）；device 门禁 87；SBOM/scanner 门（`scripts/supply-chain/generate-sbom.sh` 用 syft，`sign.sh` 用 cosign）——B/C 都会新增许可与 CVE 条目。
- 契约与文档：`ca.go`/`load.go` 的包注释自陈（"不是生产托管"）在替换后必须重写；控制面 §10 的 J39 条目须标注新落点；设备面 §2.1 step 3/4 的证书描述须同步。
- 迁移：0058 台账语义（serial 只前进、不回滚、不约束单调）在层级/多 CA 下是否要加 issuer/AKI 列，须现读后单独裁；若不动 C4 链形状则**预计不需要新迁移**。
- rollout：CA 材料（文件或服务）与 `WORK_DEVICE_CA*` 配置属生产写，需单独的 rollout 授权；本单不主张任何部署。
- 撤销：若采纳 CRL/OCSP（C 自带），那是**新控制**，须重裁——今天判活是 DB 驱动（C7），不得把"组件支持 CRL"读成"撤销面已成立"。

## 6. 待裁分叉（主签单选后即可定批；裁定不含执行授权）

- **P1 第一步做哪个**：甲＝A（KMS/PKCS#11 Signer 适配 spike，缺口最贴、形态冲击最小，推荐）／乙＝B（cfssl 库替换模板）／丙＝C（step-ca 服务，含层级与轮换）／丁＝先只裁"信任锚与链形状的未来口径"（C3/C4），组件选型留后。
  - **2026-11-22 原位注记｜P1 已裁＝甲**（主签单选，原文逐字保留在上条）：第一步落点为**托管 `crypto.Signer` 适配器**，即本单 §2 的候选 A、§4 建议顺序的第一格；据此 §7 所要求的 ADR-0026 排序行补记已以原位注记方式落笔（见 [ADR-0026](../decisions/0026-component-reuse-first.md) 设备 PKI 行）。**此裁定只裁"先做哪个"，不含开工授权、不含依赖引入、不含现网部署**；spike 批须另请开工与提交授权，且开工前须按本单 §7 重读组件版本与许可快照。P2（托管后端）／P3（层级）／P4（CRL/OCSP）仍未裁——注意 P1＝甲使 P2 从"若走 A 再说"变成**当前阻塞项**：托管后端未定时，spike 只能先把接口骨架与一个可替换的假后端做出来（`crypto.Signer` 的 `Public()`/`Sign()` 形状与 0058 serial 语义不依赖后端），真后端调用面须等 P2 落定才可写。
- **P2 若走 A**：托管后端＝阿里云 KMS／PKCS#11 硬件／纯文件＋现有密钥面（只加 ACL，不外移）——此问决定 J39 复核面的形状。
- **P3 层级**：是否引入 root＋intermediate（决定 C4 链形状、C3 信任锚分发、0058 是否加列）。
- **P4 撤销控制**：维持"DB 判活＋24h 上限"，还是额外采纳 CRL/OCSP（新控制，须重裁）。

## 7. 本单未做（如实记）

零代码：未装任何依赖、未跑 spike、未改 `deviceca`、未生成证书、未触碰现网。版本与许可为 2026-11-22 经 GitHub API 现读的快照（cfssl v1.7.2／BSD-2-Clause；step-ca v0.30.2／Apache-2.0／CVE-2026-40097 影响 <0.30.0-rc3），任何后续批次开工前须重读。cfssl 的 raw-subject 行为只现读到"存在该测试面"，其能否逐字保留 CN=deviceID/OU=orgID 属 spike 待证，本单不预判。ADR-0026 §表格中"step-ca／cfssl"并列的粗分级仍成立，本单是其细化而非推翻；若主签在 P1 选甲，ADR-0026 的排序行须以原位注记方式补记一次"第一步落点在托管而非模板"，原文逐字保留。

Sources（本单候选事实的外部出处）：
- [Smallstep docs — Certificate Template Reference](https://smallstep.com/docs/step-ca/templates/)
- [Smallstep docs — Basic CA Operations（含 `step ca sign --csr` 与 renew 的 mTLS 限制）](https://smallstep.com/docs/step-ca/basic-certificate-authority-operations/)
- [CVE-2026-40097（smallstep certificates >=0.24.0, <0.30.0-rc3）](https://cve.scap.org.cn/vulnerability/VHN-366477)
- [cfssl — Homebrew Formulae（v1.7.2，License: BSD-2-Clause）](https://formulae.brew.sh/formula/cfssl)
- [cfssl 的签名 profile/usage 说明（含 client auth）](https://developer.aliyun.com/article/1308563)
