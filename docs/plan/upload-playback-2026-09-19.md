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

- **名称为空**：`UploadedRecording.configuration["_file"]["name"]` 对**直传路径**存的是
  `Path(storage_name).name`（随机 UUID 文件名，**不含真实后缀之外的信息**），走 multipart 的才是
  上传时的原始文件名。所以直传来的记录 `name` 是 UUID 形状。**若要展示原始文件名，需要在直传
  complete 时把客户端声明的 `name` 落库**——本次未做。
- **签名 URL 会过期**：3600s。客户端必须把它当作"短期凭证"，过期后重新解析，不能长期缓存。
- **播放器未接线**：两端仍是 chunked-only。Web `<audio>` / Android ExoPlayer 的整文件分支**待做**。
- **上传件仍不产生 manifest**：这是有意的，不是遗漏。

## 待做（客户端，下一步）

1. **Web**：`MeetingRecordWorkspace` 的 `text` Tab 对 `upload` 分支渲染 `<audio src={url}>`，
   把 `onTimeUpdate`/`currentTime` 接进已有的 `usePlaybackFollow`；
   `onSeek` 改为设 `currentTime` 而非 `player.current.seek`（整文件无分块）。
2. **Android**：ExoPlayer（或 `MediaPlayer`）承载整文件分支；
   同步复用 `activeRowId` + `LazyListState`，与采集路径共用同一套判定。
3. **打开开关前**：确认 3600s TTL 对大于 1 小时的文件够用（Range 续读用的是同一个 URL）。
4. **产品确认**：播放是否跟随逐字稿读权（共享读者能否回听）。

## 验证

- 新增 `core/tests/services/test_upload_media_read.py`：4 项（签名形状与 TTL、size/type 透出、
  text-only 拒绝、他人拒绝、非 upload 来源拒绝）。
- 回归：`test_meeting_records` + `test_uploaded_recordings` + `test_direct_uploads` + 新增
  共 **59 passed**。
