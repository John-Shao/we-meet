# Work R0b 设备 CA 托管适配 spike 设计单（零代码）

日期：2026-11-22
状态：设计单，**不是开工授权**。主签 2026-11-22 单选＝甲（先出 spike 设计单）；落笔与实现须另行请求开工授权。**同日 §8 已记 S1–S4 四项裁定（全甲），落笔批据此定形。**
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
