# 大文件导入：直传对象存储（前置项 2）

目标：把「导入音视频」的单文件上限从 **100 MiB** 提到妙记同量级（**6 GiB**），
且**不把 GB 级字节流引到应用或 ingress**。

---

## 1. 为什么不能只改配置

现有导入路径（`core/api/uploaded_recordings.py`）走 multipart：

- `BoundedUploadHandler`（`:51-58`）把整个请求体**落应用本地磁盘**，超限即 `StopUpload`；
- ingress 的 `proxy-body-size` 被刻意设成 `101m`（`values.meet.yaml`，对齐 100 MiB 上限）；
- `service.create()` 逐块读取以算 SHA-256 并存入 S3。

所以 **100 MiB 是磁盘与 ingress 的保护值，不是随手写的常量**。把
`MEETING_FILE_ASR_MAX_BYTES` 调到 6 GiB 会：
① 让单个请求可能写满应用盘；② 需要把 ingress 上限提到 6 GiB ——
而那等于把「任何人可 POST 6 GiB」暴露在入口。

**结论**：唯一正解是让字节**不经过应用**。本次即实现该能力契约。

---

## 2. 直传契约（已实现）

两步，均为 JSON（无请求体→无 ingress body 限制）：

```
POST /api/v1.0/recording-uploads/upload-url/      步骤 1：签名
  { key, name, size, content_type, context?, hotwords?, diarization? }
  → { upload_url, storage_name, expires_in, max_bytes, headers }

  客户端 PUT upload_url（带 headers），字节直达私有对象存储

POST /api/v1.0/recording-uploads/upload-complete/  步骤 2：登记
  { key, name, size, content_type, storage_name, context?, hotwords?, diarization? }
  → 202 { record_id, status, attempt, model, retryable }
```

能力声明由 `GET /api/v1.0/recording-uploads/` 返回，新增两个字段：

| 字段 | 含义 |
|---|---|
| `direct_upload_available` | 总开关 `MEETING_FILE_DIRECT_UPLOAD_ENABLED` 且底层可用 |
| `direct_max_bytes` | `MEETING_FILE_DIRECT_UPLOAD_MAX_BYTES`（生产默认 6 GiB） |

`max_bytes` 保持为 multipart 上限，语义未变；老客户端继续走原分支。

### 安全性质（每条都有单测）

| 性质 | 实现 | 测试 |
|---|---|---|
| 声明大小就是硬上限 | `ContentLength` **进签名**；实际多传由对象存储拒绝 | `test_presign_binds_the_declared_size_into_the_signature` |
| 完成时不信任客户端 | `head_object` 复核 `ContentLength == size` | `test_complete_rejects_a_stored_object_whose_length_disagrees` |
| 扩展名与声明 MIME 必须匹配 | `_declared_media_ok` | `test_presign_rejects_an_extension_the_mime_does_not_allow` |
| 真实内容必须匹配扩展名 | `_verify_stored_header` 取 **0-65535 字节**范围做 magic 校验（GB 级文件只花一次有界读） | `test_complete_rejects_content_that_does_not_match_the_extension` |
| 不能指向桶内任意对象 | `_normalize_name` 折叠 `..` 后必须落在 `record-uploads/` 前缀内 | `test_complete_rejects_a_key_outside_the_upload_prefix`、`..._a_traversal_key` |
| 幂等 | 同 `key` + 同意图返回同一 job；意图变了 409 | `..._replays_the_same_intent_without_a_second_paid_job`、`..._rejects_a_changed_intent` |
| 未开启则不可用 | 503 | `test_presign_is_unavailable_when_the_feature_is_off` |

### 一处有意的语义差异（需知晓）

multipart 路径把**流式 SHA-256** 存进 `UploadedRecording.checksum`。
直传路径没有字节流，因此 checksum 改为 `sha256("<storage_name>:<size>")`
—— 它是**声明指纹**，不等于内容摘要。

理由：其安全作用（防呆去重 / 幂等）由「签名里的 ContentLength + 完成时
`head_object` 复核 + magic 头校验」三者覆盖；要真正的内容摘要则需客户端
在上传前算完整个 6 GiB 文件，与「不经过应用」的目标冲突。
**若后续需要内容级去重，应在完成时让对象存储侧提供 checksum（S3 `ChecksumSHA256`）**，
而不是把文件读回应用。

---

## 3. 配置

| 变量 | 生产默认 | 说明 |
|---|---|---|
| `MEETING_FILE_DIRECT_UPLOAD_ENABLED` | **`False`（暗发布）** | 必须等客户端接完两步流程再开 |
| `MEETING_FILE_DIRECT_UPLOAD_MAX_BYTES` | `6442450944`（6 GiB） | |
| `MEETING_FILE_DIRECT_UPLOAD_TTL_SECONDS` | `3600` | 6 GiB 在慢上行链路上需要更长时间 |
| `MEETING_FILE_ASR_MAX_BYTES` | `104857600`（未变） | multipart 上限，继续由应用磁盘保护 |

暗发布原因已写进 `deploy/aliyun/test_meeting_ai_chart.py`：老客户端不认
`direct_upload_available`，提前打开只会让「有的客户端能传、有的不能」难以复现。

---

## 4. 状态与后续

**已完成（后端契约 + 测试）**
- 服务层拆分：`_record_job` / `_replay_guard` / `_parse_extension` 由 multipart 与直传共用，
  两条路径不会再在幂等与元数据上漂移；
- 新增 `presign_direct_upload` / `complete_direct_upload` 与两个端点；
- 12 项直传单测通过；`test_uploaded_recordings.py` 全量回归通过（共 30 项）；
- `deploy/aliyun/test_meeting_ai_chart.py` 22 项通过。

**待做（本次未触碰，按客户端分批）**
1. **Web 客户端**：`RecordingUpload.tsx` 按 `direct_upload_available` 选择分支，
   `fetch` + `PUT` 到 `upload_url`（需带 `headers`），再调 complete；
   进度用 `XMLHttpRequest.upload.onprogress`（`fetch` 无上传进度）。
2. **Android 客户端**：`RecordingUploadRepository` 同样两步；用 OkHttp
   `RequestBody` 写进度回调。
3. **打开开关**：两端上线并各自回归后再置 `True`；届时 ingress 上限**无需改动**
   （直传不经 ingress）。
4. **配额**：6 GiB × 并发数 × 留存期是真实的存储成本，开启前需定
   `retention_mode` 与清理策略（`capture_retention` 已有基础）。

> 验收动线：导入一个 > 100 MiB 的视频 → 直传完成 → 转写成功 → 原文与纪要可用；
> 同时验证超限被拒、类型不符被拒、重复提交不产生第二个计费任务。
