# 会议 AI 阶段 1：第六批执行记录

日期：2026-09-13。基线：`3576245c`，开始时已推送且工作区干净。本批完成独立采集控制、来源受限的原文写入和断点查询协议。M1 仍在进行，尚未交付可使用麦克风的独立录音产品。

## 数据与权限

迁移 `0152_independent_capture_protocol`：

- CaptureSession 增加 lease_hash；旧行为空，不能直接使用新控制协议，不自动为历史设备签发租约。
- CaptureOperation 保存用户全局幂等键、采集、规范化载荷和历史控制结果。租约只保存 SHA-256 摘要，响应不返回租约。
- MeetingSpeaker 按 record/capture/source_track/source_key 隔离，只允许 diarized、unknown；没有 authenticated 或 user_id，不把线下发言人猜成账户。
- MeetingOriginalSegment 保存独立原文、来源序号、时间偏移、speaker、ingest_id 和载荷摘要。只接受非空 final；ingest_id 全局唯一，采集+音轨+序号唯一。

独立原文不要求 Room 或 MeetingSession，旧 Transcript 保持兼容。正常 model save 不允许改写 Speaker 和原文；段落 revision 固定为 1。编辑、说话人重命名需要后续修订协议，本批不提供 PATCH。

新建采集同时创建默认私有的 audio_recording 笔记，状态 preparing。组织沿用目录选择顺序：有效成员的 primary 优先、created_at 次序；无有效成员关系时是个人记录，选中的组织停用则拒绝。客户端不能指定 owner、organization 或伪造线上来源。多组织显式切换仍需后续统一租户上下文。

设备状态、控制和回执仅当前创建者可访问，每次操作检查当前所有权、账户活跃状态和组织成员资格。原文、说话人读取另查 read_transcript；只分享纪要不暴露说话人，也不允许控制采集。设备字符串不是授权凭据。

## 公共 API

均位于 `/api/v1.0/`，沿用现有登录鉴权，响应 `Cache-Control: private, no-store`。

| 接口 | 契约 |
| --- | --- |
| POST capture-sessions/ | device_id、随机 UUID v4 lease_key、retention_mode=media/text、可选 title；201 创建 preparing 笔记和采集 |
| GET capture-sessions/{id}/ | 创建者重入查询当前控制状态 |
| POST capture-sessions/{id}/commands/ | command、device_id、expected_revision；另带 X-Capture-Lease，成功 200 |
| GET capture-sessions/{id}/transcript-receipts/ | source_track_id、after_sequence（默认 0）；最多 200 个实际收到的 id/ingest_id/source_sequence，next_after_sequence 续页 |
| GET meeting-records/{id}/original-segments/ | 原文按 start_ms/id 游标分页，每页 30；可按 speaker_id 筛选 |
| GET meeting-records/{id}/speakers/ | 说话人按创建顺序游标分页，每页 30 |

控制 POST 需要 UUID Idempotency-Key。同用户同键同载荷返回原操作；换采集、操作、租约或预期版本返回 409。同设备已有未 stopped 采集时新创建返回 409，不留下新记录。用户行锁串行化创建/控制，记录行锁串行化同记录的控制和原文写入。

返回 operation_id、replayed、result、capture。result 是原操作的历史结果，capture 是响应前重读的当前状态。重放旧 start 时若已经 paused，不能用历史 result 覆盖当前 capture。创建重放返回 200。控制 POST 每用户每分钟 60 次，读取不消耗此单独额度；沿用 DRF 缓存限流，不是严格配额。

公共 CORS 请求头新增 x-capture-lease，Origin/CSRF 约束保持原配置。Web 增加 `ApiCaptureSession.ts` 同步协议类型；本批没有录音按钮，record.capture 仍不向现有 UI 宣告完整采集能力已交付。

## 状态与恢复

| command | 允许来源 | 目标 |
| --- | --- | --- |
| start | preparing | recording |
| pause | recording | paused |
| resume | paused / interrupted | recording |
| interrupt | preparing / recording / paused | interrupted |
| stop | preparing / recording / paused / interrupted | stopping |
| finalize | stopping | stopped |

每次有效控制推进 CaptureSession.revision。旧 expected_revision 不能改变状态；命令严格校验创建者、固定 device_id 和 lease_key。同设备恢复沿用原租约，另一设备不能覆盖活动租约。finalize 记录服务器 ended_at，仅代表客户端显式结束控制，不证明媒体、转写尾段或音频完整。

接入客户端必须持久保存 capture_id、device_id、随机 lease_key、未决操作的幂等键/载荷和源序号映射。租约应存设备安全存储，不放 URL、日志或聊天。网络结果不明时重放原键和载荷；确定 409 后先查状态和回执，再决定新操作。回执逐条核对，收到 1、3 不代表 2 已收到。

恢复沿用同一逻辑 source_track_id、source_sequence、ingest_id；来源真实改变（如说话人识别器重置）时使用新 track，不能悄悄重新映射旧标签。偏移相对 record.origin_at，服务端保留非负偏移和 end>=start，不压缩暂停间隔；设备单调时钟到服务器起点的映射尚待接入验证。

尚未提供租约丢失后的换机接管、自动心跳超时中断或媒体缺口检测。重入要求设备保留原租约。停止时应先排空网关队列再 finalize；提前 finalize 的迟到原文被拒绝，结果仍只标记 unverified。

## 内部原文接口

两接口必须有内部 X-Agent-Token，用户登录态或 writer_grant 单独不够。共享 Agent Token 和供应商密钥不得交给客户端。

1. `POST /api/agent/capture-writer-grants/`：capture_id、device_id、lease_key、expected_revision、source_track_id；重新检查所有权/成员资格和租约，返回 writer_grant、expires_in=300。
2. `POST /api/agent/record-transcripts/`：另带 X-Capture-Writer。载荷为 record_id、capture_id、ingest_id、source_track_id、source_sequence、start_ms、end_ms（可 null）、speaker_key、speaker_label、identity_type、text、language、final=true。拒绝未知字段、账户映射、partial、空白文本、非法时间。
3. 首次返回 201，精确重放 200，身份内容冲突或同序号换 ingest_id 返回 409。重放也核对持久原文，异常外部改写不能得到假 ACK。

签名绑定 capture、record、owner、track、控制 revision，5 分钟到期。控制变化使旧 grant 失效；网关按当前租约和 revision 重新申请，原文重试保留 ingest_id，grant 不计入内容摘要。recording/paused/stopping 可签发和接收尾段；preparing/interrupted/stopped 拒绝。恢复后新 grant 可精确重放旧文本，不重复推进 record.revision。

新原文、Speaker、record.revision 在同一事务写入，旧 queued/running 派生任务取消为 source_changed。控制 revision 与原文 revision 分开，文字到达不会让控制客户端丢失版本。该接口尚未连接真实 ASR 网关，也未把独立原文接入第五批的线上纪要生成入口。

## 完整性与上线边界

没有真实音频落盘，retention_mode 只是后续保留偏好。返回 media_status=not_connected、captured_duration_ms=null、missing_ranges=null、coverage_status=unverified。last_acked_sequence 保留音频分片含义，原文不推进它，新采集仍为 0。文字时间区间不证明音频连续，null 结束偏移不猜成下一句起点，不产生媒体 URL。

新增 `MEETING_CAPTURE_PROTOCOL_ENABLED=false`，与 MEETING_RECORDS_ENABLED 同开才启用上述新接口。灰度顺序：迁移 → 可信服务端配置原有 Agent Token → 协议开关。回退关闭开关并保留数据表，不反向删表。线上旧逐字稿、纪要、Web 详情沿用原链路。

## 验证与下一批

- 新增 26 项测试通过：设备/租约/版本、幂等状态重放、停止和尾段、签名到期/篡改、跨记录/音轨、说话人隔离、原文不变性与异常修改、权限/撤权、分页、回滚，以及真实 PostgreSQL 双连接创建和控制并发。
- 扩大后端回归 124 项通过；随后增加 3 项并重跑本批 26 项通过，共覆盖 127 个不同后端用例。旧 Room retrieve 基线失败未扩大修复，不宣称整库全绿。
- 0152 在专用 PostgreSQL 迁移成功；makemigrations 无差异、Django system check 通过。新增/修改的接口、服务、测试、迁移 Ruff 通过；models.py 保留两处原有 DJ012。
- 前端类型 Prettier、ESLint、tsc -b 通过。本批无 UI 改动，未重复完整 Vite 构建或浏览器测试。
- 使用隔离本地环境与测试内部凭据，没有生产密钥读取、真实模型调用、采集设备测试、IM 发送或生产部署；环境仍非完整锁文件 CI 重建。

下一批优先将已选 ASR/Qwen 接到实际会议音轨，验证识别尾段和音频结束证明。独立采集随后补网关、媒体上传/校验/连续 ACK、设备时间轴与持久恢复、独立纪要快照和端页面。Speaker 编辑修订、Android 对齐、任务转换和通知继续按主计划推进。
