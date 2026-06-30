# P7 — IM 富消息(图片优先)

> 这是 P0–P6 自研 IM(jusi-light-im,纯文本私聊/群聊/历史/已读 + 飞书式外壳)之后的**消息内容增强**。性质:**只扩展不修改** —— 复用现有 SDK 的 `content_type` 透传 + we-meet 现成 OSS presigned 基建,不动 jusi-light-im 服务端。design-first(本文)→ 拍板 → 增量实现。
>
> 用户已选定**图片消息**作为消息模块的第一个增强点(P7-a)。撤回 / 引用回复 / 表情回复作为后续子阶段(P7-b…)备选,本文先落 P7-a。

## 一、Context / 目标

we-meet 自研 IM 目前只能发纯文本。对标飞书/微信,「发图片」是 IM 最基础的多媒体能力。目标:消息输入区加「发图片」,选图 → 直传 OSS → 发 `content_type='image'` 消息;消息流渲染缩略图(点击看大图),会话列表预览显示「[图片]」。

**范围边界**:
- 只动 we-meet(`src/backend` + `src/frontend`)+ 一个 OSS 桶 + CORS。
- **不动 jusi-light-im 服务端**(独立仓库 / 独立 ECS)。
- 不引入 we-meet 侧消息正文存储(正文/key 仍由 jusi-light-im 持久化)。

## 二、现状(grounded)

| 件 | 现状 |
|---|---|
| IM SDK | `@jusi/light-im-sdk` `Client.sendText(cid, body, {contentType})` **透传任意 `content_type` + 字符串 `body`**;Message `{mid,cid,sender_uid,seq,content_type,body,ts}`。已用 `'system'`,其余按文本渲染 |
| 发送 | `MessageInput.tsx`(纯文本输入)→ `ChatPane.tsx onSend` → `client.sendText(cid,text)`(无 contentType) |
| 渲染 | `MessageItem.tsx`:`content_type==='system'` 居中胶囊,其余文本气泡(`renderBody` 处理 @mention) |
| 历史/实时 | `hooks/useMessages.ts`:`loadHistory` 拉一页 + `onMessage` 实时追加(按 mid 去重、seq 排序);无乐观更新 |
| 列表预览 | `ImRoute.tsx previewOf`:按 `last_content_type` 生成文案(群聊拼「发送人: 正文」);`ConversationList` 直接渲染 |
| OSS 直传基建 | 头像那套:`core/utils.py` 的 `_profile_s3_client()`(**按桶传参,不绑桶**)、`generate_profile_image_get_url()`、`ALLOWED_PROFILE_IMAGE_MIME_TYPES`、`PROFILE_UPLOAD_URL_TTL_SECONDS`(300s)/`PROFILE_IMAGE_GET_URL_TTL_SECONDS`(1h);桶 `meet/settings.py:183-191`(均 private,读走 presigned GET);前端三步 `src/features/auth/api/uploadAvatar.ts`(PUT 字节裸 fetch,**无 Bearer**) |

**好消息**:`content_type` 透传 + 头像 presigned 基建现成,图片消息基本是"两套现成能力拼起来"。

## 三、关键决策

- **D1 图片走 `content_type='image'`,`body=OSS object_key`(不是 URL)。** key 永久持久在消息里,presigned GET URL 1h 过期,**渲染时按 key 批量重签**(镜像 `core/api/im.py users/resolve` + 前端 `resolveImUsers`)。绝不把会过期的 URL 塞进消息正文。
- **D2 复用头像 presigned 模式,不用 File 模型。** File 模型要建 DB 行 + upload-ended 二段确认;图片消息正文由 jusi-light-im 持有,we-meet 只需"签发上传 URL + 渲染时签发读取 URL",**无需建表**。复用 `_profile_s3_client()`(按桶传参)。
- **D3 新建专用桶 `we-meet-chat-image`(private)。** 与头像桶同档隔离、CORS 规则同一套(用户已熟),不混入通用媒体桶,边界清晰。
- **D4 端点挂 `ImViewSet`,与 `users/resolve` 同风格**:`POST /im/images/upload-url/`(签发 PUT)+ `POST /im/images/resolve/`(批量签发 GET)。`IsAuthenticated`。
- **D5 鉴权粒度取舍**:`images/resolve` 只对 `chat/` 前缀 key 签发 GET,**不校验调用者是否在该消息所在会话**。靠 key 含 uuid 不可猜 + 需登录兜底,与头像同档,MVP 可接受。收紧需 we-meet 记录 key↔会话映射(暂不做)。
- **D6 大图体验**:上传前非 gif 大图用 canvas 等比缩到最长边 ~1600px、压 jpeg/webp(复用 `AvatarUploadDialog` canvas 思路)控制体积;gif 原样传(保动图),仅限大小 ~10 MiB。
- **D7 即时预览**:发送方上传完把本地 blobURL 写进 resolve 查询缓存,自己立刻看到图,不等服务端回包 + 重签往返。

## 四、实现分期(拍板后)

- **P7-a-1 后端**:`settings.py` 加 `AWS_STORAGE_BUCKET_NAME_CHAT_IMAGE`;`utils.py` 加 `generate_chat_image_upload_url` / `generate_chat_image_get_url` + `ALLOWED_CHAT_IMAGE_MIME_TYPES`(jpeg/png/webp/gif)+ 最大 ~10 MiB;`core/api/im.py ImViewSet` 加 `images/upload-url`(校验类型/大小)+ `images/resolve`(只签 `chat/` 前缀)。
- **P7-a-2 前端 api**:`api/uploadChatImage.ts`(镜像 uploadAvatar 三步 + canvas 压缩 + 校验)、`api/resolveChatImages.ts`(镜像 resolveImUsers)。
- **P7-a-3 前端 UI**:`MessageInput` 加发图按钮(隐藏 `<input type=file accept=image/*>`,上传中禁用+转圈,新 prop `onSendImage(file)`);`ChatPane` 实现 `onSendImage`(upload → `sendText(cid,key,{contentType:'image'})`+ 即时 blobURL 缓存)并收集图片消息 key 批量 resolve(`['im','image-urls',cid,keys]`,`staleTime 50min`)传 `imageUrl` 给 `MessageItem`;`MessageItem` 加 `content_type==='image'` 分支(`<img>` maxW~240/maxH~320 contain 圆角,点击新标签看大图)。
- **P7-a-4 预览 + i18n**:`ImRoute.previewOf` 对 `image` 用 `t('preview.image')`;5 语言 `src/locales/{zh,en,fr,de,nl}/im.json` 加 `preview.image`、`input.image`、`image.invalidType`、`image.tooLarge`、`image.uploadError`、`image.alt`。
- **P7-a-5 ops**:OSS 建 `we-meet-chat-image` 桶(private)+ CORS(`AllowedOrigin https://meet.we-meet.online`、Methods PUT/GET/HEAD、Headers *、ExposeHeader ETag,与头像桶同);helm values 注入 `AWS_STORAGE_BUCKET_NAME_CHAT_IMAGE`。

每期 `tsc -b`/eslint/`vite build` 把关;后端 `bin/pytest` 跑新端点。

## 五、风险

1. **presign 鉴权粒度**(D5):任意登录用户可对 `chat/` key 签 GET;靠 uuid 不可猜兜底,MVP 可接受。
2. **GET URL 1h 过期**:前端 `staleTime 50min`,长时间停留再发/切会话自动重签。
3. **新桶 CORS 漏配**:浏览器 PUT 直传需桶配 CORS(`<img>` 显示走 presigned GET 不需)。上线前先配,否则发图「Failed to fetch」(同头像曾踩)。
4. **HEIC 等浏览器不能解码的格式**:仅放行 jpeg/png/webp/gif,其余前置拒。

## 六、后续子阶段(备选,本文未实现)

- **P7-b 引用回复**:`content_type='quote'` + body 编码 JSON(被引用 {mid,sender,body} + 回复正文),纯前端,零后端。
- **P7-c 消息撤回**:墓碑协议消息 `content_type='recall'`,前端过滤原消息显「已撤回」;不动后端,但无服务端强制校验。
- **P7-d 表情回复**:需改 jusi-light-im 服务端(reaction 存储 + 新帧),独立仓库,工程量最大。

## 七、立即下一步(本文档拍板后)
1. **P7-a-1** 后端桶/utils/端点。
2. **P7-a-2/3** 前端 api + 发图/渲染。
3. **P7-a-4** 预览 + 5 语言。
4. **P7-a-5** OSS 建桶 + CORS(用户侧 ops)→ 真机验证。
