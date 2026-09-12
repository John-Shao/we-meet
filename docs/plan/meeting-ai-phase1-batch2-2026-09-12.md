# 会议 AI 阶段 1：第二批执行记录

日期：2026-09-12。基线：`030faa4c`，此前代码已提交并推送。本批继续阶段 1，不进入阶段 2。

## 交付范围

完成旧来源到确定记录的只读解析、资料列表范围筛选、回填报告增强，以及 Web 对应类型/查询。开关仍为 `MEETING_RECORDS_ENABLED`，默认关闭。没有新增数据库迁移，没有在业务环境回填或启用入口。

### 来源链接解析

新增 `GET /api/v1.0/meeting-records/resolve/`，成功返回与详情一致的 MeetingRecord 对象，客户端之后固定使用返回的 record.id。

| 参数 | 行为 |
| --- | --- |
| `meeting_session_id` | 只解析该场次；记录未投影、不存在或无权限均返回 404 |
| `room_id` + `meeting_session_id` | 同时校验房间与场次；不匹配返回 404 |
| `summary_id` | 必须有对应记录的纪要读权限，且旧纪要房间与场次一致 |
| 仅 `room_id` | 只有房间唯一场次且对应记录可见时成功；有其他场次时返回 409 `ambiguous_source`，包括其他场次尚无材料的情况 |

无权限的复用房间返回 404，不向调用者泄露场次数量或候选 ID。不存在的映射不会通过 GET 自动创建，也不回退到房间最新材料。无参数、非法 UUID、不支持或冲突的参数组合返回 400。响应使用 `private, no-store`。

该接口是旧链接的后端解析能力。现有 Web/Android 路由还未自动跳转至新资料页面；本批 Web 提供 `useResolveMeetingRecord` 和互斥来源参数类型。页面集成时必须展示 409 的选场次状态，不能自己重试“最新场次”。

### 列表范围

`GET /api/v1.0/meeting-records/?scope=...` 新增以下筛选。所有范围都在组织资格、来源一致性和材料授权过滤之后执行，不扩张可见范围。

| scope | 含义 |
| --- | --- |
| recent（默认） | 当前可见记录，沿用 origin_at/id 排序 |
| owned | 自有独立记录，或当前拥有源 Room owner 角色的线上记录 |
| participated | 存在该用户与该场次的参会关系，且记录已获读授权；重复进入不重复返回 |
| shared | 对该用户存在显式有效记录读授权，排除 owned；不将所有同组织记录算作分享 |

`participated` 与 `owned/shared` 可以重叠，它们是视图筛选而非互斥文件夹。未知 scope 返回 400。Web 列表类型、查询键同步包含 scope。

### 旧权限映射边界

| 已有关系 | 兼容处理 |
| --- | --- |
| 当前 Room ResourceAccess | 在符合记录组织与来源约束时，继续用于线上记录读权限；撤销后按当前状态校验 |
| 单个 RecordingAccess（个人或团队） | 保留原录制 API 的文件级授权；不复制成整场记录的原文/纪要读授权 |
| 参会、公开入会、组织成员 | 不隐式创建 MeetingRecordAccess |
| 显式 record 纪要分享 | 可读纪要和解析其来源；不自动取得原文、媒体或管理权限 |

录音文件只包含部分时段，不能把文件访问权扩成整场材料访问权。因此本批不提供 recording_id → 整场记录的授权转换；旧文件链接继续按旧录制权限访问。后续媒体入口应保留逐资产校验，而不是无条件复制 ACL。

### 回填核对

```sh
# 默认只读，按类别输出最多 20 个 UUID 样本
python manage.py backfill_meeting_records --sample-limit 20
# 严格核对：有未回填/未归属/来源冲突/来源已删除的记录即非零退出
python manage.py backfill_meeting_records --strict
# 显式写入，再核对剩余差异；重复运行不会重复建记录
python manage.py backfill_meeting_records --apply --strict
```

新增字段：remaining_sessions、orphan_records、apply_conflicts、ready、samples。conflicts 现在在 dry-run 中也检测来源漂移；apply_conflicts 记录本次创建尝试发生的冲突。保留原有 eligible_sessions、existing_records（写入前）、created、unresolved、mismatched_room。

样本只含 UUID，不含标题、发言内容、姓名或密钥。`--sample-limit` 范围 0–100，设为 0 时只输出计数。`--strict` 不更改数据修复策略；源已删除的记录须单独核对，不自动重新绑定。apply 保持每场次独立事务，严格检查失败不会撤销此前已完成的正确投影。

ready 只表示本次计数未发现待处理差异，不代表权限、模型质量或生产发布已验收。在线业务持续写入时计数不是全库一致性快照，正式演练应控制写入窗口并在结束后再次核对。报告中出现正常历史删除也会使 strict 失败，需要保留人工核对结果。

## 验证

- 新增兼容测试 18 项，加首批记录测试 25 项，共 43 项通过：来源解析、复用房间歧义、不可见资源、跨房间参数、无映射不写入、仅纪要权限、旧录制权限不扩张、四种范围、参会去重/撤权、dry-run/apply/strict、报告脱敏和来源冲突。
- 旧 Room 最新场次接口 2 项通过，保持旧入口行为。
- 扩展运行旧录制详情文件：13 项中 7 项通过，6 项失败。在同一隔离容器中导出并测试上一提交 `030faa4c` 的后端副本，复现相同 6 项失败。两项为中英文错误文案预期，四项为旧快照未包含 Room 的 created_at/closed_at/scheduled_at 字段；本批不修改这些接口或基线测试，不宣称完整测试套件通过。
- Web `tsc -b`、ESLint、Prettier，以及改动 Python 文件 Ruff 通过；`makemigrations --check --dry-run` 无变化。

全部使用阶段 1 专用本地测试容器与数据库。未读取生产凭证、访问真实模型、发送消息或部署应用。

## 继续实施

本批 B02/B03 后端解析与核对工具完成；生产历史数据演练、旧深链端路由接入、媒体/问答/分享权限仍待推进。下一批优先 B01/B04 的原文与纪要版本、实际 Worker 接入及并发写入保护，再对齐 Web/Android 页面。M1 保持未完整验收。
