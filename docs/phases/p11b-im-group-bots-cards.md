# P11b — 群机器人二期：消息卡片、按钮回调与 M 端治理

> 状态：**已交付并全量真机验收通过（2026-08-05 开工，2026-08-07 收口）**。
>
> 一期见 [`p11-im-group-bots.md`](./p11-im-group-bots.md)（含 R1–R12 运行时红线，本阶段所有改动的输入）。
> 日程助手代理退群组织者的严格发送协议见
> [`p11c-calendar-assistant-proxy.md`](./p11c-calendar-assistant-proxy.md)。
>
> 进度：**三条线全部完成并上生产**。线 A（A0 ✅ A1 ✅ A2 ✅ A3 ✅）· 线 B ✅ · 线 C（C1 ✅ C2 ✅ C3 ✅ C4 ✅）。
>
> - 线 A + 线 C：2026-08-05（jusi `0d5dac8` + 迁移 0081/0082），真机验收 15–26 全通过
> - 线 B：2026-08-07（迁移 0083/0084），真机验收 27–42 全通过
>
> **验收挖出 5 个问题，见 §19** —— 那一节是本文档写完之后最值得读的部分：
> 它们全都是「看代码和单测发现不了」的类型。

---

## 1. 目标

一期交付了自定义 webhook 机器人 + 三个内置助手 + `rich-text` 富文本，飞书 `msg_type` 只支持 `text` 和 `post`。二期做三件新事 + 清一期欠账：

1. **消息卡片**（飞书 `msg_type=interactive`）—— CI、告警、部署通知在飞书生态里几乎都是卡片形态，团队的发包机器人迁过来大概率就带它。
2. **按钮回调** —— 卡片按钮点了能触发外部服务（同意/驳回/重跑）。这是「机器人能干活」的分水岭。
3. **M 端机器人治理** —— 运营端看全组织有哪些机器人、装在哪、谁建的、发了多少、能停用、能读凭据。
4. **欠账**：群成员改二级页、`@所有人` locale 无关化、一期设计文档（已补：`p11`）、jusi 测试 flake。

---

## 2. 探索纠正的四条前提

设计据此成立，**别按直觉重新推导**：

| 原以为 | 实际 | 影响 |
|---|---|---|
| jusi 也许能改已发消息的 body | **不能** —— REST 路由 / admin 路由 / ws 帧 / 存储层 / 双端 SDK 逐层核实，全仓唯一的 `UPDATE messages` 是撤回的 `SET recalled_at` | 卡片状态只能走**叠加层**，见 §4 |
| @ 检测只拿得到截断的 `last_message` | **拿得到完整 Message**（Web `client.onMessage`、Android `client.messages.collect`）。200 字截断只在列表 REST 上 | 可以直接结构化判定 `uid==='all'`，sentinel 方案不需要 |
| `@所有人` 的问题是「机器人产出中文字面量」 | **真正的死结是人发的 text**：`client.sendText()` 直连 jusi 不过后端，德语同事输 `@Alle`、中文同事检测 `@所有人` 必漏，**没有任何服务端归一化点** | 只能用别名集合，见 §9 |
| jusi 也许有批量查会话的 admin 接口 | **没有任何 admin 读接口**。`POST /conversations` 是 create-or-get，查不到还会**建**一个 | 群名只能本地投影，见 §7 |

另外两条探索时自己发现的：

- `filter(bot__organization=org)` **会静默漏掉全部内置助手**（它们 `organization` 是 NULL）
- M 端 `IsOrgAdmin` 与导航权限码不匹配是 **4 处不是 2 处**，其中 `admin_stats.py` 让 hr/it/admin_office **三个内置角色的看板全是坏的**

---

# 线 A：消息卡片 + 按钮回调

## 3. A1 — 卡片协议（只读）

`content_type = **rich-card**`（不叫 `bot-card`）——沿用 `rich-text` 的命名理由「按它*是什么*命名而不是按谁发的」，将来助手要发同样形状的卡片时不需要第二套协议。另新增控制类型 `card-state`。

**飞书输入 1.0 和 2.0 都收，但只有一套映射管线。** 2.0（`schema:"2.0"` + `body.elements` + `behaviors`）走约 30 行的 `_adapt_v2()` reshape 成 1.0 形状，之后共用 `_map_card()`。不写第二套降级规则——我们要的子集在 2.0 里是纯结构位移不是语义差异。`card.type=="template"`（卡片搭建工具的 `template_id`）**硬报错 11007**，不能降级成空卡。

规范化后的 body：

```json
{ "v": 1,
  "header": { "title": "生产构建失败", "theme": "danger" },
  "blocks": [
    { "type": "text", "spans": [
        {"tag":"text","text":"分支 "}, {"tag":"text","text":"main","b":true},
        {"tag":"a","text":"运行日志","href":"https://ci.example.com/runs/1"},
        {"tag":"at","uid":"all","name":"所有人"} ] },
    { "type": "fields", "items": [ {"label":"环境","value":"生产"} ] },
    { "type": "divider" },
    { "type": "actions", "resolve": "once", "buttons": [
        {"id":"approve","text":"同意上线","style":"primary","action":"callback"},
        {"id":"logs","text":"查看日志","style":"default","action":"url","url":"https://…"} ] } ],
  "plain": "生产构建失败 分支 main 运行日志 @所有人 环境 生产" }
```

### 三条不变量

1. **按钮的 `value` 永不进 body。** 客户端只拿 `id`，`value` 存服务端（`ImCardMessage.values`），点击时按 `button_id` 取。body 是全群可读的，外部服务塞在 value 里的 pipeline token 不能跟着走。**任何时候都不信客户端回传的 value。** 写进 `bot_cards.py` 顶部注释并单独 review。
2. **`lark_md` 在服务端解析成结构化 span，不下发 markdown 字符串。** ① webhook body 是外部可控的，下发 markdown 会让三端各写一个渲染器，Web 那边迟早出现 `dangerouslySetInnerHTML`——这跟一期 `richText.ts` 里 `isWebUrl` 上面那条注释是同一个判断；② 三份 markdown 方言实现必然漂，fixture 能逐字节比 span 数组，比不了「Android 的斜体正则跟 Web 是否一致」；③ `plain` 投影要有唯一口径。
3. **span 词汇复用 `rich-text` 那三个 tag**，只加两个可选布尔 `b`/`i`（缺省省略键）。**现有 9 个 rich-text fixture 一个字节都不用改**，双端的内联渲染循环直接复用，`rich-card` 只新增块级布局。

### 块映射与降级

| 飞书 | 我们 | 备注 |
|---|---|---|
| `header.title` + `template` | `header` | 12 档 template → **5 档语义**，见下 |
| `div.text` / `markdown` | `text` block | lark_md → span |
| `div.fields` / 2.0 `column_set` | `fields` | 恒两列，奇数最后一项跨列 |
| `hr` | `divider` | |
| `action.actions[].button` | `actions` | 一块最多 5 个按钮 |
| `note` / `img` / 交互组件（`select_static`/`date_picker`/`form`） | **丢弃 + warning** | `img` 的理由同 rich-text：机器人没有上传通道 |
| `<font color=…>` | 降级纯文本 + warning | 双端都有深色模式，外部服务钦定的硬编码色我们保证不了对比度 |

**降级分三级，都不静默**：单块不支持 → 丢弃 + 200 响应的 `data.warnings` 里列出（CI 日志看得到，消息照发）；全部块丢光 → `11004`；结构性坏/template → `11002`/`11007`。**`warnings` 只在 HTTP 响应里不进 body**——群成员不该看到「你的机器人少发了一个图」。

### 主题色：12 档 → 5 档**语义**

```
blue/wathet/indigo/violet/purple → info      green/turquoise → success
yellow/orange → warning                       red/carmine → danger
grey/default/未知/缺省 → neutral
```

协议里写 `"red"` 就逼三端各自拥有一个红；写 `"danger"` 让每端取**自己主题已保证过深浅对比度**的 token。

- **Web**：`{primary|success|warning|danger}.subtle` / `.subtle-text` / `.subtle-border` 三件套；neutral 走 `greyscale.100/700/300`。**明令禁止**（写进 `richCard.ts` 顶部）：`primary.50`、`success.100`、`danger.100`（不翻转）、`warning.100`（**根本不存在**，静默产出非法声明背景直接没了——IM 连接状态条栽过），`error.*` 是反向色阶一律不用。
- **Android：零新增色值。** `WeMeetTheme.extras.status` 的 `{success|warning|danger|accentActive}Container/onXxxContainer` 深浅两套齐备；neutral 用 `surfaceVariant`/`onSurfaceVariant`。`checkDesignTokens` 三条要过：不出现任何 `Color(0x…)`；`surfaceVariant` **只能**出现在 `Surface(color=)`/`.background()`，文字取 `onSurfaceVariant`；文案进 `strings.xml`。

### fixture

`core/tests/fixtures/im_cards/` 新增 4 个（三端共读）：`rich_card_minimal`（缺省 theme 兜底）、`rich_card_full`（三端逐字段断言：danger header + 三种 span + 3 项 fields 验奇数跨列 + divider + 三种按钮）、`rich_card_degraded`（含 img/note 输入时的**输出**，断言 warnings 不在 body 里、剩余块顺序不乱）、`rich_card_state`（叠加层响应形状）。

后端独占（`core/tests/fixtures/bot_payloads/`，不进三端契约）：`interactive_v1` / `interactive_v2` / `interactive_template` / `interactive_all_dropped`。

三处契约测试同步加，另加三条不落 fixture 的断言：`v` 必须存在、未知 theme 兜底 neutral、**`buttons[0]` 上没有 `value` 键**。

## 4. A2 — 按钮状态：叠加层，不改 jusi

jusi 不能改消息 body（§2）。三条路里选 **(c) 状态存 we-meet、客户端渲染时叠加**：

- **不选 (a) 给 jusi 加消息更新能力**：真正的拦路虎是 P21 增量续传——客户端断线重连按 seq 往前补，**永远学不到「某个它已经有的 seq 上 body 变了」**。跨仓、跨发布列车。
- **不选 (b) 追加一条新消息**：按钮还活着，第二个人点进去得到「已处理」；N 次点击 = N 条噪音；表达不了「按钮变灰」。
- **(c) 对在哪**：body 是机器人说的话，结果是我们记的账。把原话改写成「已同意」等于让审计链条撒谎，jusi 全文索引里会存在一条谁都没发过的 body。而且 reactions/已读回执**就是这个套路**。

**变更下发用非冒泡控制消息 `card-state`**（P12 机制）。

> ✅ **A0 已完成**（jusi `e3897a5`）：`card-state` 已进 `IM_NONBUMPING_CONTENT_TYPES` 默认值。
>
> 注意这不是「运维改个环境变量」——`values.prod.yaml` 的 `config` 段只列与默认值不同的项，容器又是 `envFrom` 整个 ConfigMap，所以**缺 key 就吃 Go 默认值**，那个字面量就是生产配置。故改的是 `internal/config/config.go` 并加了 `config_test.go` 钉住。
>
> 这个集合有**三个**消费者：会话冒泡（`rest/conversations.go`）、**离线推送过滤**（`push/service.go`，漏配最贵——控制消息会给全群离线成员各推一条通知）、全文搜索排除（`admin/search.go`，本集合 ∪ `{"system"}`）。
>
> 双端仍要本地过滤（`CONTROL_TYPES`/`NON_BUMPING`/`isControlType`），这样万一漏配时降级成「会话冒泡」而不是「列表里出现一坨 JSON」。

**谁能点 / 一次性**：

- 必须是该会话成员，用一期 `_require_membership` 那套（**jusi 是花名册唯一真相**）。
- **不信客户端传的 cid，也不信 mid 属于哪个 cid** —— 服务端按 `mid` 查 `ImCardMessage` 拿权威 cid + 按钮定义 + value。这一条同时解决转发副本：转发产生新 mid、没有 `ImCardMessage` 行 → 点击 404。
- `resolve` 放在 **actions 块**层级不是按钮层级：`"once"`（同意/驳回互斥，靠 DB 唯一约束，并发第二个人拿 409）/ `"each"`（重跑这类，不 resolve、**不广播**，一张卡被点 200 次不会在 jusi 里留 200 条控制消息）。**只有 `once` 广播 `card-state`。**
- 客户端 `click_id` 幂等 24h + 重放结果——与入站 `X-Request-Id` **同一个幂等思路**。
- `ImCardMessage.expires_at` 默认 30 天：一张六个月前的「同意上线」按钮是负债。

## 5. A3 — 出站回调

**`callback_url` 在 installation 上，不在按钮里。** 这是 SSRF 面最重要的一刀：按钮里带 URL = 任何拿到 webhook token 的人都能把我们的服务器变成任意 HTTP 代理。

**出站签名与入站飞书签名彻底分开**（两把密钥、两个算法、两组 header）：

| | 入站（飞书兼容） | 出站（我们的） |
|---|---|---|
| key | `f"{ts}\n{secret}"` | `callback_secret` |
| data | **空串** | `f"v1:{ts}:{raw_body}"` |
| 编码 / 位置 | base64 / JSON body 的 `sign` | hex / `X-WeMeet-Signature` |
| secret | `signing_secret`（群主 UI 可读） | `callback_secret`（**另一把**） |

共用一把的话，任何能看到入站密钥的人都能伪造我们的出站调用。

**点击人身份（已拍板：默认不发，群主可开）**：

- `actor.id` 是 `hmac_sha256(callback_secret, user.pk)[:32]` —— **每个 installation 独立的假名**。外部服务仍能判「同一人点了两次」做幂等和限流，跨 installation 不可关联。密钥轮换后假名会变，这是**特性**：轮换 = 断掉外部积累的行为画像。
- `actor.display_name` 由 `callback_include_identity` 控制，**默认关**，群主 UI 上写明「按钮点击时把点击人姓名发送给外部服务」。理由：webhook 是群主配的，但**点按钮的是每个成员**——默认把他们的姓名发给第三方，是群主替别人做的决定。
- **永不外发**：消息 body、群成员名单、我们的内部 pk。

### 接收方怎么验签（对外集成文档，可整段贴给第三方）

> 权威实现：`core/services/bot_callback.py` 的 `sign()` / `build_request()`。下面每一条都能在那里对上号。

#### 我们发出去的请求长什么样

```http
POST /your/hook HTTP/1.1
Content-Type: application/json
User-Agent: WeMeet-Bot-Callback/1
X-WeMeet-Timestamp: 1786012345
X-WeMeet-Signature: 3f9c1a…（64 位小写 hex）

{"v":1,"type":"card.button.clicked","cid":"c_9f3a…","mid":757,"button":{"id":"approve","text":"同意上线","value":{"pipeline":"prod-2081"}},"actor":{"id":"e0e5bca7…","display_name":"W009"},"ts":1786012345}
```

- `X-WeMeet-Timestamp` 与 body 里的 `ts` **恒相等**（同一个值取两处），任取其一即可，但**签名里必须用 header 那个字符串原文**。
- `button.value` 是发送方当初在飞书 payload 里自己塞的私有载荷，原样还给它；没塞过就是 `null`。
- `actor.display_name` 只有群主开了「发送点击人姓名」才有这个键，**默认没有**。

#### 算法（三行说完）

```
signature = HMAC_SHA256(key = callback_secret,
                        msg = "v1:" + X-WeMeet-Timestamp + ":" + <请求体原始字节>)
            .hexdigest()          # 小写 hex，64 字符
```

密钥是**回调验签密钥 `callback_secret`**（机器人详情页「轮换验签密钥」旁边那个），**不是**入站 webhook 的 `signing_secret`。两把密钥、两个算法、两组 header，共用一把的话任何能看到入站密钥的人都能伪造我们的出站调用。

#### 五步

1. 读**请求体的原始字节**——在任何 JSON 解析之前。
2. 取 `X-WeMeet-Timestamp` 的**字符串原文**拼进 `v1:{ts}:{raw}`。
3. 算 HMAC-SHA256，输出小写 hex。
4. 与 `X-WeMeet-Signature` 做**常数时间比较**。
5. 校验时间戳新鲜度（建议 ±5 分钟），过期即拒。

验签通过之后才解析 body、才信里面任何一个字段。

<details>
<summary>Python / Flask</summary>

```python
SECRET = os.environ["WEMEET_CALLBACK_SECRET"].encode()

@app.post("/hook")
def hook():
    ts, got = request.headers.get("X-WeMeet-Timestamp", ""), request.headers.get("X-WeMeet-Signature", "")
    raw = request.get_data()                     # ← bytes；绝不能用 request.json
    if not ts.isdigit() or abs(time.time() - int(ts)) > 300:
        abort(401)
    want = hmac.new(SECRET, b"v1:" + ts.encode() + b":" + raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(want, got):
        abort(401)
    payload = json.loads(raw)                    # ← 验完再解析
    ...
    return {"text": "已由 CI 接管"}
```

</details>

<details>
<summary>Node / Express</summary>

```js
app.use('/hook', express.raw({ type: 'application/json' }))   // ← 不是 express.json()

app.post('/hook', (req, res) => {
  const ts = req.get('X-WeMeet-Timestamp') || ''
  const got = req.get('X-WeMeet-Signature') || ''
  const raw = req.body                                         // Buffer
  if (!/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return res.sendStatus(401)
  const want = crypto.createHmac('sha256', SECRET).update(`v1:${ts}:`).update(raw).digest('hex')
  const a = Buffer.from(want), b = Buffer.from(got)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.sendStatus(401)
  const payload = JSON.parse(raw.toString('utf8'))
  ...
})
```

</details>

<details>
<summary>Go</summary>

```go
raw, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
ts, got := r.Header.Get("X-WeMeet-Timestamp"), r.Header.Get("X-WeMeet-Signature")

mac := hmac.New(sha256.New, secret)
fmt.Fprintf(mac, "v1:%s:", ts)
mac.Write(raw)                                   // ← 原始字节，不要 json.Marshal 回去
if !hmac.Equal([]byte(hex.EncodeToString(mac.Sum(nil))), []byte(got)) {
    http.Error(w, "", http.StatusUnauthorized)
    return
}
```

</details>

#### 三个真会踩的坑

1. **⚠️ 不要「解析成对象再序列化回去」签。** 签的是我们发出的那串字节，而我们用的是 `json.dumps(…, ensure_ascii=False, separators=(",", ":"))` —— 无空格、中文按 UTF-8 字面量。你那边的默认编码器几乎一定不一样：Python 的 `json.dumps` 默认在 `,` `:` 后面加空格、并把「同」转义成 `\u540c`；Go 的 `encoding/json` 默认把 `<` `>` `&` 转义成 `\u003c` 这类。**换一个字节，签名就全错**，而且是「大部分卡片正常、正文里恰好有个 `&` 的那张失败」这种最难查的形态。用框架的 raw body 接口：Flask `request.get_data()`、FastAPI `await request.body()`、Express `express.raw()`、Go `io.ReadAll(r.Body)`。
2. **时间戳用 header 的字符串原文。** 别 `int()` 再 `str()` 绕一圈；今天数值等价，但拼进签名串的必须是我们发的那几个字符。
3. **常数时间比较**（`hmac.compare_digest` / `crypto.timingSafeEqual` / `hmac.Equal`），别用 `==`。

#### 重放与幂等

时间戳窗口挡的是重放，但**同一次点击我们最多发三次**（超时 / 连不上 / 5xx / 429 最多重试两次，间隔 5s、10s）。重试会重新构造 payload，所以 **`ts` 和签名每次都不同** —— 靠签名去重没有用。

**幂等键取 `(mid, button.id)`**。`resolve: "once"` 的按钮我们服务端已经保证全群只会解析一次，所以同一个 `(mid, button.id)` 到达多次一定是重试，不是第二个人点的。

#### 你该回什么

| | |
|---|---|
| 成功 | 任何 2xx。**5 秒内**必须回（读超时），真活儿请异步做 |
| 想改群里那条结果条 | `Content-Type: application/json` + `{"text":"已由 CI 接管"}` |
| 验签失败 / 拒绝 | 4xx（**我们不重试**，见下） |
| 想让我们重试 | 5xx 或 429 |

`text` 当**不可信输入**处理：压掉所有空白、截到 120 字、不解析 markdown、不允许链接（这是唯一会把上游内容显示给全群的地方）。

另外三条容易被忽略的响应约束：

- **响应体超过 8 KiB 直接判失败**（`too_large`，不重试），不是截断——所以别在 body 里回一整份构建日志。
- `Content-Type` 不是 `application/json` 的话整个 body 被忽略，但**状态码仍算成功**（`; charset=utf-8` 这种后缀无所谓，我们只比分号前那截）。想覆盖结果条就必须带对 Content-Type。
- **3xx 不跟随**，直接判失败——这是 SSRF 防线第 2 条，不是可以商量的重试策略。

当前实现只读 `text` 一个键；`state` 收下但不解释（一期设计里写过，实现时发现它没有能改变的东西——点击是否 resolve 由卡片自己的 `resolve` 决定，不该由上游翻案）。

#### 轮换密钥时（真会咬人的一段）

**轮换是硬切换：立刻生效、不做双签、没有宽限期。** 所以零中断只能靠接收方：

1. 先让你的服务**同时接受新旧两把**（任一验过即可）；
2. 再到机器人详情页点「轮换验签密钥」，复制新密钥；
3. 观察到用新密钥验过的请求之后，撤掉旧的。

**验签失败的代价不是报警，是静默断掉。** 你回 401 → 我们归类 `refused` → **4xx 不重试**（对方的拒绝就是答案）→ `callback_failure_count` +1；**连续 20 次自动 `callback_enabled = False`**。也就是说轮换配错了不会有任何吵闹，只会在第 20 次点击之后彻底没声音，群主得进详情页才看得到「已停用」和失败分类。成功一次即清零。

**`actor.id` 会跟着变。** 它是 `hmac_sha256(callback_secret, user_pk)[:32]` —— 轮换后同一个人换成一个新假名。**这是特性**：轮换 = 断掉外部积累的行为画像。所以别把 `actor.id` 当永久用户 id 落库，它只在「同一把密钥期内判是不是同一个人」这个尺度上有效。

### SSRF 八条，一条都不能省

新建 `core/services/outbound_http.py`，只给 bot callback 用：

1. 只允许 https（DEBUG 下才放 http）
2. **禁止重定向** —— 一个 302 到内网能绕过任何预检
3. **先解析再钉住 IP**：自己 `getaddrinfo`，**所有**返回地址过闸门，然后连**已验证的那个 IP**，Host 头和 SNI 保留域名。只做「解析一次然后连域名」是无效的（TOCTOU）
4. 端口白名单 443（dev 加 80），挡掉 22/6379/5432/11211 横向
5. **`trust_env=False`** —— 否则 pod 里的 `HTTP_PROXY` 会静默改道，IP 钉住全部作废。这条最容易漏
6. 写入时校验（群主当场看到报错）+ **发送时再校一次**（DNS 会变）
7. `timeout=(3,5)`、`stream=True` 最多读 8 KiB、只认 `application/json`
8. 额外 denylist 走 settings（`callback_deny_cidrs`）—— 见下方预检结论

#### 闸门谓词：用 `not is_global`，不是 `is_private`

Python 的 `ipaddress.is_private` **不覆盖 RFC 6598 共享地址段 `100.64.0.0/10`**，而阿里云的 ECS 元数据服务 `100.100.100.200`（吐 RAM 角色 STS 凭证）和 VPC 内网 DNS `100.100.2.136/138` 都在里面。正确写法：

```python
def _is_blocked(addr):
    if addr.version == 6 and addr.ipv4_mapped:   # Python 已内建处理, 显式写出以便 review
        addr = addr.ipv4_mapped
    return (not addr.is_global) or addr.is_multicast or addr.is_reserved
```

`is_global` 的实现是「不在 `100.64.0.0/10` **且** 不是 private」，正好补上那一格；多播要单独加（`224.0.0.1` 的 `is_global` 返回 True）。29 条断言（含 `::ffff:` 映射形式与 6 个真公网地址）全对、零误杀，这张表直接落成 `test_outbound_http.py` 的参数化用例。

#### `callback_deny_cidrs` 的预检结论（2026-08-05 生产实测）

原方案要求确认「集群自己的 Service CIDR 是否用了公网段」。已在生产 k3s 节点实测：

| 项 | 值 | 结论 |
|---|---|---|
| Service CIDR | `10.43.0.0/16` | RFC1918，闸门已覆盖 |
| Pod CIDR | `10.42.0.0/24` | 同上 |
| 节点内网 IP | `172.16.0.4` | 同上 |
| 云元数据 | `169.254.169.254` **可达**（`100.100.100.200` / `169.254.0.23` 均 timeout） | 链路本地段，闸门已覆盖 |

→ **本部署 `callback_deny_cidrs` 配空值**，它只是「将来某个部署的自有网络用了全球可路由段」时的逃生舱。已在代码谓词里成立的规则不再抄一份进 values（那是漂移陷阱）。

⚠️ 但那个元数据端点回的是 `{"code":-1,"message":"cluster.internal",…}` 包着一个 Go `404 page not found` —— 说明它是个**转发网关**而不是固定路径的 IMDS。这意味着「万一被绕过」的损失高于普通元数据泄露。**故第 2/3/5 条（禁重定向、TOCTOU 正确的 IP 钉住、`trust_env=False`）是真正承重的控制**，`outbound_http.py` 必须单独 review，TOCTOU 测试必须用 mock `getaddrinfo` 两次返回不同地址来验，不能只测「看起来校验过了」。

拓扑细节另见记忆条目「生产集群拓扑」；注意 helm 目录名 `aliyun-prod` 与 `install-k3s.sh` 注释都写着阿里云，但**计算节点不是阿里云**，涉及云厂商特定行为时必须实测。

### 失败处理

点击接口立即返回 `pending`，出站异步；重试最多 2 次仅对 connect timeout/5xx/429（4xx 不重试，对方的拒绝就是答案）；连续失败 20 次自动 `callback_enabled=False`（与一期 `conversation_gone` 自愈同一套路，无需 cron）；失败 UI 只显示**分类**（超时/对方拒绝/无法连接/地址不允许），**绝不显示上游响应原文**（那是 SSRF 的信息回传通道）；**Celery 挂了不靠定时任务清理** —— 读取时惰性判定 `pending 且超 5min` 读作 timeout（仓库里没有 beat schedule，不为此引入一个）。

**上游响应**只认 `{"text": "...", "state": "done"}`，`text` 截 120 字 + strip 成纯文本（不解析 markdown 不允许链接）——这是唯一会把上游内容显示给用户的地方，当不可信输入处理。

**Celery 任务** `core/tasks/bot_callback.py`，**同一 commit 必须在 `core/tasks/__init__.py` 加 import**。顺手补一条这个仓库还没有的护栏 `core/tests/test_task_registry.py`：断言 `core/tasks/*.py` 全部出现在 `__init__.py` 的 import 里——漏 import 在本地同步 fallback 全绿，只在生产表现为任务永远 pending。

## 6. A4 — 三端改动清单

**后端新建**：`services/lark_md.py`（唯一有正则复杂度的部分，单独一个文件以便 fuzz）、`services/bot_cards.py`（约 400 行映射，不塞进已经很密的 `bot_webhook.py`）、`services/outbound_http.py`、`tasks/bot_callback.py`、`api/im_cards.py`（点击 + 批量拉叠加层）、模型 `ImCardMessage`/`ImCardAction`。

**后端改动**：`im_cards.py`（`RICH_CARD`/`CARD_STATE` + builder）、`bot_webhook.py`（`build_message` 加分支，`BotMessage` 加 `warnings`/`button_values`）、`api/bot_webhook.py`（~15 行）、`push_send.py`（**必须**加 `"rich-card": "[卡片]"`）、`throttling.py`（三层点击限流，**按 installation 那层最要紧——它保护的是第三方**：200 人群一起点「重跑」，我们等于替他们发起 DoS）。

**Web 8 处**：新建 `richCard.ts` + `RichCardMessage.tsx`；改 `MessageItem.tsx` 卡片行三元链、`ChatPane.tsx` 的 `snippetOf` **和多选转发快照（两处重复实现，都要改）** + 复制白名单、`ImRoute.tsx` 预览三元链 + `forwardOne` 白名单、`PinnedBar.tsx`、`CONTROL_TYPES`/`NON_BUMPING` 加 `card-state`。

**Android 7 处**：新建 `model/RichCard.kt` + `ui/chat/RichCardBubble.kt`；改 `MessageContent.kt`（sealed + parse + `isControlType`）、`MessageBubble.kt`（**编译器会报错，安全**）、`ImCommonUi.kt` 短路表 + 穷尽 when（**编译器会报错**）、**`ChatViewModel.mergedTextOf` 和 `snippetOf` 两处 `else -> ""`（编译器不提醒，漏了就是引用/合并转发得到空快照）**。见一期 R10。PR 描述里点名这两行让 review 专门看。

**转发时本地剥掉 actions 块**（Web `forwardOne`、Android `forward`）：服务端 404 是真正的兜底，但不能让用户看到一排点不动的按钮。写进 `richCard.ts`/`RichCard.kt` 注释。

**引用一张卡只带 `plain`，按钮不跟随** —— 这不是 UI 缺憾是安全要求：能在别处被重新点击的引用按钮 = 从另一个会话触发审批。

**时序陷阱**：ws 的 `card-state` **可能早于点击 HTTP 响应到达**。两端都要以叠加层 store 为唯一真相，本地乐观状态只是提示，**不能按「时间戳新的赢」合并**。

## 7. 线 A 分刀（每刀可独立发布）

| 刀 | 内容 | 独立价值 |
|---|---|---|
| **A0** ✅ | jusi `card-state` 进非冒泡集合（`e3897a5`） | A2 上生产前必须落地 |
| **A1** ✅ | 只读卡片，**无 migration**（后端 `4c53ba53`、Web `bd7be5e9`）。`callback` 按钮此时被映射器丢弃 + warning（`install.callback_url` 字段还不存在 → `allow_callback=False` 恒真），`url` 按钮正常工作 | CI/告警/日报卡片化。**用户拿到完整体验，没有一个死按钮** |
| **A2** ✅ | 点击状态机，**we-meet 内闭环不出站**（后端+Android `48fb6853`、Web `b786a8e1`）。migration `0081`，本地 resolve（结果文案 = 按钮标签 + 点击人姓名） | 已经是可用产品：投票、接龙、值班确认、通知已读确认。且把 ws/叠加层/并发唯一约束这三块最易错的管道**在引入第三方依赖之前**先跑通 |
| **A3** ✅ | 出站回调。migration `0082`、`outbound_http.py`、Celery task（后端 `547f07fd`）；群主 UI（Web `f9c5b0ff`、App `799d39c`） | |

> **A3 落地时补的一处**：群主要看的是「地址还通不通」，而 `callback_failure_count`
> 只说了「几次」不说「为什么」。所以序列化器加了 `callback_last_error` ——
> 四个**桶**（timeout / refused / unreachable / blocked），每档对应群主的一个
> 不同动作。分桶在服务端（`services/bot_callback.FAILURE_BUCKETS`）不在客户端：
> 桶是产品决策，且顺手把「绝不外露上游响应原文」收口成一处。
>
> 读的是**最近一次回调的结果**而不是「最近一次失败」，否则上一次已经成功了还
> 挂着三天前的「超时」。`pending` 超 5 分钟读作 timeout —— 这正是当初决定
> 惰性判定、不为一件事引入 beat schedule 的兑现点（Celery 停摆时那些行永远
> 不会变成 failed）。

> **A3 验收时补的第二处**：`callback_secret` 原来**只在为空时铸一次**，之后
> 无论如何都换不掉 —— 而 D4 里「C 端群主已有轮换」和「密钥轮换后假名会变，
> 这是特性」这两句话，都是把轮换当既有能力在用。补了
> `POST /api/v1.0/im/bots/{id}/rotate-callback-secret/`（群主 only，写一条
> `bot.secret_reset` + `metadata.credential="callback"` 审计）和详情页的
> 「轮换验签密钥」按钮。**这是密钥一旦泄露时唯一的止血手段**，接收方侧怎么配合
> 见 §5「接收方怎么验签 → 轮换密钥时」。

**风险最高、建议单独 review 的两处**：`outbound_http.py` 的 IP 钉住实现（TOCTOU 很容易写成无效的）、`bot_cards.py` 里「value 不进 body」这条不变量（一次手滑就把 pipeline token 广播给全群）。

---

# 线 B：M 端机器人治理

## 8. B1 — 拍板

| # | 决策 | 理由 |
|---|---|---|
| D1 | 群名走**本地投影表 `ImConversation`**，不改 jusi | jusi 没读接口。而 **we-meet 是群名的唯一写入方**（jusi 侧改 meta 只有 `PATCH /admin/conversations/{cid}` 一条路，admin HMAC 门），写路径顺手记一份天然是准的；读路径零外部依赖——**治理页最该可用的时刻，恰好可能是 IM 在抽风的时刻** |
| D2 | 三个权限码 `org.bot.read` / `org.bot.write` / `org.bot.secret.read` | 读凭证不是「读」，是**给自己发消息权**，且撤销权限收不回已泄露的凭证，必须能单独授 |
| D3 | 停用 = `org.bot.write` | 停用会让别人的 CI 告警断掉。并进 read 等于「让 IT 看看有哪些机器人」顺带给了「让 IT 弄坏财务的告警」 |
| D4 | M 端**不做**删除、不做密钥轮换 | 轮换是无声破坏（对方 CI 报 400 但群里什么都不显示）。M 端的正确手段是**停用**——可见、有 `disabled_reason`、可逆。C 端群主已有轮换 |
| D5 | 带 department scope 的调用者**直接 403**，不是过滤成空 | 过滤成空读作「没有机器人」，403 读作「这页不归你管」。同时在角色分配序列化器上堵住这个组合 |
| D6 | 默认只列自定义 bot，内置助手 `?kind=` 显式要 | 内置助手是（助手 × 会话）笛卡尔积，几千行会把真正要治理的几十个自定义 bot 冲没 |
| D7 | M 端只动 `ImBotInstallation.is_active`，**永不动 `ImBot.is_active`** | 内置 bot 的 `organization` 是 NULL —— 停用身份是**全局**停用，会打到别的组织 |
| D8 | 审计动作目录由后端吐、中文名仍在前端 | 后端 `.po` 里 `AuditActionChoices` **一条翻译都没有**，纯后端方案会把现有 22 个中文名换成 55 个英文串，是倒退 |

## 9. B2 — 权限与数据层

`permissions_registry.py` 改一处（owner/administrator 拿 `ALL_PERMISSIONS`，**立即生效无需 migration**）：三个新码 + 新增 `UNSCOPABLE = frozenset({...})`（主体上没有部门维度的权限）。`BUILTIN_ROLES["it"]` 加 read + write（IT 管集成）；**`org.bot.secret.read` 三个内置角色一个都不给**，必须 owner 明确勾选，归 `sensitive` 分组。不放 `OWNER_ONLY`——那条线是给提权原语的，读 bot 凭证是横向能力够不上。

**新模型 `ImConversation`**（`cid` unique / `organization` / `name` / `created_by`）——we-meet 侧对 jusi 会话的**投影**，只存治理要用的字段。与 `MeetingConversation` 的区别写进 docstring：那张是「会议↔会话」业务锚点，这张是展示投影；**会议群的名字不存这里**，读时 join `MeetingConversation` 取 `room.name`，房间改名立刻跟着改。

`organization`/`created_by` 是**写一次**语义（只在为空时填）——别组织的人改个群名就能把归属改走，是个很安静的越权。

**4 处写入点**（全是既有代码，每处 1 行 + best-effort 包裹，先例 `im_bots._touch_installation`）：`im.py` 建群 / 改名、`im_bots.py` 装 bot（兜住「群早于本表存在」，**保证每个有 bot 的群一定有组织归属**）、`viewsets.py` 会议群 ensure-group。

**读取**两条本地查询零 jusi 调用。前端兜底：`name` 空显示「未命名群聊」，副行永远显示可复制的 cid 前 12 位——运营拿这串能去 IM 侧对。

补两条索引（目的是**排序**不是救火，`cid` 已经 `db_index=True`）：`-last_used_at`（「按最后活跃排序」是默认视角，`nulls_last` 不能省，否则先给你看一屏从没用过的）、`(bot, -created_at)`。

数据迁移回填已存在的 cid（实际影响面≈0，机器人 8/4 才上线——**这也正是「不改 jusi」现在成本最低的时点**）。

## 10. B3 — 后端 `api/admin_bots.py`

只有 list/retrieve + `disable`/`enable`/`credential` 三个 action，**刻意没有 create/destroy**（装机器人是群主在 C 端做的，删除要调 jusi remove_members 并在群里留痕）。

**org 门有两条腿**：自定义 bot 认 `bot.organization`，内置 bot 的 organization 是 NULL 只能靠会话投影认——没投影就看不见，**fail closed**。

**筛选只加在 list 上**：留给 detail 路由会让「已停用」变 404、于是 `enable` 永远调不到——与 `admin_invite_links.py:143` 同一个坑。

`credential` 单独 action + 每次读写审计（`metadata={"surface":"admin"}` 区分 C 端群主读）+ 限流 30/hour。**刻意不放进 list**：一页 100 行就是 100 张活凭证进了浏览器内存和 HTTP 缓存。限流不是防管理员，是让「把全组织凭证撸一遍」变慢、变可见。

序列化器**永远不含** `webhook_url`/`signing_secret`/`keywords`/`ip_allowlist` 原值——测试里断言 `"signing_secret" not in json.dumps(resp.data)`，这条最容易在后续改动中被破坏。

新 `OrgWideOnlyMixin`（`DepartmentScopedMixin` 的反面）+ 在 `AdminRoleAssignmentSerializer.validate()` 堵源头：允许创建「按部门授权 + 含 unscopable 码」的角色，就等于承诺了一件做不到的事——这个人会被告知他能看机器人，然后每次点进去都 403。

新增审计动作 `bot.disable`/`bot.enable`，**不复用 `bot.update`**：「谁停了生产机器人」是这块唯一真正要能被筛出来的事件。

## 11. B4 — 前端

新建 `api/adminBots.ts` + `pages/Bots.tsx` + `components/BotCredentialDialog.tsx`。分页/筛选范式**逐条抄 `pages/Audit.tsx`**（筛选值和 page 一起进 queryKey、`keepPreviousData` 防闪、`resetPageThen()`、底部只看 `previous/next`），表格样式常量抄 `pages/Invites.tsx:382-408`（操作列 `width:'1%'; whiteSpace:nowrap` 防中文按钮竖排）。

`BotCredentialDialog` 形状照抄 `features/im/components/bots/BotSecretField.tsx`（懒取 + `gcTime:0` + 眼睛切换时 `removeQueries`）。**不 import `features/im` 的组件**——admin 是独立 lazy chunk，import 过去会把整条 IM 依赖拖进管理台包。这份重复是刻意的，注释写明。

**唯一例外**：`botPalette.ts` 是 20 行纯数据零依赖，且它自己的注释就在警告「三端各存一份，别再多一份」→ 移到 `src/components/bot/botPalette.ts`，改 2 处 import。**这是三条线唯一的交叉点**，做完通知线 A 别在新文件里 import 旧路径。

路由 + 导航；i18n 5 个语言。`bots.disableConfirm` 中文要说人话：「停用后，通过该 Webhook 的推送会立即失败，第三方系统不会收到任何提示。」

## 12. B5 — 两个既有缺陷（跟这条线走）

**审计动作白名单**：后端加 `GET /admin/audit-logs/actions/` 吐目录（先例 `PermissionCatalogueView` 对权限码做的是同一件事），前端删掉硬编码的 `AUDIT_ACTIONS`，下拉按 group 渲染 `optgroup`。这样它**不可能**再跟枚举漂移。`zh/admin.json` 的 `audit.action.*` 补齐到 55 个；**en/fr/de/nl 不补**——它们本来就走 `defaultValue`，现在拿到后端英文 label 而不是裸 `bot.create`，已是净改善。

**`IsOrgAdmin` 与导航权限码不匹配（4 处）**：`admin_stats.py`（**hr/it/admin_office 全部撞墙，看板是坏的**）、`admin_audit.py`（it）、`admin_meeting_rooms.py` 4 个 viewset（admin_office）、`admin_invitations.py`（hr/it，`/invites` 页半坏）。改法一律两行。**纯放宽，owner/administrator 走 `ALL_PERMISSIONS` 依然通过，没有人失去访问。**

---

# 线 C：欠账清理

## 13. C1 — 群成员改二级页

**Web**：抽 `hooks/useGroupRoster.ts`（roster query + names + `nameOf` + `myNickname` + 失效钩子，全部逐行搬）解 `myNickname` 那个耦合点。**双处调用安全**：同一组 queryKey react-query 去重成一次请求，`onConversation` 注册两次失效同一个 key 合并成一次 refetch——这点要写进 hook docstring，否则下一个人会以为是 bug。

> root 的成员计数用 `conversation.members.length`（jusi P23 已排除机器人，与 `listMembers` 同值），**但 `myNickname` 没有替代来源**：`ConversationSummary` 里没有 caller 自己的 nickname。所以 root 仍要挂这个 hook。

新建 `GroupMembersPage.tsx`（4 个 props）+ `panelStyles.ts`（`editBtn`/`sectionLabel` 跨切分线被两边用，抽出来；`chips.ts` 是同一手法的先例）。`GroupInfoPanel` 三处纯增量：`PanelView` 加 `members`、加渲染分支、root 加一行 `SettingRow`（放在机器人**上面**，人优先于工具）。**Esc 分级返回和切会话重置都不用改**（`members` 落进 `root` 分支，正确）。**i18n 零新增**——`manage.membersTitle` 5 语种全在，一期建了没用上。

**Android**：新 route（不是页内 state），理由与一期机器人同构。复用 `GroupInfoViewModel`（它已有 members/isOwner/removeMember/transferOwner）；新 NavBackStackEntry = 新 ViewModelStore，所以是独立实例。**GroupInfoScreen 要加 `LaunchedEffect(Unit){vm.refresh()}`**（新增非搬运）：两个 VM 是不同实例，成员页踢人/转让后 root 那个只能靠 `conversationEvents` 得知，而转让是否发 conv 事件不确定——`GroupBotsScreen.kt:65-67` 已为同一原因这么做，照抄它的注释。

**转让口径两端拉齐成「每行一个按钮」**（Web 不变，Android 删掉底部入口 + 选人 Dialog，成员行加按钮复用确认 Dialog）。理由：成员单独成页后，Android 的选人 Dialog 就是**同一屏上的第二份成员列表**，而这整件事的动机正是「名单只该有一处」。⚠️ **这是本项唯一一处真改行为**，Android 净删约 40 行，review 要专门看。

### 怎么让 review 确认是一比一搬过去

grep 已确认：`group-add-members`/`member-kick-*`/`member-transfer-*`/`group-member-search` 只在 `GroupInfoPanel.tsx` 自身出现，**没有 e2e、没有单测引用** —— 搬家不会打破测试，也意味着**没有任何兜底**。所以「可确认」必须靠流程造出来：

1. **每端拆两个 commit**：commit 1「纯搬运」行为零变化，commit 2「转让口径拉齐」。Review 的判断标准因此从「这 900 行对不对」降级为「commit 1 里有没有非移动的行」。
2. 给 reviewer 一条命令而不是让他肉眼比：`git diff -M -C --color-moved=zebra --color-moved-ws=allow-indentation-change HEAD~1`。为了让它真判成 moved，**搬过去的 JSX 缩进层级保持不变**。
3. **testid 集合前后逐字相等**（它是这块唯一的事实契约），预期只多 `group-members-entry`、无删减。
4. **借这次搬家补上第一个刻画测试** `GroupMembersPage.test.tsx`（约 60 行，6 条断言：计数、搜索阈值 10/11 边界、群主徽章走 `owner_uid` 而非 role、离职 chip、非群主看不到 kick/transfer、`nameOf` 群昵称优先）。**先写在旧组件上跑绿、再随搬运不改一行地跑绿**——这是最强的一比一证据。

顺带可选对齐：Android `GroupInfoViewModel.kt:113` 的 `ownerUid` 是 roster-first，而 Web 明确注释了「用 `owner_uid` 权威、roster role 会滞后一次转让」——顺序对调即可。

## 14. C2 — `@所有人`（两件都做）

**不做 sentinel、不改协议、不改任何金标准 fixture。** 双端改成「结构优先 + 全语种别名兜底」。

理由链：① 富文本已有正确结构（`uid==='all'`），双端在检测点也拿得到（§2）→ 零成本结构化；② 纯文本（机器人 `text` **和人手输入**）没有结构，而人发的消息不过后端 → **任何「新标记」方案都天然覆盖不了人发的那一半**；③ sentinel 塞进 `plain` 更糟——`plain` 同时是会话预览、jusi 全文检索的 tsvector 源、引用快照、合并转发快照、机器人关键词闸门的匹配面；④ **旧消息兼容自动成立**：历史消息里冻着 `@所有人`，它就是别名集合的一员，零迁移，且英文用户从此对**存量**中文 @所有人 也会亮。

### ✅ C2(a) 已完成（`we-meet-android` `60e12df`）

只动 `ImSession.kt` 一个文件。原来 @ 检测入口第一行就是 `if (m.contentType != "text") return`，所以群机器人发的 rich-text 无论怎么点名都不亮红 @——而机器人恰恰是最常 @所有人 的那类发送者。

抽出 `mentionScan(contentType, body, selfName)`，「扫哪些类型、怎么扫」现在只有它说了算（A1 加卡片时也只改这一处）：`text` 扫字面量；`rich-text` 的 @所有人 走**结构判定**（`at` 标签 `uid == "all"`），字面量那一路保留（机器人可以直接在正文打「@所有人」而不发 `at` 标签）；其余不扫。

**点名到人只走 `plain` 投影，刻意不看 `at.uid`**：那是 webhook 发送方随手填的外部字符串，不是我们的 im uid——拿它跟自己比既不对，还等于开了个「猜中 uid 就能定向戳人」的口子。@所有人 可以信结构，是因为 `"all"` 是后端归一化产出的哨兵值而非外部输入。

**遗留**：`mentionScan` 目前没有直接测试（依赖 `Context` 取字符串）。没有现在就抽成纯函数，是因为 C2(b) 要把单个 label 换成别名集合，那时一次到位；现在抽等于建两遍同一个缝。

### ✅ C2(b) locale 无关化已完成（后端/Web `473879a8`、App `6117c91`）

新增跨仓契约文件 `fixtures/im_cards/mention_everyone_aliases.json`（五个语种），生产代码各端硬编码同一份常量，**契约测试断言 常量 == 文件 == 各自 locale 资源**——与色板下标、rich-text fixture 完全同一手法。Web 新建 `features/im/mentions.ts`，Android 新建 `model/MentionAliases.kt`（同时把 `mentionScan` 抽成纯函数补测）。后端 `AT_EVERYONE` **保持不变**（改它会让存量与新消息不一致，还会打断用户已配的关键词闸门规则），只改 docstring 措辞 + 加一条 `AT_EVERYONE.lstrip("@") in aliases.json` 的断言。

气泡内高亮和输入下拉（`ChatPane.tsx:387`、Android `mentionCandidates`）**不动**——那是「本地用户看到和输入什么」，本来就该跟随本机 locale。

**待定小项**：`quote` 里被引用的原文该不该算点名（Web 现在算——引用一条 @所有人 会重复通知你，是 bug 不是设计；Android 不算）。建议随 C2(b) 定为**只扫回复正文不扫被引快照**，单独一行提交说明（这会收窄 Web 现有行为）。

## 15. C3 — 设计文档 + 路线图回填

一期文档 → [`p11-im-group-bots.md`](./p11-im-group-bots.md)（本文档的姊妹篇，R1–R12 在那里）。

路线图（`docs/extensions/企业协同套件路线图_对标飞书.md`）只改与机器人直接相关的格子；其余 A 节漂移归 P7/P15/P16/P22，留给文档头说的「全表回填」那批。

## 16. C4 — jusi 测试 flake ✅ 已完成（jusi `0d9eecc`）

`recall_reactions_test.go` 的「窗口过期」断言实质是 `宿主now − 容器now > window`，**跨进程时钟差**，余量只有 20ms 而实测偏差 −2.6ms~+18ms。

改法：在数据库自己的时钟里把消息做旧（`UPDATE messages SET created_at = now() - interval '1 hour'`，先例 `bot_role_test.go:40`），删掉 sleep，余量从 20ms 变成 1 小时。

顺带修一个真问题：`time.Nanosecond` 经 `int64(window/time.Second)` 会退化成 **0**，SQL 那道 `$4::bigint <= 0` 把 0 读作「不限时」反而不设防——传 1ns 时这条断言**只考到了 Go 那道闸门**。窗口改成 `time.Minute` 后两道闸门都真的在把关。

同类风险扫描：改完 `internal/storage/pg` 已无任何 `time.Sleep`；`TestRecall_HappyPathBlanksEverywhere` 需要偏差超过一分钟才误判，安全。

---

## 17. 落地顺序（三条线并行）

- **线 A** ✅：A0 ✅ → A1 ✅ → A2 ✅ → A3 ✅
- **线 B** ✅：权限码不匹配 `5f621688` → 审计动作目录 `c176e864` → 权限码 + `UNSCOPABLE` + mixin `c82e5c80` → `ImConversation` + 4 处写入点 `c5f2abac` → `admin_bots.py` `1b1956ec` → 前端页面 `b3c38b76` → 验收修复 `a07a34bb` / `ba471b90` / `a9a1b897`（见 §19）
- **线 C** ✅：C4 ✅ → C2(a) ✅ → C3 ✅（`a33c1db9`）→ C1 Web ✅（`1c85ba53` + `0d2f8f24`）→ C1 Android ✅（`616b4e3` 纯搬运 + `19d23ee` 转让口径）→ C2(b) ✅（后端/Web `473879a8`、App `6117c91`）

**唯一跨线依赖**：`botPalette.ts` 移动（线 B `b3c38b76`）→ `src/components/bot/botPalette.ts`，已改 2 处 import。线 A 的新文件没有引用旧路径。

---

## 线 B 落地时的三处修正

1. **权限码不匹配是 5 处不是 4 处。** 方案里手工盘点漏了 `UserGroupViewSet`
   （hr / it 都持有 `org.group.read`，导航显示「用户组」，点进去 403）。找出它的是
   新写的 `test_admin_nav_permission_alignment.py` —— 它按**不变量**写而不是按清单写：
   「一个内置角色只要持有某个导航码，对应端点就必须让他过」。新增页面加一行，
   三个角色自动全测。

2. **`it` 的机器人权限码推迟到 B3 才授。** B2 里顺手加进 `BUILTIN_ROLES` 时那条护栏
   立刻变红 —— 页面还不存在。授一个没有页面的权限，正是 `permissions_registry`
   开头警告的「能看见的东西是空的、读起来像产品坏了」。

3. **`swagger.json` 是 gitignored 的**，方案里「记得提交否则 CI dirty tree」这条不成立：
   那个测试是自比对（先重新生成再跟线上端点比），不是快照比对。而 `docs/openapi.yaml`
   是**外部 API** 的手写规范，与内部端点无关。

C1 的搬运是唯一有「搬错了看不出来」风险的，所以刻画测试要在**搬运之前**先写在旧 `GroupInfoPanel` 上跑绿。

---

## 18. 验证

**后端**（先 `build app-dev` 再 `bin/pytest`，`--no-deps` 只起 pg+redis）：

- 卡片：`test_bot_webhook_interactive.py`（v1/v2/template/全丢四个 payload fixture）、`test_lark_md.py`（`javascript:` 降级、`<font>` 降级、`<at id=all>`）、契约测试加 4 个 golden + 三条不落 fixture 的断言（**`buttons[0]` 上没有 `value` 键**）
- 回调：`test_outbound_http.py`（**IP 钉住的 TOCTOU 要用 mock `getaddrinfo` 两次返回不同地址来测**、重定向、`trust_env`、端口、`::ffff:169.254.169.254`、`100.100.100.200`）、`test_api_im_cards.py`（非成员 403、转发副本 404、`once` 并发 409、过期置灰、幂等重放）
- M 端：`test_api_admin_bots.py`（跨组织隔离、三个权限码各自的 403 矩阵、**`"signing_secret" not in json.dumps(resp.data)`**、`credential` 恰好写一条 `surface=admin` 审计、disable 后 webhook 打过去非 2xx、**`enable` 能调到已停用的行**回归 detail-404 坑、M 端 disable 内置 bot 时 `ImBot.is_active` 不变）、`test_api_admin_scope.py` 加 department-scope → 403
- `test_task_registry.py`（新护栏）

**Web**：`npx tsc -b`（**不是 `--noEmit`**，docker 构建跑的是 `-b`）+ `npm test`。新增 `richCard.test.ts`、`mentions.test.ts`、`GroupMembersPage.test.tsx`。

**Android**：`./gradlew :feature-im:testDebugUnitTest` + `checkDesignTokens` + 打 APK。

**jusi**：`go test -count=5 ./internal/storage/pg/`。

**swagger**：`test_openapi_schema.py` 会重新生成再比对，新端点会产生 diff，**记得提交**否则 CI dirty tree。

### 端到端手测

1. CI 脚本发一张 interactive 卡（v1 和 v2 各一次）→ 双端渲染一致，header 主题色深浅模式都对
2. 发一张带 `img`/`note` 的 → 消息照发，HTTP 响应里有 `warnings`，**body 里没有**
3. 点「同意」→ 群里所有人**立刻**看到按钮变结果条；第二个人点 → 直接看到已解析态
4. 配一个 `http://169.254.169.254/` 的 callback → 保存时就报错；配一个 302 到内网的 → 发送时失败且 UI 只显示分类
5. M 端：非 owner 的 IT 角色能看列表能停用、**看不到凭据**；带部门 scope 的角色 → 403 不是空列表
6. 停用后 webhook 打过去失败，群里没有任何提示（符合 D4：这就是为什么 M 端不给轮换）
7. 德语用户在群里发 `@Alle` → 中文用户会话列表标红 @

---

## 19. 真机验收挖出来的（2026-08-06 ~ 08-07，42 条用例）

**这一节是本文档最该留的部分。** 下面每一条都是「后端单测全绿、代码读起来也对」的状态下上了生产的，全部由真机验收发现。它们有一个共同形状 —— 见末尾。

### 线 A（15–26）

| # | 问题 | 修复 |
|---|---|---|
| A-1 | **出站回调对任何真实 HTTPS 主机都必然失败。** IP 钉住把 URL 里的 host 换成了 IP，而 `Host` **是一个 HTTP 头、管不到 TLS** —— SNI 和证书主机名都取自 URL。带 SNI 分流的主机直接 `SSLV3_ALERT_HANDSHAKE_FAILURE`，其余的 `CERTIFICATE_VERIFY_FAILED: IP address mismatch`，两种都被归成 `unreachable`，群主看到「连不上对方的地址」——一个完全指错方向的提示 | `a8d416ac`（`_PinnedHostAdapter` 显式给连接池 `server_hostname` + `assert_hostname`） |
| A-2 | **`button-local-only:no-callback-url` 警告恒为真。** `api/bot_webhook.py` 从没传过 `callback_configured` | `cd76324e` |
| A-3 | **上游用 `text` 覆盖结果条时，群里看不到。** 结果条是点击那一刻广播出去的，写库改不动它 —— 一个要刷新才生效的「实时覆盖」等于没有 | `c06880c0`（抽 `services/card_state.broadcast`，只在文案真的变了时补播） |
| A-4 | **卡片点击三层限流整个没做。** 按 installation 那层最要紧——它保护的是第三方：200 人群一起点「重跑」，我们等于替他们发起 DoS | `f3747326` |
| A-5 | **`callback_secret` 只在为空时铸一次，之后换不掉** —— 而 D4「C 端群主已有轮换」和「轮换后假名会变是特性」两句都在把轮换当既有能力用 | `b30a915d`（`POST /im/bots/{id}/rotate-callback-secret/`） |
| A-6 | **会话列表里每张卡都显示「[卡片]」。** 两个原因叠在一起：`plain` 序列化在最后一个键（jusi 截断后整段落在截断点之外），以及预览先 parse 再取 plain。**两处的注释都写着相反的话** | `a448fb5b` + App `030f0ac`（`plain` 排到第一个键 + 预览短路在 parse 之前从原始串抠） |

### 线 B（27–42）

| # | 问题 | 修复 |
|---|---|---|
| B-1 | **`IsOrgAdmin` 与导航权限码不匹配是 5 处不是 4 处**（方案人工盘点漏了 `UserGroupViewSet`） | `5f621688`，详见〈线 B 落地时的三处修正〉 |
| B-2 | **三个内置助手里有两个从不记安装记录。** 记账只长在 `post_as_builtin` 里，而审批助手和会议助手都直接调 `post_as` —— 生产上 `kind='builtin'` 的安装数是 **0**。后果：C 端群里的「群机器人」列表看不到它们，M 端 `?kind=builtin` 恒为空。而 `_touch_installation` 的注释正写着「the row exists so the group's 群机器人 list can show them」 | `a07a34bb`（记账挪进 `post_as` 并**默认开**；唯一例外是审批助手的私信，口径 A：治理页叫「群机器人」，一对一私聊不进运营视野，而且那是助手 × 每个人的笛卡尔积） |
| B-3 | **「按部门授权 + 组织级权限」可以从另一头造出来。** `UNSCOPABLE` 全仓只在角色**分配**的 validate 里被引用一次，而角色的权限集可以事后改 —— 先按部门授出去、再回来勾上 `org.bot.read` 就绕过去了。这正是真实部署里最容易走到的顺序 | `ba471b90`（`AdminRoleSerializer.validate` 补对称校验；收窄权限永远放行，否则配坏的角色再也修不回来） |
| B-4 | **拦截文案是英文**，而管理台其余部分全是中文（`locale/zh_CN` 那 124 条翻译基本都是 Django admin 的字段名） | `ba471b90`（走机器可读的 `code` 让前端映射，不补 `.po`——先例是回调地址被拒时的 `outbound_http` category，而 DRF 校验错误一旦开始走 gettext 就得管全套） |
| B-5 | **`bot.disable` / `bot.enable` 没有中文标签。** 后端枚举 55 条，`zh/admin.json` 只补到 53 —— 而这两条恰恰是这块唯一真正要能被筛出来的事件（当初就是为此才没并进 `bot.update`） | `a9a1b897`（补标签 + 一条读后端 `models.py` 数枚举的双向护栏） |

### B-2 留下的一个待观察

修完之后**存量不回填** —— jusi 没有 admin 读接口，补不出「哪个助手在哪个群」；下一次发消息时自然记上。

所以 **D6 那条口径到今天为止从没面对过真实数据**：它假设「内置助手是（助手 × 会话）的笛卡尔积，几千行会把真正要治理的几十个自定义 bot 冲没」，而生产上那个数一直是 0（正因为 B-2）。等纪要/日程通知跑过几轮、`?kind=builtin` 开始有行之后，看一眼实际量级再决定 D6 要不要调 —— 如果实际只有十几行，「默认只列自定义」挡的就是一个不存在的问题。

### 修 B-4 时单测抓到的一处

**同一个后端会吐出两种错误形状**：在 **viewset 方法**里抛的 `ValidationError` 原样是标量，在 **serializer 的 `validate()`** 里抛的会被 `as_serializer_error` 规整成**列表**。前端原来只认字符串——那样角色这两条永远拿不到 `code`、永远退回英文，而且**前端什么都不会报**，只是文案不对。两种都认，两边各配一条测试钉住。

### 共同形状

六条线 A 里有三条、五条线 B 里有两条，都是同一个东西：

> **注释（或 docstring）声称了一条代码并不保证的不变量，而守着它的测试恰好 mock 掉了唯一要紧的那一层。**

- A-1：测试只断言了 `Host` **头**，注释据此写「证书仍按域名校验」——而 `session.post` 被 mock 掉了，整段跳过 TLS。上线时 `test_outbound_http` 是全绿的。
- A-6：两处注释都写着「预览短路在 parse 之前」，代码是反的。
- B-2：`test_posting_as_a_builtin_records_the_installation` mock 掉了 `post_as`——而记账正在里面。它证明的只是「`post_as_builtin` 自己那行还在」。

所以这一批的修复里，**每一条都配了一个「去掉修复就会红」的验证**，而不是只补一个断言：SNI 那条靠打真实主机（`example.com` 通、三个 badssl 被拒），其余靠 stash 掉源码跑基线对比（18 失败 − 7 条新测试 = 11 条分叉既有）。

降级得**太温柔**是同一族的第二种形状：B-5 少一条标签不会报错，只会在一列中文里换一种语言显示。这类东西护栏要按**覆盖率**写（「每个枚举值都必须有」），不能按清单写。
