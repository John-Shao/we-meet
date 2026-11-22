# Work R0b 设备 CA 托管适配 spike 设计单（零代码）

日期：2026-11-22
状态：设计单，**不是开工授权**。主签 2026-11-22 单选＝甲（先出 spike 设计单）；落笔与实现须另行请求开工授权。**同日 §8 已记 S1–S4 四项裁定（全甲），落笔批据此定形。**
**同日追加（2026-11-22，主签开工授权＝甲）：§8 的形状已实现并验证，落地登记、与 §8 的三条偏差、突变判别与取证见 §9；上两行原文逐字保留。**
上游裁定：[ADR-0026](../decisions/0026-component-reuse-first.md) 三问纪律＋[设备 PKI 复用选型现读单](work-r0b-device-pki-reuse-selection-2026-11-22.md) 的 **P1＝甲**（第一步落点在密钥托管适配而非模板装配）与 **P2＝甲**（托管后端＝纯文件＋现有密钥面，只加 ACL，不外移）。
范围：`src/work/internal/deviceca/` 的**签发者键接口缝**与其文件后端。**不涉及**设备侧 CNG、网关 TLS 与信任锚分发、证书模板语义、任何迁移、任何现网部署。

## 1. ADR-0026 三问（本批裁定项必须带答）

- **①具名开源候选覆盖同一契约？**本批要的那一条契约是"用可替换的签发者 `crypto.Signer` 签一枚模板已定的 x509 叶子"。这就是 Go 标准库 `crypto.Signer`＋`x509.CreateCertificate` 的既有语义（现读 `ca.go:92` 已在用它），不是 cfssl/step-ca 的能力面——那两者的增量在**层级／轮换／provisioner 授权**，属 P3/P4 未裁项，本批不引入。⇒ 第①问答"是"，且答案是 stdlib 而非新依赖，**零新许可面**。
- **②是否安全关键路径？**是（PKI 签发）。纪律的默认值在此被主签 P2＝甲 以**部署策略约束**挡一次：本批不建云 KMS／PKCS#11 后端，只把接口缝做出来。该约束与被否方案（乙 KMS／丙 PKCS#11·TPM）已记入 ADR-0026 设备 PKI 行与选型单 §6，本单只是执行其形状。
- **③成本随时间升还是降？**升。缝越早做越便宜：现读半径＝**4 处测试调用点＋2 处门禁文本 pin**（见 §2），且 0046–0062 尚未进已裁 rollout 包、生产 CA 尚未定、设备信任锚尚未分发 ⇒ 现在改不动任何已沉没事实。

## 2. 现读：接口缝与它的真实半径

| 编号 | 事实（file:line） | 对本批的含义 |
|---|---|---|
| S-1 | `CA` 结构持具体键类型：`Key *ecdsa.PrivateKey`（`ca.go:31-35`），`NewCA` 构造它（`ca.go:64`），`LoadCA` 解析 PKCS#8/SEC1 后构造它并**在返回前**比对键与证书公钥（`load.go:37-43`） | 缝就是这一个字段；`x509.CreateCertificate` 的签发者参数本就是 `crypto.Signer`，故 `ca.go:92`／`ca.go:119` 两个调用点**无需改动语义** |
| S-2 | 唯一生产调用者＝`devices.go:479` 的 `s.deviceCA.IssueDeviceCert(deviceID, claims.OrgID, pub.Key)`；注入链＝`main.go:73-86`（读两个文件路径→`LoadCA`→`SetDeviceCA`）＋`bootstrap.go:84,94`（字段与 setter 类型是 `*deviceca.CA`） | 若 `CA` 保持结构体类型不变、只换内部键字段类型，则注入链与 `SetDeviceCA` 签名**一字不动** |
| S-3 | `IssueDeviceCert` 的**主体公钥**入参仍是 `*ecdsa.PublicKey`（`ca.go:79`），调用方传 `devicesig` 的 `pub.Key`（`devices.go:479`）与 `&priv.PublicKey` | 托管的是**签发者**键，不是设备主体键：本批不宽化该入参（宽化＝把设备签名键也纳入接口面，属另一契约，无需求） |
| S-4 | 返回链恰两元素 `[leaf, CA.Raw]`（`ca.go:97`）、TTL＝`DeviceCertTTL` 24h（`ca.go:29,88`）、serial＝随机 128-bit（`ca.go:80-83`） | 三者都是**必须逐字不变**的下游契约：0058 台账、设备 `identity.rs` 六闸、网关链验证都读它 |
| S-5 | `IssueServerCert`／`ServerTLSConfig`／`ClientTLSConfig`／`NewCA` 生产代码零调用者（仅 `ca_test.go:62-70`、`gateway_test.go:162` 一类测试与夹具） | 本批**不动**它们的行为，但 `NewCA` 一旦改为返回持 `crypto.Signer` 的 `CA`，测试夹具全部跟着走同一条缝（好事：夹具与生产共用后端接口） |
| S-6 | 直接读 `CA.Key` 的测试共四处：`load_test.go:54,61,83,97`（`keyPEM(t, ca.Key)`、`loaded.Key.Equal(ca.Key)`、`x509.MarshalECPrivateKey(ca.Key)`）；另有 `device_broker_interop_test.go:494` 用 `ca.Key` 当 `x509.CreateCertificate` 的签发者 | `crypto.Signer` 没有 `Equal`／`MarshalECPrivateKey`，故 :61 与 :83 两处断言必须重写成"按 `Public()` 比字节"与"夹具自持一份具体键"；:494 无需改（该 API 收 `any`） |
| S-7 | 门禁 `test/device-cert-issuance.test.mjs` 文本 pin 了 `func LoadCA(certPEM, keyPEM []byte) (*CA, error)`（:228）、`if !key.PublicKey.Equal(cert.PublicKey) {`（:231）、`deviceca.LoadCA(certPEM, keyPEM)`（:235）、`SetDeviceCA(ca *deviceca.CA)`（:239）、env 模板两行与"无内联私钥"（:242-244） | **同一批必须同步该门**：:231 那条 pin 会因 S-6 的改写而失配；其余四条若签名不动则继续绿。门还钉住 `load_test.go` **不得 `t.Skip`、不得有 `runtime.GOOS`**（:252-259）⇒ 新后端用例必须无条件跑，且不得把平台判断塞进该文件 |
| S-8 | 该缝**可被 CI 完全覆盖**（`device-cert-issuance.test.mjs:248-262` 明确"与 GW18/GW19a 相反，本面 Linux job 全覆盖，任何 workflow 不得声称否则"） | spike 取证不需真 exe／Windows：Go 单测＋api PG 用例即可成立；真 exe CNG 互操作只作**回归复跑**证据，不作本批新增证据面 |
| S-9 | 现有同族文件密钥纪律：`src/work/deploy/ecs/init-workload-pki.sh:37-51`（`umask 077`＋目录 750＋`ca.key` 600）与 `rollout-r0a-0027.sh:211` 的 `chmod 640` 装载模式 | P2＝甲 选的"只加 ACL"在仓库里**已有形状可循**，但那是 workload CA 不是设备 CA，本批若加进程侧校验须自己声明口径而不抄成既成事实 |

## 3. spike 要交付什么（建议形状，待裁）

1. **接口缝**：`CA` 的签发者键改为 `crypto.Signer`（字段名与可见性属 S1 分叉），`NewCA`/`LoadCA` 继续返回 `*CA`、签名不变，`IssueDeviceCert` 内 `x509.CreateCertificate(..., c.Signer)`。
2. **文件后端**：`LoadCA` 内部把"PEM→EC 私钥"包成一个显式后端（`fileSigner` 或在包内一个 `signer.go`），使"密钥从哪来"第一次成为一个**有名字的边界**而不是解析函数的副产品。
3. **ACL 口径**：S2 分叉——是否在装载前对密钥文件做 fail-closed 校验（POSIX mode 拒绝 group/other 可访问），还是只写部署面纪律。若做进程侧校验须如实声明：work-api 部署在 Linux（`src/work/deploy/ecs/*.service`），Windows 上该判断无意义，因此这类用例只能按平台条件跳过——而 S-7 的"不得 `t.Skip`/不得 `runtime.GOOS`"钉在 `load_test.go`，所以平台条件用例**必须另立文件名**，不得写进那四个被钉的文件。
4. **不变量测试**：一条"同一把键经接口缝签出的证书与经旧直持键签出的证书在模板字段上逐字同形"的对照用例（链两元素、CN/OU、clientAuth EKU、`NotAfter-NotBefore` 窗、SPKI＝设备键、可在 CA 下验签），把"本批不改契约"从散文变成可执行断言。

## 4. 本批明确不做

不改证书模板与 TTL 语义、不改 serial 规则（0058 的"只前进不回滚、不约束数值序"照旧）、不引入任何新依赖（`crypto.Signer` 是 stdlib）、不新增迁移、不动设备侧 `identity.rs` 六闸与 CNG、不动网关 TLS 与 `-ca-cert` 分发、不实现 KMS/PKCS#11 后端、不裁 P3（层级）／P4（CRL/OCSP）、不碰现网与 rollout 包。

## 5. 取证与门禁半径（落笔批必须全跑）

- `go test ./internal/deviceca/... ./internal/api/...`（含 `device_certificate_test.go` 真链验签）＋ gateway 包（夹具共用 `NewCA`）；`go test ./... -p 1` 整包口径照旧。
- 资产门 `device-cert-issuance.test.mjs` 同步 :231 那条 pin，并**新增**判别：接口缝存在（`CA` 不再持 `*ecdsa.PrivateKey`）、`IssueDeviceCert` 把 signer 交棒给 `x509.CreateCertificate`、`NewCA` 仍不得被 `work-api` 调用（:238 保留）。
- 突变判别力（每条只红该当条）：① 把 signer 退回具体 `*ecdsa.PrivateKey` 字段 ⇒ 新接口缝断言红；② 去掉文件后端的键/证书公钥相符校验 ⇒ `LoadCA` 拒绝用例红；③ 若裁进程侧 ACL，放宽 mode 闸 ⇒ 只有 ACL 用例红。
- 回归复跑（不新增证据面）：真 exe CNG 证书互操作 `device_broker_interop_test.go`（`WORK_DEVICE_BIN` 须为 staged 夹具布局）、`ci-contract`、`work-status --check`、`audit-scope` 重生成（预期 chainTip 仍 **0062**、条目数不变，因无新公开入口）。

## 6. 待裁分叉（单选后即可定批；裁定不含执行授权）

- **S1 缝的形状**：甲＝`CA` 字段换成 `crypto.Signer`（改名 `Signer`，导出）／乙＝保持 `CA` 不动，新增 `NewWithSigner(cert *x509.Certificate, s crypto.Signer) (*CA, error)` 构造函数＋私有接口字段（改动更小但两套构造路径）／丙＝把签发能力提成包级接口 `deviceca.Issuer`，`*CA` 只是其实现，`bootstrap.go` 的 `SetDeviceCA` 改收接口（最干净但触碰注入链签名与 S-7 的 :239 pin）。
- **S2 ACL 落点**：甲＝进程侧装载前 mode 闸（Linux 语义，Windows 无意义，需另立平台条件用例文件）／乙＝只做部署面纪律（env example＋verify 脚本＋文档），零进程侧代码／丙＝甲＋乙（闸在进程，纪律在部署，各守一段）。
- **S3 spike 半径**：甲＝只做 §3 的 1–2＋4（缝＋文件后端显式化＋不变量对照，ACL 留下一批）／乙＝§3 全做（含 ACL）／丙＝先只做 1（纯缝，测试改写即完，后端与不变量对照留下一批）。
- **S4 后端命名与文件布局**：甲＝新增 `internal/deviceca/signer.go`（`fileSigner`＋构造入口）／乙＝全留在 `load.go` 内不新增文件／丙＝新增 `internal/deviceca/backend/`（为 KMS/PKCS#11 预留包位，代价＝今天就有无调用者的包）。

## 7. 诚实边界（本单未证的事）

零代码：未改 `deviceca`、未跑任何 Go 测试、未生成证书、未触碰部署与现网。§2 的行号与 S-7 的门禁 pin 文本为 2026-11-22 现读，落笔批开工前须重读（门禁与代码同时会动）。**本 spike 不消除 J39 的"设备CA/证书托管与轮换"独立复核项**：做完之后 CA 私钥仍留在 work-api 进程内存（P2＝甲 明示接受），得到的只是"后端可替换"这一条缝与一处有名字的边界。选型单 §2 候选 B（cfssl）与 C（step-ca）的版本、许可与 CVE 现读快照同样须在任何替换批开工前重读，本单不引用其数值。

## 8. S1–S4 已裁（2026-11-22 主签四项单选，全部＝甲）

- **S1＝甲**：`CA` 的签发者字段换成导出的 `Signer crypto.Signer`（不再持 `*ecdsa.PrivateKey`），`NewCA`／`LoadCA` 返回类型与 `SetDeviceCA` 签名一字不动。
- **S2＝甲**：ACL **只落部署面**（`work-api.env.example` 注释口径＋`verify-r0a-0027.sh`／rollout 文档纪律），**进程侧不判 mode**。连带后果如实记：§3 第 3 条与 §5 突变第 ③ 条（放宽 mode 闸即红）**本批不做**，S-7 那条"不得 `t.Skip`／不得 `runtime.GOOS`"的平台条件用例问题随之不存在；CA 私钥仍在 work-api 进程内存内，P2＝甲 的口径不因本批改变。
- **S3＝甲**：本批＝接口缝＋文件后端显式命名＋一条"新旧两路签出的证书模板字段逐字同形"不变量对照用例；ACL 面按 S2 归部署，不占本批代码。
- **S4＝甲**：新增 `src/work/internal/deviceca/signer.go`（`fileSigner`＋构造入口），`load.go` 只留配置解析与校验，**不新建 backend 子包**（避免今天就有无调用者的包）。

**落笔批据此定形**：改动集＝`ca.go`（字段与两处 `x509.CreateCertificate` 交棒）＋`load.go`（解析后交 `signer.go` 构造）＋新 `signer.go`＋`load_test.go`/`ca_test.go`/`device_broker_interop_test.go` 的 S-6 四处改写＋`device-cert-issuance.test.mjs:231` 一条 pin 同步＋不变量对照新用例＋部署面 ACL 口径两行。**无新迁移、无新依赖、无新公开入口**（预期 chainTip 仍 **0062**、audit-scope 条目数不变）。§6 上列四个分叉原文逐字保留，判读以本节为准。**本节只是把裁定写清，仍不含开工授权。**

## 9. 落地登记（2026-11-22，主签开工授权＝甲；§8 原文逐字保留）

**改动集＝8 个文件（6 改 2 新）**：`internal/deviceca/ca.go`（`CA.Key *ecdsa.PrivateKey` → `CA.Signer crypto.Signer`，两处 `x509.CreateCertificate` 交棒 `c.Signer`，包注释写明这条缝是什么、不是什么）、新 `internal/deviceca/signer.go`（`fileSignerFromPEM`＝文件后端，收 PKCS#8/SEC1、拒非 EC；`publicKeysMatch`＝接口下的键/证书相符判定）、`internal/deviceca/load.go`（不再自己解析私钥，键/证书相符改走 `publicKeysMatch`）、`internal/deviceca/load_test.go`（四处 `ca.Key` 改写：`.Equal` 比较换成按 `Public()` marshalled 字节比，`MarshalECPrivateKey`/`keyPEM` 改由测试自持具体键）、新 `internal/deviceca/signer_test.go`（不变量对照＋后端拒绝两例）、`internal/api/device_broker_interop_test.go`（一行 `ca.Key`→`ca.Signer`）、`deploy/ecs/work-api.env.example`（ACL 口径四行）、资产门 `test/device-cert-issuance.test.mjs`。

**与 §8 的三条偏差，如实记**：
1. **S4 的字面"fileSigner"落成了具名构造函数，没有包装类型**。包了一个 `type fileSigner struct{…}` 不携带任何行为（`crypto.Signer` 已由解析出的键满足），却迫使测试先解包才能拿到具体键，故落为 `fileSignerFromPEM`＋`publicKeysMatch` 两个具名函数。缝的语义（"密钥从哪来"只有一处）不变。
2. **S-6 说 `device_broker_interop_test.go:494`"无需改（该 API 收 `any`）"只对了一半**：`x509.CreateCertificate` 确实收 `any`，但字段名 `ca.Key` 已不存在，仍须改成 `ca.Signer`（一行）。
3. **S2＝甲 的部署面纪律本次只落了 `work-api.env.example`**（0600／root-owned／目录 0750，并注明进程不判 mode）。`verify-r0a-0027.sh` 与 rollout 脚本**未动**——那两处属生产写面，须单独授权，不得在本批顺手加。

**门禁同步**：`device-cert-issuance.test.mjs` 把原 `:231` 的 `key.PublicKey.Equal` 文本 pin 换成 `publicKeysMatch(signer.Public(), cert.PublicKey)`，并新增接口缝存在（`Signer crypto.Signer` 在、`Key *ecdsa.PrivateKey` 不在）、交棒点、`signer.go` 两个具名函数、`load.go` 不再解析私钥、不变量用例存在、env ACL 口径两断言；该门 12/12 绿。`load_test.go` 仍无 `t.Skip`、无 `runtime.GOOS`（同门继续钉住，故新后端用例无条件跑）。

**突变判别两处，各自精确转红后按字节还原**：① 给 `CA` 加回一个 `Key *ecdsa.PrivateKey` 字段 ⇒ 只有"CA 不得再持具体私钥"那条红（11 pass／1 fail）；② 删掉 `LoadCA` 里的 `publicKeysMatch` 拒绝分支 ⇒ 只有 `load_test.go` 的"a mismatched CA key was accepted"红。还原后 sha 复核＝`ca.go` `2e3993d6…b96002`、`load.go` `2295373a…fe3471a`，与突变前逐字一致。

**取证**：最终树 `go test ./... -p 1 -count=1`（带真 PG 与 `WORK_DEVICE_BIN`）**rc=0／42 ok／0 FAIL**，其中 api 684.909s、migrate 540.477s、gateway 297.505s、deviceca 0.702s；`ci-contract` 全绿、`work-status --check` 无漂移、`go vet` 净、`gofmt -l internal/deviceca` 净。真 exe 互操作**逐条 `-v` 确认确实执行非 skip**共 8 条：`TestDeviceBrokerEntryPairsAndConsumesARestIssuedCertificate` 7.69s（**证书面回归主证：真 Broker 消费的是经新缝由真 work-api 签发的证书**）＋完整夹具 Run 七条（write 25.52s／cancel 26.16s／lease-kill 25.89s／finish-failed-accepted 18.55s／finish-completed-accepted 26.53s／restart-republish 27.47s／cross-session-finish 27.72s）。夹具 exe sha `ca96c419d95bda7d922a0d20ed977af3073b5f13d5e74f403a7ff36ee131a676` 与批6 staged 那份逐字一致，是本批零 Rust 改动的旁证。

**一条负载下的一次性失败，登记不糊过**：第一轮全量里 `internal/contentproxy` 的 `TestReadRejectsInvalidCapabilities/expired_capability` 报 `issue work-content capability: capability: invalid_request`。处置＝先证无因果路径（`internal/contentproxy` 全文不 import `deviceca`，本批改动集亦未触该包），再隔离复跑（该子例 3/3 绿、整包 6.759s 绿）、第二轮同口径全量 42 ok／0 FAIL。机制现读定位＝该子例请求 150ms TTL 的 capability，`p_expires_at` 由 **Go 主机时钟**算出，而 `0010_runtime_capability.sql:199` 以**数据库时钟** `v_now` 判 `p_expires_at <= v_now` 即拒；本机与容器实测差 68ms，加 `-p 1` 负载抖动足以吃掉 150ms 余量。**本批未改该测试**（跨包不顺手改），登记为既有测试脆弱性；关闭条件＝该子例的 TTL 显著大于实测时钟差，或改由数据库时钟取到期，须另批裁。

**不变量未动的现读复核**：链恰两元素、`DeviceCertTTL` 24h、随机 128-bit serial（0058 仍不约束数值序）、`IssueServerCert`／`ServerTLSConfig`／`ClientTLSConfig`／`NewCA` 仍测试专用、`LoadCA` 与 `SetDeviceCA` 签名一字未改、`devices.go:479` 调用点不变、**无新迁移**（tip 仍 **0062**，现网仍 **39**）、无新依赖、无新公开入口（audit-scope 条目数不变）。

**本批没有做的**：CA 私钥仍在 work-api 进程内存（P2＝甲 明示接受），**J39 的"设备CA/证书托管与轮换"独立复核项未闭合**；未实现任何 KMS／PKCS#11 后端；未部署、未改现网；P3（层级）与 P4（CRL/OCSP）仍未裁；`internal/api` 里若干既有文件不符合 `gofmt`（非本批引入，未顺手改）。
