# R0a 决策单：供应商凭据静态加密的派生参数（D-08b / D-03 B）

> 状态：**待签收**（John 主签；Lily 复核密钥边界）
> 提出：2026-10-30　截止：2026-11-06
> 关联：[D4 §7.5](work-r0a-runtime-egress-design-2026-10-25.md)、[D1 §7.14](work-r0a-data-design-2026-10-25.md)、`work.provider_credential`

## 1. 问题

D-08b 已定“静态单层加密、按 org 派生、只存密文 + 指纹 + key_version”，但**派生算法与盐**在 D1 中仍标注“待 DR0/DR1 确认”。没有这两个参数，Go 侧无法实现 `resolve_provider_context` 的解密，`cmd/work-egress` 无法启动；自行指定参数等于未签收的实现决定。

## 2. 候选

### A. 复用 Content Store 的派生方式（推荐）

`key = HMAC-SHA256(master_key, "we-meet-work-provider:" + org_id)`；AES-256-GCM，12 字节随机 nonce，AAD 为 `org_id`；密文列存 `nonce || ciphertext`；`key_version` 单调递增；指纹为明文 SHA-256 的前 8 字节（hex）。

- 优点：与现有 Content Store 的派生实现同构（仅前缀不同），只需一个 crypto 代码路径；不新增 schema；域分离由前缀保证。
- 代价：主密钥轮换需要离线重加密全部凭据（D-03 B 本就无 KMS，可接受）；指纹暴露明文哈希，若凭据熵低可被离线猜测——约定供应商 Key 为高熵。
- 证据边界：需用合成主密钥做加解密/篡改/AAD 不匹配/跨 org 解密的负例；真实主密钥托管仍属 E5。

### B. HKDF-SHA256(master, salt=org_id, info="work-provider-v1")

- 优点：标准 KDF，参数语义更清晰。
- 代价：引入第二种 KDF（Content Store 仍是 HMAC），两套实现两套测试；收益不明显。

### C. 每 org 随机 salt 入库

- 优点：避免 org_id 作为公开盐。
- 代价：需要给 `provider_credential` 增加 salt 列或新表，改动 D1 已签结构；org_id 本身不是秘密，收益有限。

## 3. 推荐

**A**：最少实现面、与既有加密路径一致；域前缀已足够区分用途。

## 4. 不答复的后果

`resolve_provider_context` 的 Go 解密无法实现，egress 无法取得任何供应商凭据，真实模型调用不可用；若按未签收参数实现，后续换参需要全部凭据重新加密，且不能作为架构闭环证据。

## 5. 签收

- [x] John：**选择 A**（HMAC-SHA256 前缀派生 + AES-256-GCM）　2026-10-30
- [x] Lily：**复核通过**（派生、AAD、指纹与轮换边界）　2026-10-30
