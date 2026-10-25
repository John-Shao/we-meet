# Work R0a 沙箱 / KMS / 供应商推进证据（2026-10-25）

本目录是 R0a 的**局部证据**，不是生产沙箱证明、生产 KMS 或供应商条款/计费承诺。

## 文件

| 文件 | 用途 |
|---|---|
| `sandbox-smoke.sh` | runc 降级 profile：非 root、只读根、无宿主挂载、无网络、cap-drop、资源限制 |
| `sandbox-smoke.log` | 本次运行输出 |
| `kms-envelope.mjs` | 本地 envelope-encryption 参考：CMK/DEK、租户隔离、轮换、crypto-shredding |
| `kms-envelope.test.mjs` | 6 组测试 |
| `provider-smoke.mjs` | 真实 Qwen 流式请求；只输出元数据/hash，不输出 Key/正文 |
| `provider-smoke.log` | 本次运行输出 |
| `log-scan.mjs` | 日志/追踪扫描：API Key、Bearer、cookie、私钥、正文/邮箱；输出只含脱敏预览 |
| `log-scan.test.mjs` | 7 组测试：合成密钥/canary、目录递归、脱敏、现有证据日志 |
| `log-scan-result.log` | 对 provider/sandbox/Temporal 证据日志的扫描结果（0 fail / 0 warn） |

## 结果

### 1. 沙箱降级 profile

Docker 环境只有 `runc`/`nvidia` runtime，**没有 gVisor/runsc**。因此只执行降级 profile，`sandboxProof=false`，不能宣称 gVisor 隔离。

```text
uid=65532
root_write_exit=1          # Read-only file system
host_path_exit=2           # /host 不存在（无宿主挂载）
docker_sock_exit=2         # 未暴露 docker.sock
tmp_write_exit=0           # /tmp tmpfs 可写
network_blocked TypeError  # --network none
sandbox-smoke-complete
```

复现：

```bash
bash sandbox-smoke.sh
```

结论：非 root/只读根/无宿主挂载/无网络/资源限制的 runc profile 可用；**gVisor/逃逸证明仍未关闭**，不能作为生产沙箱证据。

### 2. 本地 KMS envelope 参考

`kms-envelope.mjs` 使用 AES-256-GCM：主密钥包装 per-tenant DEK；envelope 只含 tenantId/keyVersion/iv/tag/ciphertext；支持租户轮换、主密钥轮换、crypto-shredding。**它不是云 KMS/HSM**，主密钥只在进程内存，没有访问控制、审计、区域隔离或持久化。

```bash
node --test kms-envelope.test.mjs
# 6/6 pass
```

覆盖：round trip、envelope 不含 key material、跨租户拒绝、租户轮换、主密钥轮换、shred 后不可读、篡改/非法主密钥失败。

### 3. 真实供应商请求

使用 `DASHSCOPE_API_KEY` 从进程环境读取（不落盘、不回显），请求 qwen3.8-flash，流式返回；脚本只输出元数据与内容 hash，不输出 prompt/正文。

```json
{
  "ok": true,
  "status": 200,
  "model": "qwen3.8-flash",
  "latency_ms": 3115,
  "first_token_ms": 2567,
  "bytes": 154,
  "content_hash": "sha256:dd733...",
  "usage": {
    "prompt_tokens": 80,
    "completion_tokens": 110,
    "total_tokens": 190,
    "completion_tokens_details": { "reasoning_tokens": 77, "text_tokens": 110 }
  },
  "provider_request_id": "aa7b3c31-02a9-952d-977d-60504b52edf4",
  "request_hash": "sha256:08e321...",
  "source_label": "user_input",
  "fence": 3,
  "no_content_logged": true
}
```

复现（Key 只放进程环境；不要把值写进命令历史/文件）：

```bash
DASHSCOPE_API_KEY=... node provider-smoke.mjs
```

结论：真实供应商 200、流式首 token、usage/provider request id 可记录；**供应商书面条款、驻留、训练/留存、配额与价表上界仍未关闭**，不能据此作生产承诺。usage 含 77 reasoning tokens；D4 的响应过滤只累计公开 `delta.content`，最终正文 hash 不含 reasoning。

### 4. 日志/追踪无正文/无密钥扫描

```bash
node --test log-scan.test.mjs
node log-scan.mjs provider-smoke.log sandbox-smoke.log ../work-temporal-slice-2026-10-25
# scanned 7 files/60 lines; fail=0 warn=0
# log-scan: clean
```

- 规则：OpenAI/Anthropic 形态 Key、Bearer、环境变量赋值、AWS Access Key、私钥、session cookie、`goal/background/prompt/content/artifact_content` 字段、email（warn）。
- 合成 canary 测试证明扫描能发现 prompt/正文泄漏；扫描结果本身不含完整密钥/canary（只留脱敏预览）。
- 现有 provider/sandbox/Temporal 日志 **0 fail / 0 warn**，provider smoke 只记录 hash/usage/元数据。
- **边界**：这不是 staging/生产 OTel trace/log pipeline 证据；未接真实日志后端、采样、trace attributes 或告警，C16 仍未关闭。

## 边界

- 未使用 gVisor；未做逃逸/宿主越界证明；`sandboxProof=false`。
- 未接云 KMS/HSM、访问控制、审计、区域密钥分层或持久化。
- 未接真实 D4 egress gateway/Temporal；provider smoke 是独立脚本。
- 未取得供应商书面条款/DPA/价表；Temporal dev server 为 in-memory。
- 这些证据只用于推进 D6 no-go 清单，不等于试点/生产就绪。
