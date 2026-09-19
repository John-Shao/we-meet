# 上传件回放：整文件 + 签名 URL + Range

目标：让**导入的音视频**可以回放，并因此获得与逐字稿的双向同步（P0-5 媒体可达的一部分）。

## 为什么不是"放开一个 gate"

`record.capabilities.capture_id` 对 `upload` 一律返回 `None`（`meeting_records.py:223-224`）。
初看像是"一行 gate 挡住了播放"，**实际不是**：

```
CaptureAudioManifest.objects.create(...)   → 仅 core/services/capture_audio.py:249（实时采集路径）
uploaded_recordings.py 中 audio_manifest / CaptureAudioChunk / CaptureAudioManifest → 0 命中
```

上传件是**整文件存 S3**（`record-uploads/<uuid>.<ext>`）+ 一个 `UploadedRecording` 指针，**不切片、不建 manifest**。
所以即使放开 gate：

- `capture_state()` 会算出 `media_status = "not_connected"`（`meeting_captures.py:123-125`，无 manifest 也无 chunk）；
- 客户端 `playable`（要求 `saved`/`incomplete`）不成立 → 播放器根本不渲染；
- `audioPlaylist` 回空。

**chunked 播放器读不到上传件，因为它读的是一张不存在的表。**

## 决策：尊重两种数据形态，不强行归一

| | 实时采集 | 上传件 |
|---|---|---|
| 到达方式 | 录制中**增量** | 落盘即**已封口** |
| 缺口 | 真实存在，需显式表达 | 不存在 |
| 合适的播放 | 分块按需拉取 | 一个连续文件 |
| Range | 无意义 | **原生支持** |

给一个已封口的文件造 manifest + 切片 + 转码任务，等于**为了复用而制造一张本该不存在的表**。

因此上传件走：**后端签名一次 GET → 客户端直接读 → HTTP Range 原生 seek**。

## 已实现（后端）

```
GET /api/v1.0/meeting-records/{id}/media/
  → { url, expires_in, media_type, name, size, content_type }
```

服务层 `core/services/uploaded_recordings.py`：

- `media_available(job)` —— 仅在 `retention_mode == media`、有 `storage_name`、`size > 0` 时为真；
- `media_read_url(job)` —— 签一个 `get_object`，TTL 3600s。

授权（全部满足才签发，否则 404）：

1. `record.source_type == upload`（此路径不服务 `audio_recording` / `meeting`）；
2. `record.owner_id == request.user.pk`；
3. `_content_record("read_transcript")` —— 与记录读取同一条权限链；
4. `media_available(job)`。

**授权口径与采集路径一致**：`CaptureSessionViewSet.get_queryset` 本身就是 `created_by=user`
且 `owner=user`（`meeting_captures.py`），所以「仅所有者」不是新增收紧，而是既有规则。
**未做**：把播放放宽给"有逐字稿读权的共享读者"——那需要产品确认，见下。

## 已知边界（不要误读为已完成）

- **名称对直传来的记录是 UUID 形状**：`UploadedRecording.configuration["_file"]["name"]` 在**直传路径**
  存的是 `Path(storage_name).name`，即随机 UUID 文件名，不含上传时的真实名；只有 multipart 路径
  才保留原始文件名。**若要展示原始文件名，需要在直传 complete 时把客户端声明的 `name` 落库**——未做。
- **签名 URL 会过期**：3600s。客户端必须把它当作"短期凭证"，过期后重新解析，不能长期缓存。
- **上传件仍不产生 manifest**：这是有意的，不是遗漏。

## 两端接线（已完成）

**Web** —— `UploadMediaPlayer.tsx`

- 挂载时按需解析签名读取（`meeting-records/{id}/media/`），**不在打开页面时拉取 GB 级文件**；
- 原生 `<audio controls>`，seek 交给浏览器与 Range；
- `onTimeUpdate` → `onPosition`，接进已有的 `usePlaybackFollow`；`seek(ms)` → 设 `currentTime`；
- 工作区把两个播放器的 seek 收敛为一个 `seekTo()`；摘要引用的**时间重基准**只对采集成立
  （采集时钟从自己的 session 起算，上传件的时钟就是记录的时钟）。

**Android** —— `UploadMediaEngine.kt` + `UploadMediaPlayer.kt`

- `MediaPlayer` 整文件流式播放（**未引入 ExoPlayer/Media3**：`MediaPlayer` 原生支持 HTTP Range，
  为这一个用例拉进一个播放器库不划算）；
- audio focus 与 becoming-noisy 处理**与采集路径 `AndroidCapturePlaybackOutput` 对齐** ——
  同一个 App 里两条播放路径在来电时的行为不能不同；
- `WholeFilePlayback` 接口是给 fixture 的注入缝，UI 测试因此不需要真实流；
- 位置轮询 250ms（与采集引擎同频）→ `onPosition` → `playbackPositionMs` → `activeRowId`；
- 懒准备：不开屏即拉流。

**一个必须记下的差异**：Android 的 `media` 请求**没有** `Cache-Control: no-store` 注解，
因为服务端 `MeetingRecordViewSet.finalize_response` 已经给**每一个**响应加了
`Cache-Control: private, no-store`。我最初在一处注释里写成「这里特意不加」，那是错的 ——
实际上加了，只是不是在这一层加的。

## 验证

- 后端：`test_upload_media_read.py` 4 项；回归 59 项。
- Web：`UploadMediaPlayer.test.tsx` 5 项；全量 167 files / 1081 tests。
- Android：`MeetingRecordMediaTest`（6 项，含拒绝非 upload 来源、拒绝过期 revision、
  拒绝非 https / 无过期时间的读取）；`UploadMediaPlayerTest` **真机 4 项**
  （懒准备、精确 seek、位置上报、失败可见）。


## 仍未做

1. **签名 URL 的 TTL 未实测**：3600s 对大于 1 小时的文件够不够（Range 续读复用同一个 URL）
   需要在真实大文件上验证，不能只靠推理。
2. **播放权是否跟随逐字稿读权**：当前仅所有者可播（与采集路径一致）。共享读者能否回听是产品决策；
   放宽只需改后端一处判定，但**未经确认不做**。
3. **直传记录的文件名**：见上「已知边界」第一条，需要直传 complete 时把声明的 `name` 落库。
