# P11 — 群机器人（对标飞书）：自定义 webhook 机器人 + 内置助手

> 状态：**已上线生产并实测通过（2026-08-05）**。
>
> 三仓 8 个 commit：
> jusi-light-im `b74bfe5`（P23 `members.role='bot'`）；
> we-meet `95d22cfc`（模型/协议/webhook 接收端）→ `910ef189`（管理 API、头像出图、内置助手）→ `2470acc3`（Web）→ `6e8c98cc`（显式声明 Pillow）→ `8e9aee92`（helm 补 `BOT_WEBHOOK_BASE_URL`）→ `4319bd6b`（头像出图两处线上缺陷）；
> we-meet-android `c84b42f`。
>
> 上游设计文档：[`jusi-light-im/docs/phases/p23-bot-member-role.md`](https://github.com/John-Shao/jusi-light-im/blob/main/docs/phases/p23-bot-member-role.md)。
> 二期见 [`p11b-im-group-bots-cards.md`](./p11b-im-group-bots-cards.md)。

**这份文档补写于交付之后。** 主要理由是第 4 节：一期有 12 条运行时红线，此前只活在 commit body 里——那是个只有考古才找得到的地方，而其中至少三条（R3 发布顺序、R4 投递后断言、R10 下游触点）踩中的后果是**静默的**：不报错、不抛异常、HTTP 200，只是行为悄悄退化。

---

## 1. 背景与需求

对标飞书两件事：

1. **自定义机器人** —— 群主在群设置里建一个机器人，拿到一个 webhook 地址，外部服务 `POST` 一个 JSON 就能往群里发消息。CI 构建失败、监控告警、日报推送都走这条。
2. **内置助手** —— 会议纪要、日程变更、审批通知过去都以全零 SYSTEM 身份发出（居中灰条，没有头像和名字）。改成三个有脸的助手身份：会议助手 / 日程助手 / 审批助手。

**范围边界**：webhook 只**入站**（机器人往群里说话），机器人不接收消息、不响应 @、无开放平台、无应用机器人。这些是二期及以后。

---

## 2. 关键决策

| # | 决策 | 理由 |
|---|---|---|
| **D1** | **webhook 请求体、签名算法、错误码与飞书逐字兼容** | 这是功能的意义所在——团队原本推飞书的 CI 发包脚本**改一个 URL** 就能同时推到 we-meet。签名是 `key=f"{ts}\n{secret}"`、`data=b""`、base64，`timestamp`/`sign` 在 JSON body 顶层（不是 header），与我们自家的 jusi/push HMAC **完全不同**，别「顺手统一」 |
| **D2** | **机器人不建 Django `User` 行**，独立 `ImBot` + `ImBotInstallation` 两张表 | `resolve_users`/`_org_users_by_ids` 用 `is_device=False` 过滤真人。机器人既要躲在那个标记后面（不进通讯录/选人器）又要能被 resolve（气泡要显示名字头像），自相矛盾 |
| **D3** | 身份与安装**拆两张表** | jusi P23 之后 roster 不含机器人，「这个群有哪些机器人」只能本地回答；且内置助手是 **1 身份对 N 群** |
| **D4** | jusi 侧新增 `members.role='bot'`（P23） | 机器人**必须是成员**，否则 `admin/messages.go` 把 sender 静默改写成全零 SYSTEM。但 roster / 成员数 / 群主继承三处排除它。`ListMemberUIDs` **刻意不排除**——扇出和 sender 校验都靠它 |
| **D5** | **头像由服务端出图**，三端只读 `avatar_url` | 否则三端各实现一遍调色板，且离线推送没地方渲染。8 档色板存的是**下标** |
| **D6** | 管理面走标准 REST `/api/v1.0/im/bots/` | 双端都要普通 CRUD；而 `core/api/im.py` 那批全是无 pk 的 `@action`，不适合带 id 的资源 |
| **D7** | 权限 **owner-only**（建/改/删/看凭据），列表全体成员可读但凭据字段返回 `null` | webhook 是**往群里写**的凭据，「任何成员都能悄悄开一个」不成立；但「群里有什么在说话」大家都该看见 |
| **D8** | 富文本 `rich-text` **单语言扁平** | 飞书 post 带 `{zh_cn, en_us}` 外壳，但同一条 IM 消息不该按接收方 locale 变形。后端在 webhook 入口就拍平 |

---

## 3. 线上协议：`rich-text`（v1）

后端把飞书 `msg_type=post` 规范化成这个形状。**客户端只渲染、不构造。**

```json
{
  "v": 1,
  "title": "构建失败",
  "content": [
    [ {"tag":"text","text":"分支 main 构建失败 "},
      {"tag":"a","text":"查看日志","href":"https://ci.example.com/runs/1"} ],
    [ {"tag":"at","uid":"all","name":"所有人"},
      {"tag":"text","text":" 请处理"} ]
  ],
  "plain": "构建失败 分支 main 构建失败 查看日志 @所有人 请处理"
}
```

三条约定：

- **`plain` 是派生投影，客户端不得渲染它。** 它撑着三处零改动：会话列表预览、jusi 全文搜索的 tsvector 源、@我 检测。
- **`img` 降级成 `[图片]`** —— 机器人没有图片上传通道，`img_key` 永远 resolve 不出来。
- **非 `http(s)` 的 `href` 退成纯文本**，保住字、去掉链接。一条 `javascript:` href 就是一个可点的攻击面，而 webhook 正文是外部可控的。双端各有单测守着（Web `richText.test.ts`、Android `RichTextParserTest`）。

金标准 fixture：[`core/tests/fixtures/im_cards/rich_text_simple.json`](../../src/backend/core/tests/fixtures/im_cards/rich_text_simple.json) 与 [`rich_text_full.json`](../../src/backend/core/tests/fixtures/im_cards/rich_text_full.json)，**三端共读同一批文件**（后端 pytest / Web vitest / Android JVM 跨仓读）。

---

## 4. 运行时红线（R1–R12）

> **这一节是本文档存在的主要理由。** 每条都是「改这里的人不知道就会踩」，且多数踩了不报错。

### R1 — 审批私信换了会话，这是有意的

发送者从全零 SYSTEM 改成「审批助手」后，**cid 必然变**（direct 会话的 cid 由双方 uid 推导）。旧的 SYSTEM 私聊变成只读历史，旁边多出一个「审批助手」会话。

这更接近飞书的形态，**发布说明必须写**。不能把机器人加进旧会话保住 cid——direct 三成员语义就崩了。别当 bug 修回去。

### R2 — 日程助手只接管**降级分支**

日程卡片的主路径仍以**组织者身份**发送，那是 P8-UX 拍板的设计（见 [`p8-im-calendar-integration.md`](./p8-im-calendar-integration.md)）。只有拿不到组织者身份的降级分支才落到日程助手。**把主路径也改成助手是回归，不是统一。**

### R3 — 发布顺序：jusi 先升，we-meet 后升

反了的话 `add_bots` 被老 jusi 忽略 → 机器人不入群 → `POST /admin/messages` 把 sender **静默降级成全零 SYSTEM**，机器人消息全部退化成灰条，**且 HTTP 仍返回 200，没有任何报错**。

见 jusi P23 文档「兼容性」节。这条同样适用于以后任何「jusi 加字段、we-meet 用字段」的改动。

### R4 — 投递后必须断言 `sender_uid`

因为 R3 那个降级是静默的、没有异常可捕，`core/services/im_bots.py` 的 `post_as` 在投递**之后**比对 jusi 返回的 `sender_uid`。这是事后发现不是预防，但没有它就连事后都发现不了。改动投递路径时别把这个断言优化掉。

### R5 — 三层限流只有 settings 默认值，**没有写进 helm values**

`BotWebhookTokenThrottle` / `BotWebhookBurstThrottle` / `BotWebhookIPThrottle`（[`core/api/throttling.py:202-233`](../../src/backend/core/api/throttling.py#L202-L233)）与每群机器人数上限都只有代码里的默认值。

**这是刻意的**：被刷的时候用环境变量热调比现在钉死更有用。但代价是——**看 `values.meet.yaml` 看不出线上限流是多少**，要读代码。

### R6 — 迁移 `0080` 不触网、不写 `im_uid`

迁移跑在 helm `pre-upgrade` hook 里，**那个时点 jusi 可能还不可达**。所以 `0080_seed_builtin_bots.py` 用确定性的 uuid5 主键种三个内置助手，绝不调用 jusi 铸造 uid。uid 是运行时惰性铸造的（`resolve_bot_uid`）。

配套：`resolve_bot_uid` 对 jusi 返回的 uid 做**长度校验**后才落库——`im_uid` 是 36 字符列，畸形响应原本会在别人的审批流程中途炸出 `DataError`。

### R7 — `avatar_key` 必须以 `bot/` 开头

否则可以填别人的头像 key 冒名。服务端强校验，改头像逻辑时别绕过。

### R8 — 幂等窗口刻意短

显式 `X-Request-Id` 走 24 小时；没有它时按 body 哈希只挡 **10 秒**。窗口必须短——**监控机器人每分钟发同一条内容是合法流量**，不是重复投递。别「顺手」把它调长。

### R9 — 机器人标签绝不拼进名字字符串

双端都用**独立的 UI 元素/参数**渲染「机器人」标签，不做 `name + " [机器人]"`。

理由：名字字符串会被写进**引用条和合并转发快照并发到服务端**，拼了后缀就永久冻在历史里。这与 `nameWithDeparted`（离职标记）是同一条红线。

### R10 — 下游触点一个都不能漏，且**预览短路必须在 parse 之前**

新增一个 `content_type` 要同时改这些地方，漏一处就在某个界面漏出裸 JSON：

| 触点 | Web | Android |
|---|---|---|
| 会话列表预览 | `ImRoute.tsx` `previewOf` | `ChatViewModel` |
| 引用快照 | `ChatPane.tsx` `snippetOf` | `ChatViewModel.snippetOf` ⚠️ |
| 合并转发快照 | `ChatPane.tsx` | `ChatViewModel.mergedTextOf` ⚠️ |
| 原样转发白名单 | `ImRoute.tsx` `forwardOne` | `forward` |
| 右键复制 | `ChatPane.tsx` `copyText` | — |
| 置顶栏 | `PinnedBar.tsx` | — |
| 气泡渲染 | `MessageItem.tsx` | `MessageBubble.kt` |

⚠️ 标记的两处是 Android 的 `mergedTextOf` 和 `snippetOf`：它们带 `else -> ""`，**Kotlin 编译器不会提醒**。`MessageBubble` 的 sealed 分发会报错，那两处不会——漏了就是引用/合并转发拿到空快照。

**预览短路必须在 parse 之前**：jusi 的 200 字截断会切坏 JSON，但服务端给的 `plain` 截断了仍是人话。先 parse 再短路 = 预览恒空。

### R11 — `@所有人` 的 locale 限制（二期已部分治理）

后端写进 `plain` 的 `AT_EVERYONE` 恒为中文 `@所有人`，而客户端的匹配词来自各自 locale 资源（Android `im_mention_everyone`：en=`Everyone`、de=`Alle`…）。所以**非中文用户对机器人的 @所有人 过去完全无感**。

**当前状态**：Android 已改为**结构判定**（`at` 标签 `uid == "all"`），对全部 5 个语种成立（`we-meet-android` `60e12df`，二期 C2(a)）。**尚未治理**的是人手发的纯文本——`client.sendText()` 直连 jusi 不过后端，**没有任何服务端归一化点**，只能靠客户端别名集合，见二期 C2(b)。

另有一条已知遗留：jusi 侧完全不做 mention 判定，`mute_at_all` 是纯客户端标志——设了「@所有人不提示」的人**离线推送照样会被吵到**。

### R12 — 降级路径的 `catch` 里至少要 `logger.error`

**这条是被一次线上事故买来的**（`4319bd6b`）。机器人头像出图从上线起就**从来没成功过**，`avatar_key` 恒为空串，Web 退回按名字哈希取色显示品红，而用户挑的是 0 号蓝、Android 也是蓝——**两端颜色对不上**才暴露出来。

两个独立原因，都被 `except Exception: return ""` 吞了：

1. **boto3 ≥1.36 默认给每个 PUT 加 CRC32 校验头，阿里云 OSS 不认。** 代码库其余的 OSS 写入全是 `generate_presigned_url`（签个 URL 让客户端自己 PUT，boto3 从不碰 OSS），所以这个不兼容一直没暴露——`render_bot_avatar_swatch` 是**第一处真正的服务端直写**，一上来就撞上。修在 `core/utils.py` 的 `_profile_s3_client()` 里（`request_checksum_calculation="when_required"`），不靠部署环境变量，这样本地/测试/任何部署一致。
2. **Pillow 自带字体没有中文字形。** `测` 和 `构` 渲染出来 bbox 与像素数**完全相同**——那是 notdef 豆腐块不是字形。改成用矢量图元画机器人图标（`_draw_bot_glyph`），跟语言无关。

日志级别从 `warning` 提到 `error`——**静默降级正是这次没人发现的原因**。

---

## 5. 三仓改动面

### jusi-light-im（`b74bfe5`）

`schema/009_member_role_bot.sql` 放宽 `members_role_check` 并加 `members_cid_role_idx`；`ListMembers`/`EarliestOtherMember`/`array_agg`/两个群主转让函数加 `AND role <> 'bot'`；`addMembersRequest` 加 `AddBots`。详见上游 P23 文档。

### we-meet 后端

| 文件 | 内容 |
|---|---|
| [`core/models.py`](../../src/backend/core/models.py) | `ImBot`（身份）、`ImBotInstallation`（安装 + 凭据 + 三项安全设置）、5 个审计动作 |
| [`0079_im_bot.py`](../../src/backend/core/migrations/0079_im_bot.py) / [`0080_seed_builtin_bots.py`](../../src/backend/core/migrations/0080_seed_builtin_bots.py) | 建表 / 种内置助手（见 R6） |
| [`core/services/im_bots.py`](../../src/backend/core/services/im_bots.py) | uid 惰性铸造 + 入群缓存 + `post_as`（含 R4 断言）+ `post_as_builtin`（永不抛） |
| [`core/services/bot_webhook.py`](../../src/backend/core/services/bot_webhook.py) | 飞书签名/错误码、三道闸门、`build_message`（text + post → rich-text） |
| [`core/api/bot_webhook.py`](../../src/backend/core/api/bot_webhook.py) | `POST /api/bot/v1/hook/<token>`（**两种斜杠变体都注册**——`APPEND_SLASH` 的 301 会丢掉 POST body） |
| [`core/api/im_bots.py`](../../src/backend/core/api/im_bots.py) | 管理 REST（D6/D7） |
| [`core/utils.py`](../../src/backend/core/utils.py) | `render_bot_avatar_swatch` / `_draw_bot_glyph`（见 R12） |

### Web（`2470acc3`）

`features/im/components/bots/` 八个文件（列表页 / 详情页 / 表单 / 帮助 / 凭据字段 / 头像 / 色板 / 目录）+ `richText.ts` + `RichTextBody.tsx`。

**rich-text 渲染挂在气泡内层而不是卡片行**——这样白拿表情回应、已读回执、右键菜单、多选、时间戳、头像整套设施。三个卡片组件各自重写过一遍，没有第四遍的必要。

顺手收掉三处重复（不改观感）：`PanelFrame`、`SettingRows`、`SenderLabel`，外加 `useCopy` 抽自 `Invites.tsx`。

### Android（`c84b42f`）

群设置加「群机器人 ›」→ 四个独立 route（列表 → 选类型 → 表单 → 详情）。走 Navigation 而非单 route 内部切 state：返回键语义免费拿到，而创建成功要「一次 pop 掉表单+选类型两层再落详情」，那正是 `popUpTo` 的本职。

`ImSettingsRows.kt`（`ImNavRow`/`ImSwitchRow`/`ImActionRow`，从两份逐字节相同的私有 composable 提取）、`model/RichText.kt`、`ui/chat/RichTextBubble.kt`、`core-design` 的 `BotAvatarPalette`。

---

## 6. 部署顺序

1. **jusi 先升**（P23 + `009` 迁移）——见 R3
2. we-meet `helm upgrade`（**不是只换镜像**，否则不触发 migrate hook，`0079`/`0080` 会漏）
3. Android 发包

`BOT_WEBHOOK_BASE_URL` 已显式写进 `values.meet.yaml`。不设会回退 `DJANGO_EMAIL_APP_BASE_URL`（当前恰好同值），但那是巧合不是约定——这个 origin 会被贴进第三方 CI 配置，必须是外部可达域名。无需改 ingress（主 ingress 的 `/api/` Prefix 已转给 backend），无需新 secret（每个机器人的 token/密钥建的时候入库生成）。

---

## 7. 已知未做（→ 二期 / 以后）

| 项 | 去向 |
|---|---|
| 消息卡片（飞书 `msg_type=interactive`）、按钮回调 | 二期线 A |
| M 端机器人治理（全组织列表、停用、读凭据） | 二期线 B |
| 群成员从内联 roster 改二级页（双端都还是内联，与「群机器人 ›」的 IA 不一致） | 二期线 C1 |
| `@所有人` locale 无关化（人手发的纯文本那一半） | 二期线 C2(b) |
| 应用机器人 / 开放平台 / 机器人**接收**消息 | 未排期 |
| 富文本的图片与多语言外壳 | 未排期 |
