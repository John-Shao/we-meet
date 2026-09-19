# 线上会议媒体时间轴（会中录制 → 会议实录可回放）

目标：让**线上会议**的录制出现在「会议实录」里并可回放，与逐字稿双向同步。

---

## 1. 核实结论：不是「只差暴露接口」

我在差距分析里把这一项写成「数据模型已存在，只差 serializer/view/route」。**核实后这是错的**：

```
MeetingMediaSegment 生产写入点：0 处
  → 只在 core/models.py 定义
  → 只有 core/tests/services/{test_meeting_captures,test_meeting_records}.py 构造过行

core/api/ 中引用 MeetingMediaSegment / media_segments：0 处
```

也就是说：**这张表从来没有被任何生产代码写过，也从来没有任何接口读过它。**
它是为这条链路预先建好的模型，但链路本身没建。

配套事实：

| 事实 | 证据 |
|---|---|
| 云录制会建 `Recording`（含 `session`），但**不建时间轴** | `cloud_recording.py:137-146` 只写 `Recording` + `RecordingAccess` |
| `Recording` 变 `saved` 的时机是**存储钩子** | `viewsets.py:2317-2333`（`is_savable()` → `status = saved`） |
| Web **完全没有云录制 UI** | `features/meetings/**` 无 `CloudRecording` 引用 |
| Android **有**云录制协调器 | `CloudRecordingCoordinator.kt`、`CloudRecordingApi.kt` |

**好消息**：模型自身的约束**已经为这条链路写好了**。`MeetingMediaSegment.clean()`
（`models.py:1659-1673`）要求：`recording.session_id == record.meeting_session_id`
且 `recording.room_id == record.meeting_session.room_id`。线上会议的录制天然满足 ——
缺的只是**有人去写这一行**，以及**把它读出来**。

---

## 2. 为什么云录制 UI 不在本特性内（但会成为门槛）

Web 没有任何创建云录制的入口，所以**即使本特性全部做完，Web 用户仍然无法产生一场带录制的会议**。
Android 能创建。因此：

- 本特性的验收必须在**有录制来源**的前提下进行（Android 录制，或直接构造数据）；
- Web 的录制入口是**另一个功能**（会中控制），已由用户确认**本轮不处理、仅记录**。

这条依赖必须写在最前面，否则会出现「功能做完但没人能用」的假完成。

---

## 3. 时间基准：本特性真正的技术核心

这是不能靠推理蒙过去的一步。

| 来源 | 逐字稿时间字段 | 与记录时钟的关系 |
|---|---|---|
| 采集 / 上传 | `MeetingOriginalSegment.start_ms` | **就是**记录时钟（相对记录原点） |
| 线上会议 | `Transcript.started_at`（绝对时间） | 需换算：`started_at - meeting_session.started_at` |

而 `MeetingRecord.origin_at` 就取自 `meeting_session.started_at`
（`meeting_records.py:ensure_online_record` 的 defaults）。所以换算是一次简单相减 ——
**但它必须由服务端做一次并作为契约固定下来**，而不是让 Web 和 Android 各自减一遍：
两端各算一次，就是两个可能在夏令时/时区/时钟偏移上分叉的实现。

**决策**：逐字稿投影统一输出记录时钟的毫秒字段，客户端只消费。

---

## 4. 设计

### D1 建立关联（写入侧）

在录制进入 `saved` 的**同一事务之后**，幂等地建立一行 `MeetingMediaSegment`：

```python
MeetingMediaSegment(
    record=<该 session 的 MeetingRecord>,
    recording=recording,
    sequence=1,
    record_start_ms=0,        # 录制即整场，起点就是记录起点
    duration_ms=<记录时长，若可得>,
    checksum="",
)
```

要点：

- **幂等键**：`UniqueConstraint(record, sequence)` 已存在；再加一层
  「同一 recording 只对应一行」（`recording` 是 `OneToOneField`，模型已保证）。
- **触发点**：`StorageEventReceived` handler 之后（那里才是 `saved`）。
  同步失败**不能**让存储钩子失败 —— 记录与录制是两个关注点，钩子失败会丢媒体通知。
- **不改 `clean()`、不加字段、不迁移**：模型已经够用。
- **回填**：本特性上线前已存在的 `saved` 录制没有对应行。需要一个一次性管理命令，
  而不是迁移里写数据逻辑（迁移应当只改结构）。

### D2 暴露时间轴（读取侧）

在 `MeetingRecordViewSet` 增加 `media-segments` 动作，返回记录时钟上的媒体片段：

```
GET /api/v1.0/meeting-records/{id}/media-segments/
  → { results: [ { sequence, record_start_ms, duration_ms, media: {...} } ] }
```

`media` 复用**上传件那套已实现的签名读取**（`media_read_url`）—— 但要注意：

> ⚠️ `media_read_url(job)` 现在签名的是 `UploadedRecording.storage_name`。
> 线上录制是旧 `Recording` 对象，键在**另一个桶**，其读取走
> `/recordings/media-auth/` + nginx subrequest（`viewsets.py:2376`）。
> **两条读取路径必须先收敛，否则 D2 会变成第三套签名逻辑。**

这是本设计里**最需要先决断**的一点，见 §6 开放问题 1。

### D3 时基统一

上表已述。实现上把线上逐字稿的 `started_at` 换算成记录时钟毫秒，
与 `MeetingOriginalSegment.start_ms` 对齐；两端的 `activeRowId` 判定**不需要改**，
因为它们已经在消费「记录时钟的毫秒」。

### D4 客户端回放

- **Web**：`<video>`/`<audio>` + 签名 URL + Range —— 与上传件播放器同构，
  `seekTo()` 与 `useTranscriptFollow` 直接复用；
- **Android**：`UploadMediaEngine`（`MediaPlayer`）本身与来源无关，
  只需喂给它录制的签名 URL。**这是本特性里最便宜的一块**，因为前两步已经把地基铺好。

---

## 5. 分期与验收

| 期 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| **M1** | D1 建立关联 + 回填命令 + 单测 | 无 | 录制 saved 后，该 session 的记录下存在一行 `MeetingMediaSegment`；重复触发不产生第二行 |
| **M2** | §6-1 读取路径收敛 + D2 端点 | M1、开放问题 1 | 端点返回记录时钟的片段；非本人/无录制时不返回 |
| **M3** | D3 时基统一 + D4 两端回放与同步 | M2 | Android 录一场会 → 结束 → 实录里可回放 → 逐句高亮跟随 → 点时间戳跳转 |

**M3 的验收必须用真实录制**。用构造数据只能验到 M2。

---

## 6. 已核实的阻塞项（不是开放问题）

### 6.1 🔴 `saved` 在生产**永远不会到达**

```
生产：RECORDING_STORAGE_EVENT_ENABLE = "False"
      RECORDING_ENABLE               = "True"
      MEETING_CLOUD_RECORDING_ENABLED = "True"
```

`saved` 只有一条写入路径 —— **存储钩子**（`viewsets.py:2317-2333`，`@FeatureFlag.require("storage_event")`）。
而云录制 worker **从不**设置任何 saved 状态：

```
core/services 与 core/recording 中 NOTIFICATION_SUCCEEDED / RecordingStatusChoices.SAVED：0 命中
worker 的终止状态只有 succeeded/failed/aborted/incomplete（CloudRecordingCommand）
```

所以在本设计原本选定的触发点（`saved`）上，**生产环境永远不会触发 D1**。

**连带后果**：`Recording.is_saved` 为假 → 旧读取路径 `/recordings/media-auth/`
（`viewsets.py:2414` 检查 `is_saved`）在生产也**拒绝服务**。

即：线上会议录制在**当前生产配置下既不会入库时间轴、也无法被读出来**。
这不是本特性要修的 bug，但它决定本特性**根本无从验收**。

### 6.2 `Recording` 没有时长字段

字段只有 `status` / `worker_id` / `options`（`models.py` 的 `Recording`）。
`duration_ms` 拿不到 ⇒ 时间轴只有起点、没有长度。
后果：`nearestStartedRowId` 仍可用（"最后开始的一句"），
但**缺口无法表达** —— 与采集路径（manifest 显式记录 gap）相比是能力缺失。

### 6.3 Web 没有录制入口

Web 端 `features/meetings/**` 无任何 `CloudRecording` 引用；Android 有协调器。
因此 Web 用户无法产生带录制的会议（用户已确认本轮不处理，仅记录）。

---

### 6.4 根因：录制基础设施**从未部署**（不只是开关关了）

生产 `values.meet.yaml` 自己写明了：

```
#   - Recording disabled (待第二阶段加 livekit-egress + 第二台 ECS)
RECORDING_ENABLE: "True"
RECORDING_STORAGE_EVENT_ENABLE: "False"
# Recording-related ingresses disabled (recording disabled v1)
ingressMedia:
  enabled: false
```

三点合起来是完整的：**没有 livekit-egress 工作负载**、**媒体桶通知关闭**、
**媒体 ingress 关闭**。所以：

- 没有 egress ⇒ 不会产生录制文件；
- 没有桶通知 ⇒ `saved` 永不置位（§6.1）；
- `ingressMedia.enabled: false` ⇒ **连媒体都取不到** —— 线上录制的读取正是
  nginx subrequest `/recordings/media-auth/` + 该 ingress 代理。

而同一份文件里 `MEETING_CLOUD_RECORDING_ENABLED: "True"`。
该开关只说「已配置 screen 录制 worker」由 `RECORDING_WORKER_CLASSES` 决定，
它**不等于**基础设施已就绪 —— 这是一处会误导人的配置组合。

**结论**：线上会议媒体时间轴是**第二阶段基础设施项**，依赖
「livekit-egress + 第二台 ECS + 媒体 ingress」。它不是应用层能单独完成的功能。

---

## 7. 动手前必须先决断

1. **先修 6.1/6.4，还是先做 M1 的关联逻辑？**
   - A. 先弄清 `RECORDING_STORAGE_EVENT_ENABLE` 为何在生产为 False
     （安全？未配置桶通知？），再决定触发点。
     **推荐** —— 否则 M1 写完也无法验收。
   - B. 换触发点：在 egress 完成/stop 确认时建立关联，不等 `saved`。
     可行，但要确认那时**媒体是否已经落桶**，否则会建出一条指向不存在媒体的时间轴
     （比没有更糟：客户端会拿到签名 URL 却 404）。
   - C. 照旧在 `saved` 埋点，同时把事情做完但**只在能开启开关的环境验收**。
2. **两条媒体读取路径要不要先收敛？**（原 §6-1）
   上传件与线上录制各自一套签名，D2 如果各写一遍，这个模块会有三处签名逻辑。
   - A. 先收敛成一条（推荐，但动到旧录制路径，影响面大）
   - B. D2 另写一套并**明确记债**
3. **录制与逐字稿的覆盖差异**：录制可能只覆盖会议的一部分（中途才开始录），
   而逐字稿覆盖全程。公共区间需定义，否则会出现「时间轴说从 0 开始，
   但录制其实从第 10 分钟开始」。

---

## 8. 我目前**没有**做的

- 没有写任何 D1/D2/D3 代码 —— 本文档只到设计；
- 没有动 `MeetingMediaSegment` 模型（已确认够用）；
- 没有碰旧 `Recording` 读取路径（§5-2 未决）。

§6.1 是**阻塞项而非开放问题**：触发点在生产永远不会到达，所以本特性此刻连
「能否验收」都不确定。在这种情况下先写 D1 的代码是没有意义的 ——
会写出一个只能在本地构造数据下通过的实现，然后被当成已完成。

**下一步应当先查清 `RECORDING_STORAGE_EVENT_ENABLE` 生产为 False 的原因**
（是桶通知未配置，还是出于安全考虑刻意关闭）。这个答案同时决定：
本特性的触发点、旧录制读取路径是否本来就是坏的、以及 Web 录制入口是否值得做。

