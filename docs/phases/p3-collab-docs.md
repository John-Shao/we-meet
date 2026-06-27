# P3 — 协作文档（集成 La Suite Docs）

> 路线图位置：P1 组织地基 ✅ → P2 日历 ✅ → **P3 协作文档** → P4 知识库 → P5 审批。
> 总路线图见 `C:\Users\19146\.claude\plans\cheeky-orbiting-sky.md`（载荷决策不在此重复）。

## 一、Context（为什么做）

we-meet 的协同面目前只有 **IM + 会议**，缺飞书最日常的协作文档。P3 把「文档」补上，并打通最有价值的一环：**会议纪要自动落成一篇协作文档**（飞书「妙记」体验）——会后纪要不止推进 IM，还沉淀成可继续编辑、可分享、可被知识库收纳的 Doc。

**战略已拍板（路线图，不再讨论）**：

- **集成 `suitenumerique/docs`，不自建编辑器 / CRDT**。Docs 是同源姊妹项目（Django + Yjs/BlockNote 协同编辑），CRDT 协同（整条路线图最大隐藏成本）由它承担，且共用同一 Keycloak OIDC 栈。
- **Docs 独立部署**（独立后端 + 协同 ws + 独立 PG/S3），we-meet 侧只做**薄链接 + 入口**，正文/CRDT 永不进 we-meet 库。
- 同一 Keycloak realm 做 SSO。

**调研结论（现状，决定本设计的约束）**：

| 项 | 现状 | 影响 |
|---|---|---|
| 认证 | lasuite OIDC（mozilla-django-oidc）；client `meet`（confidential） | docs 复用同 realm，新增独立 client |
| session cookie | `SESSION_COOKIE_DOMAIN` 未设 → 绑死单 host（meet.\<domain>） | meet/docs **不共享 app session**，SSO 靠 Keycloak realm 会话 |
| iframe | meet 发 `X-Frame-Options: DENY`，无 CSP | 「meet 嵌 docs」需 **docs 侧**放行 `frame-ancestors meet.<domain>` |
| 纪要推送 | `meeting_summary._push_summary_to_im`（:192）+ `MeetingConversation`（models.py:1711，`summary_pushed_at` 幂等） | 克隆成 `_push_summary_to_doc` + `MeetingDoc` |
| 既有痕迹 | 全仓库零集成（无 BlockNote/yjs/iframe） | 绿地 |

---

## 二、关键决策

- **D1 集成而非自建。**（已拍板）
- **D2 部署拓扑：Docs 作为独立 helm release（或独立 compose），不并进 meet chart。** 理由：Docs 有独立版本管理、独立后端+协同 ws+独立 PG/S3，与 meet 隔离便于升级/扩容/故障恢复；`helm upgrade meet` 永不触碰 docs。
- **D3 SSO 走 Keycloak realm 会话，不共享 app cookie。** meet 与 docs 各自是独立 OIDC client、各自 session；用户在 meet 登录后访问 docs，docs 走自己的 OIDC 流，命中 Keycloak 已有 SSO 会话 → 静默登录。新增 confidential client `docs`。
- **D4 UX：meet 内「文档」入口以新标签 / 顶层导航深链到 docs.\<domain> 为主**（纸面 spike 修正，见 §三 结论）。理由：Docs 默认 `frame-ancestors NONE` + cookie `SameSite=Lax`，iframe 嵌入要同时放松这两项**且仍赌第三方 cookie**（Chrome/Safari 正淘汰），脆弱；而 La Suite 生态本就是「同 SSO 下多个独立顶层应用 + 启动器」组合，不靠互相 iframe。**iframe 嵌入降为可选、不推荐**，只在确有「不跳出会议页」强需求时再单独评估（届时需 Docs 侧放松 CSP + SameSite=None）。
- **D5 we-meet 侧薄链接模型 `MeetingDoc`（镜像 `MeetingConversation`）：** `room` OneToOne(SET_NULL，doc 比 room 长寿) + `doc_id` + `doc_url` + `pushed_at`。**正文/CRDT 不进 we-meet 库，Docs 持有。**
- **D6 妙记自动流转：** 扩 `meeting_summary`，`Summary` SUCCESS 后在 `_push_summary_to_im` 旁加 `_push_summary_to_doc`——调 Docs 建文档 API 写入纪要 markdown（+待办，可选转写），存 `MeetingDoc`，把 doc 链接也发进 IM。克隆 `_push_summary_to_im` 的**幂等守卫（pushed_at）+ soft-fail**（一处失败不回滚 summary、下次重试）。
- **D7 权限映射 MVP 最简：** 建文档时 owner = 会议组织者/发起人。Room↔Docs 细粒度权限同步、按部门共享**推迟**（依赖 P1 的 `team_key`，留给 P4 知识库）。
- **D8 入口/多语言照 P1/P2 模式：** `routes.ts` 加 `/docs` + `Header.tsx:87` 加 `docs` namespace + Link 块（照 calendar/contacts）+ `locales/{zh,en,fr,de,nl}/docs.json`。

---

## 三、⚠️ 前置 SPIKE（MVP 前必须，~1–2 天，成败决定文档轨）

### ✅ Spike 结论（纸面，已完成 — 2026-06-27）

不部署、扒 `suitenumerique/docs` 源码即可判定 S1/S2，结论是 **P3 比预想顺**：

- **S2 = GREEN（完全契合）。** Docs 有个**专为此类集成造的服务端端点** `POST /api/v1.0/documents/create-for-owner/`：
  - 鉴权 `ServerToServerAuthentication`（共享 token，非用户 OIDC，`permission_classes=[]`）；
  - body（`ServerCreateDocumentSerializer`）：`sub`（owner 的 Keycloak sub）+ `email`（owner 邮箱，备份——Docs 侧用户可能尚未存在，按 sub/email 懒建）+ `title` + **`content`（markdown 字符串，Docs 用 Node 转换微服务转成内部 yjs）** + 可选 `message`/`subject`（建文档通知邮件文案）；返回 `{"id": <doc_id>}`。
  - **与现状天衣无缝**：we-meet 有 `user.sub` + `user.email`，纪要本就是 markdown；we-meet 与 docs **共用同一 Keycloak realm → 同一 sub**，owner 归属精确；email 备份顺带解决「组织者还没登录过 Docs」的懒建（跟我们 IM uid resolve 同思路，这里 Docs 内建了）。
- **S1 = 走「新标签 / 顶层深链」，不走 iframe。** Docs 默认 `frame-ancestors: NONE` + session cookie `SameSite=Lax`——iframe 嵌入要同时放松这两项（CSP 放行 meet + `SameSite=None; Secure`），**且仍赌 Keycloak SSO 那步的第三方 cookie**（在淘汰），脆弱；而 Docs 与 meet 是**同一套 lasuite OIDC + 同一 realm**，新标签打开 docs.\<domain> 是**第一方 cookie 的标准 SSO、几乎必通**，也正是 La Suite 生态的组合方式。

**两大未知已在纸面消解**：S2 有现成端点、S1 选稳妥的新标签。下面 S1/S2 详述保留为「判定依据」；剩下的不再是"赌成败的 spike"，而是 **部署 Docs 栈 + 接线实现**（§四/§五）。**唯一留到部署时确认的小项**：`ServerToServerAuthentication` 的 token 配置项名 + 请求头格式（读 Docs `core/api/authentication.py`，部署时 5 分钟）。

---

### S1 — Keycloak 跨子域 SSO + iframe 可行性（判定依据）

**要验**：

1. 部署 `docs.<domain>` + Keycloak realm `meet` 加 `docs` client（redirect/webOrigins 指向 docs.\<domain>）。
2. **先验跨子域 SSO 本身（独立标签）**：在 meet 登录后，**新标签**访问 `docs.<domain>` → 应经 Keycloak 静默登录（不再输密码）。验证「同 realm 跨子域 SSO」成立。
3. **再验 iframe**：meet 内 `<iframe src="https://docs.<domain>/...">`，docs 在 iframe 里完成 OIDC 重定向链（docs→Keycloak→docs）。**重点观察第三方 cookie / SameSite**：Keycloak 会话 cookie 相对 iframe（其顶层是 meet.\<domain>）是**第三方**，Chrome/Safari 可能拦截 → iframe 内静默登录失败、反复重定向或要求重新登录。
4. docs 侧设 `Content-Security-Policy: frame-ancestors https://meet.<domain>`，且不与 `X-Frame-Options` 冲突（用 CSP，去掉 DENY）。

**成功标准**：meet 登录态下，iframe 内 docs **免登可编辑**，刷新/重进不掉登录。

**失败 / 缓解**：
- 第三方 cookie 被拦 → (a) 让 Keycloak + docs 的 session cookie 设 `SameSite=None; Secure`；(b) 仍不行 → 走 **D4 fallback：新标签打开 docs.\<domain>**（cookie 第一方，SSO 必通）。
- **决策门**：S1 通过 → iframe 深链；S1 不通过但 §S1.2 独立标签 SSO 通过 → 新标签；两者都不通过 → 文档轨重评（概率极低，SSO 本身是标准能力，问题只在 iframe 第三方 cookie）。

### S2 — Docs server-to-server 建文档 API

**要验**：Docs 是否提供「**程序化建文档 + 写入初始正文 + 指定 owner/权限**」的服务端接口（机器 token / service account / 管理 API），供 we-meet 后端在会后建妙记 Doc。

**观察点**：
- Docs REST API 是否有 create-document 端点；鉴权方式（Bearer / 服务账号 / 管理 token）。
- 能否设初始正文（纪要 markdown / BlockNote）与文档归属（组织者为 owner / 某组共享）。
- 拿到的标识够不够我们存 `MeetingDoc`（doc_id + 可深链的 doc_url）。

**成功标准**：一条 curl/脚本用机器凭据建出一篇带初始正文的文档，返回 doc_id + url。

**失败 / 缓解**：若无服务端建文档 API（只能交互式建）→ 妙记自动落 Doc 降级为「会后在 IM/会议详情给一个『建文档（带纪要模板）』按钮，用户点了用其登录态建」，或评估给 Docs 提最小 PR/适配。

### Spike 产出 + 决策门

一页 spike 结论：**S1 走 iframe / 新标签 / 重评**；**S2 自动落 Doc 可行 / 降级**。据此再敲定 MVP 细节，回流更新本文档 + 路线图 P3/P4。**spike 没出结论前不写 MVP 代码。**

---

## 四、MVP 范围（spike 通过后）

| 范围 | 内容 |
|---|---|
| 入口 | `/docs` 路由（iframe 或新标签，据 S1）+ Header「文档」入口 + 5 语言 `docs.json` |
| 链接模型 | `MeetingDoc`（room OneToOne + doc_id + doc_url + pushed_at）+ 迁移 |
| 妙记落 Doc | `_push_summary_to_doc`：Summary SUCCESS → 建 Doc 写纪要 → 存 MeetingDoc → doc 链接也发进 IM（复用 pushed_at 幂等、soft-fail） |
| 部署 | Docs 独立 release + Keycloak `docs` client + DNS/ingress/证书 |

**Later（不在 MVP）**：房间内文档侧栏、按日历事件建文档模板、Room 权限↔Docs 权限同步、知识库/空间（**P4 建于此之上**，复用 Department `team_key` 做空间↔部门权限映射）。

---

## 五、部署拓扑（D2 展开）

- **独立 helm release `docs`**（新建 `src/helm/docs/`，镜像 `src/helm/meet/` 模板结构）或独立 compose，含：Docs Django 后端 + 协同 ws（y-provider / Node）+ **独立 PG** + **独立 S3 桶**（火山 TOS 另建桶或复用 `we-meet` 桶子目录）。
- Keycloak realm `meet` 加 confidential client `docs`（照 `bootstrap-realm.sh:59` 的 meet client：`redirectUris=[https://docs.<domain>/api/...callback/, https://docs.<domain>/*]`、`webOrigins=[https://docs.<domain>]`、`post.logout.redirect.uris`）。
- DNS 加 `docs` A 记录 → aliyun-sjy；ingress-nginx 加 docs host；cert-manager 签证（照官网/meet 既有路径）。
- **运维负担**：多两个服务（Docs 后端 + 协同 ws）+ 一个 PG。**4C8G 已经紧**（§十二 提过 OOM），需评估资源 / 是否加第二台 ECS（P4 也提过加机器）。

---

## 六、触点清单（文件级）

**后端**（`src/backend`）：
- `core/models.py` — 新增 `MeetingDoc`（镜像 `MeetingConversation`，models.py:1711）
- `core/services/meeting_summary.py` — 加 `_push_summary_to_doc`（克隆 `_push_summary_to_im`，:192；同址挂在 SUCCESS 分支）
- 新建 `core/services/docs_client.py` — 类比 `jusi_im.py` 的薄 client（鉴权以 S2 结论为准）
- 迁移（新增 MeetingDoc 表）

**前端**（`src/frontend`）：
- 新建 `src/features/docs/`（iframe 包装组件 / 或跳转入口，据 S1）
- `src/routes.ts` — 加 `/docs` 路由（:20-33 区域，含路由名 Union）
- `src/layout/Header.tsx:87` — `useTranslation` 加 `'docs'` + Link 块（照 calendar :177 / contacts :162）
- `src/locales/{zh,en,fr,de,nl}/docs.json`

**部署**：
- `deploy/aliyun/keycloak/bootstrap-realm.sh` — 加 `docs` client（照 meet client :59）
- `src/helm/docs/`（新独立 chart）或 `deploy/` 下 Docs compose
- `docs/installation/aliyun.md` — 加 Docs 部署章节 + DNS/ingress 行

---

## 七、风险

1. **iframe 内 SSO 被第三方 cookie 拦**（S1 主风险）→ fallback 新标签。
2. **Docs 无服务端建文档 API**（S2 风险）→ 妙记自动落 Doc 降级为手动/按钮触发。
3. **运维负担 +2 服务 +1 PG**，4C8G 吃紧，可能要加机器。
4. **Docs 与 we-meet 解耦后的版本/升级兼容面**（独立 release 是双刃）。

---

## 八、验证（端到端）

| 阶段 | 动作 | 期望 |
|---|---|---|
| Spike S1 | meet 登录 → iframe 内 docs | 免登可编辑，刷新不掉登录（或确认需走新标签 fallback） |
| Spike S2 | 机器凭据 curl 建文档 | 返回 doc_id + url，正文写入成功 |
| MVP 入口 | Header「文档」→ `/docs` | 进入 docs（嵌入或新标签），SSO 静默登录 |
| MVP 妙记 | 会议结束 → 纪要生成 | 自动建 Doc + IM 收到 doc 链接 |

---

## 九、立即下一步（本文档拍板后）

> 纸面 spike 已完成（§三 结论）：S2 有现成端点、S1 走新标签。所以下面直接是**部署 + 实现**，不再有"赌成败"的 spike 步骤。

1. **部署 Docs 栈**：`docs.<domain>`（Docs 后端 + 协同 ws + 独立 PG/S3）+ Keycloak realm `meet` 加 `docs` client + DNS/ingress/证书。配 `SERVER_TO_SERVER_API_TOKENS`（与 we-meet 共享一个 token）、`OIDC_RP_CLIENT_ID=docs`、`OIDC_REDIRECT_ALLOWED_HOSTS`。
2. **we-meet 接线**：`docs_client.py`（调 create-for-owner，带 sub/email/title/markdown content + server token）+ `MeetingDoc` 模型 + `_push_summary_to_doc`（Summary SUCCESS → 建 Doc → 存 MeetingDoc → doc 链接也发进 IM）+ `/docs` 新标签入口 + 5 语言。
3. **E2E**：会议结束 → 纪要 → 自动建 Doc + IM 收到链接；点「文档」入口 → 新标签 SSO 免登进 docs。
