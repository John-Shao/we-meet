# 会议纪要闭环打磨(P0-3)— 设计文档

状态:设计待拍板(先评审,拍板再开干)
对标:飞书 AI Notes(自评 M4)、钉钉 AI听记 8.1.5 图文纪要
调研依据:`docs/research/competitor-gap-feishu-wecom-dingtalk-2026-07.md` §五 P0-3

---

## 1. 背景与差距

我方纪要管线雏形完整(生成→行动项→推 IM 群→落 La Suite Docs→链入 RAG embeddings),
但对标竞品闭环,差在四点:

| # | 差距 | 飞书基线 | 钉钉基线 |
|---|---|---|---|
| G1 | 无「智能章节」 | Smart chapters(三板块之一) | 图文纪要章节(含时间轴) |
| G2 | 纪要不可编辑(in-app) | AI Notes 有权限者可直接编辑 | 纪要可编辑 |
| G3 | IM 推送是一条纯文本链接,无卡片、无路由 | 机器人三路由:会议群/私聊/Assistant,推送即摘要卡片 | 待办一键同步 |
| G4 | 三板块没有结构化组织(前端只有 摘要/行动项 两个平铺 tab) | 固定三板块:Summary / Action items / Smart chapters | 全览图+章节 |

## 2. 现状锚点(代码)

- 服务:`src/backend/core/services/meeting_summary.py`
  - `generate()`:两次 LLM 调用(摘要 Markdown、行动项 JSON)→ `_persist()`(事务内 update_or_create Summary + 全删重建 ActionItem)→ `_push_summary_to_im()` → `_push_summary_to_doc()`
  - IM 推送:仅会议群(`MeetingConversation.cid`),正文 `📋 会议纪要已生成: <link>`,幂等靠 `summary_pushed_at`
  - Doc 推送:仅归属 OWNER,幂等靠 MeetingDoc 行存在
- 触发:`core/services/livekit_events._handle_room_finished` → `core/tasks/summary.generate_meeting_summary`(延时,等 FINAL 转写落库)→ 成功后链 `embed_meeting_transcripts`
- 模型:`Summary`(room OneToOne,content 单块 Markdown)、`ActionItem`(owner_text/due_text 自由文本,is_completed 已有)、`MeetingConversation.summary_pushed_at`
- 前端:`features/meetings/routes/MeetingDetail.tsx` — `summary` / `action-items` 两个 Tab + 手动重跑按钮;404 空态
- 数据条件:`Transcript` 有 `started_at` 时间戳 + speaker → 具备生成章节的全部输入

## 3. 目标 / 非目标

**目标**
1. 三板块结构化:摘要 / 行动项 / **智能章节**(新增),Web 端一屏组织。
2. 纪要 in-app 可编辑:保留 AI 原文,编辑落副本,可回滚。
3. IM 推送升级:摘要卡片式正文(标题+要点+行动项数+链接)+ 路由细化(会议群 → 群;无群的 1对1 会议 → 私聊)。

**非目标(明确不做)**
- 会中实时 summary(飞书会中 AI summary)——依赖 agent worker 流式改造,另立项。
- 行动项同步「待办中心」——we-meet 无待办模块;钉钉式同步待 IM/日历侧待办形态定型后再议。
- 录制/Minutes 内嵌(录制生产关闭)。
- 图文全览图/思维导图(钉钉 8.1.5 形态)——先补三板块,视觉化后置。
- 自定义纪要提示词(已因 prompt injection 风险搁置)。

## 4. 设计

遵循「只扩展不修改」:新增模型/字段/服务方法,不改现有函数签名与幂等语义。

### D1 智能章节(G1)

**模型**(新增,migration 追加):

```python
class SummaryChapter(BaseModel):
    room = models.ForeignKey(Room, related_name="summary_chapters", on_delete=models.CASCADE)
    summary = models.ForeignKey(Summary, related_name="chapters", on_delete=models.CASCADE)
    title = models.CharField(max_length=200)
    digest = models.TextField(blank=True, default="")   # 该章节 1-3 句要点
    started_at = models.DateTimeField(null=True, blank=True)  # 对应转写时间窗
    ended_at = models.DateTimeField(null=True, blank=True)
    sort_order = models.PositiveSmallIntegerField(default=0)
```

**管线**:`generate()` 中追加第三次 LLM 调用(与行动项同级,软失败——章节抽取失败不影响摘要落库):

- 输入:与现有 `_format_transcripts()` 相同的 `[HH:MM:SS] speaker: text` 文本(时间戳已在)。
- 提示词:输出严格 JSON `{"chapters": [{"title", "digest", "start": "HH:MM:SS", "end": "HH:MM:SS"}]}`,3-8 个章节,遵循现有 `_parse_action_items` 的防御式解析风格(剥 Markdown 围栏、逐字段清洗)。
- `HH:MM:SS` → DateTime:用当日转写首条 `started_at` 的日期做锚点还原;跨零点会议按转写序单调递增修正。
- 持久化:进 `_persist()` 事务,与 ActionItem 一致「全删重建」,幂等语义不变。

### D2 三板块结构化展示(G4)

不改 `Summary.content` 语义(仍是 AI 摘要 Markdown)。三板块 = `content`(摘要)+ `action_items` + `chapters`,由 API 聚合、前端组织:

- 序列化:`SummarySerializer` 增加 `chapters` 嵌套 + `is_edited` / `effective_content`(见 D3)。
- Web:`MeetingDetail.tsx` 的 Tab 组从两个扩为三个(`summary` / `action-items` / `chapters`,新增 chapters TabPanel;章节条目点击 → 未来可跳转字幕时间点,本期仅展示)。i18n 四语言补 `chapters.*` key(参考现有 `locales/*/meetings.json`)。
- Android:`ui/history` 会议详情如已消费 summary 接口,则本期只保证接口向后兼容(新增字段可忽略),原生渲染章节列表放 M3(见 §7)。

### D3 纪要可编辑(G2)

**字段**(Summary 追加,不动 content):

```python
edited_content = models.TextField(blank=True, default="")      # 空 = 未编辑
edited_by = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, ...)
edited_at = models.DateTimeField(null=True, blank=True)
```

**语义**
- `effective_content = edited_content or content`;`is_edited = bool(edited_content)`。
- 重新生成(手动 regen / 转写补齐重跑):**只覆盖 `content`,不动 `edited_content`**;API 返回 `ai_updated_after_edit: bool`(`content` 更新时间 > `edited_at`),前端提示「AI 原文已更新,当前显示的是你的编辑版」并提供「查看 AI 原文 / 恢复 AI 版本」。恢复 = 清空 edited_content。
- 编辑不回写 La Suite Doc(Doc 是创建时快照,竞品同样不双向同步;文档内编辑走 Doc 自身)。

**API**(新增,不改现有端点):
- `PATCH /api/v1.0/rooms/{id}/summary/` body `{"edited_content": "..."}`;空字符串 = 恢复 AI 版本。
- 权限:房间 OWNER/ADMIN 可编辑(与飞书「组织者可调编辑权限」对齐,首期不做参会者全员可编);读权限沿用现有 summary 读取权限。
- 审计:写 `core/services/audit.py` 一条(编辑者/房间/时间)。

### D4 IM 推送升级(G3)

**卡片式正文**(纯文本协议内做卡片化排版,不依赖 jusi 服务端新消息类型):

```
📋 「{room.name}」会议纪要
{摘要前 2-3 条要点,取 content 中前 N 个列表项,截断 ~120 字}
✅ 行动项 {n} 条 · 📑 章节 {m} 个
{link}
```

要点提取为纯字符串处理(取 Markdown 列表行),不加 LLM 调用。

**路由**(扩展 `_push_summary_to_im`,新增私有方法,不改现有幂等字段):
1. `MeetingConversation` 存在 → 推会议群(现状,正文升级为卡片)。
2. 无会议群 **且** 会议实际参会人恰为 2 人(按 Transcript speaker / ResourceAccess 判定)→ 走 jusi admin 建/取 direct 会话推私聊。
   - ⚠️ 必须先 resolve `sub → jusi uid`(直接传裸 sub 会撞 FK 报 500,复用 `jusi_im.py` 现有 resolve 路径)。
   - 该路由挂 settings 开关 `SUMMARY_IM_DM_PUSH_ENABLE`(默认 False),灰度验证后再放开。
3. 其余(无群多人会议)→ 本期不推(避免多人私聊轰炸;飞书此场景由 Assistant 单聊承接,等我方「AI 助手 IM 入口」P1-5 落地后合并)。

幂等:沿用 `summary_pushed_at`(路由 1);路由 2 在 `MeetingConversation` 缺失时无该字段——在 Summary 上加 `dm_pushed_at`(migration 同批)。

### D5 提示词与模型配置

章节提示词进 `AIPrompt` 管理端配置(key: `summary_chapters`),缺省内置常量兜底——与现有 AI 全家桶配置(AIVendor/AIModel/AIPrompt)一致,不开放给终端用户(自定义提示词搁置决议不变)。

## 5. 兼容与部署

- 三条 migration(SummaryChapter 表、Summary 编辑字段、Summary.dm_pushed_at),全部纯新增,可安全回滚。
- ⚠️ 生产发布走 `helm upgrade`(只换镜像不触发 migrate hook 会报 relation does not exist)。
- API 只增字段/新端点,Web/Android 旧版本忽略新字段即可,无破坏性变更。
- LLM 成本:每会议 +1 次调用(章节);私聊推送 0 LLM 成本。

## 6. 测试与验收

- 单测(参照 `tests/services/test_meeting_summary_im_push.py` / `_doc_push.py` 风格):
  - 章节 JSON 解析防御(围栏/缺字段/非法时间戳/空章节)。
  - 编辑语义:regen 不覆盖编辑版、`ai_updated_after_edit`、空串恢复、权限拒绝。
  - 推送路由:有群走群、无群 2 人走 DM(开关关/开)、多人不推、`dm_pushed_at` 幂等、sub→uid resolve 失败降级不炸。
- 验收动线(端到端):开会 → 说话产生转写 → 结束 → 会议群收到卡片 → Web 详情页三板块齐 → 编辑摘要 → regen 后编辑版保留且有提示。
- 本机后端:先 build app-dev 再 `bin/pytest`;注意 jusi_meet_suite19 抢 15432/9000,只起 pg+redis + `--no-deps`。

## 7. 分期

| 期 | 内容 | 依赖 |
|---|---|---|
| M1 | D1 章节 + D2 Web 三板块 + D4 卡片正文(群路由) | 无 |
| M2 | D3 可编辑 + 审计 | M1 |
| M3 | D4 私聊路由(灰度开关)+ Android 章节渲染 | M1;jusi direct 会话 admin 建会话能力确认 |

## 8. 开放问题(拍板项)

1. 编辑权限首期只给 OWNER/ADMIN,还是放开到全体参会者(飞书默认全员可编、组织者可收紧)?
2. 无群多人会议的推送,是等 P1-5「AI 助手 IM 入口」统一承接,还是先给会议 OWNER 单发私聊?
3. 章节是否要在字幕/转写页做时间点跳转联动(本期仅展示)?
4. jusi-light-im 侧是否值得为「纪要卡片」加原生卡片消息类型(现方案纯文本排版)?若加,归入 jusi-light-im 的 P 阶段流程单独出设计。
