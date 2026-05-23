# 移动端 API 接口文档

> App 客户端（we-meet-android）与 we-meet 后端之间的接口契约。
> 后端实现见 [移动端App客户端支持方案.md](移动端App客户端支持方案.md)。
> 字段或行为变更时，请同步更新本文档与 Android 端 DTO。

## 通用约定

| 项 | 值 |
|---|---|
| Base URL（生产） | `https://meet.we-meet.online` |
| 鉴权 | 除「认证」章节的 OTP 接口外，所有请求带 `Authorization: Bearer <access_token>` |
| 请求/响应体 | JSON（`Content-Type: application/json`） |
| 时间格式 | ISO 8601，如 `2026-05-22T14:58:12.345Z` |

**错误响应**：移动认证接口（`/api/mobile/auth/*`）4xx 返回 `{"error": "中文提示"}`；主 API（`/api/v1.0/*`）沿用 DRF 默认格式（`{"detail": ...}` 或字段级错误字典）。

---

## 1. 认证

### 1.1 发送短信验证码

`POST /api/mobile/auth/send-otp/` —— 无需鉴权。

请求：

```json
{ "phone": "13800000000" }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| phone | string | 是 | 11 位手机号，`1[3-9]\d{9}` |

成功 `200`：

```json
{ "success": true, "expires_in": 600 }
```

错误：

| 状态码 | body | 说明 |
|---|---|---|
| 400 | `{"error": "手机号格式不正确"}` | phone 格式错误 |
| 503 | `{"error": "短信发送失败，请稍后重试"}` | 短信服务异常 |
| 429 | （无 body） | 频率超限（10 次/分钟/IP） |

### 1.2 校验验证码（换取 Token）

`POST /api/mobile/auth/verify-otp/` —— 无需鉴权。

请求：

```json
{ "phone": "13800000000", "otp": "123456" }
```

成功 `200`：

```json
{
  "access_token": "eyJhbGci...",
  "refresh_token": "eyJhbGci...",
  "token_type": "Bearer",
  "expires_in": 300
}
```

`access_token` 有效期约 300 秒（由 Keycloak realm 配置决定）。后续所有 `/api/v1.0/*` 请求用它作 Bearer。

错误：

| 状态码 | error | 说明 |
|---|---|---|
| 400 | `手机号格式不正确` / `验证码已过期，请重新获取` / `验证码错误，还有 N 次机会` / `错误次数过多，请重新获取验证码` | |
| 503 | `服务暂时不可用，请稍后重试` 等 | Keycloak / 用户创建 / token 交换失败 |
| 429 | （无 body） | 频率超限 |

### 1.3 刷新 Token

直接调用 Keycloak，不经 we-meet 后端：

`POST https://id.we-meet.online/realms/meet/protocol/openid-connect/token`
`Content-Type: application/x-www-form-urlencoded`

```
grant_type=refresh_token
client_id=meet-service
client_secret=<MOBILE_AUTH_SERVICE_CLIENT_SECRET，向后端获取>
refresh_token=<refresh_token>
```

成功返回新的 `access_token` / `refresh_token`。`refresh_token` 过期后需重新走 1.1/1.2 登录。

> 当前 Android 客户端未实现静默刷新：`access_token` 过期（401）时提示重新登录。自动刷新列为后续项。

---

## 2. 房间

房间响应统一为下面的 **Room 对象**（`POST /rooms/`、`GET /rooms/{id}/` 均返回）：

```json
{
  "id": "a1b2c3d4-...-ef12",
  "name": "我的会议",
  "slug": "04821357",
  "configuration": {},
  "access_level": "public",
  "pin_code": null,
  "created_at": "2026-05-22T06:00:00Z",
  "closed_at": "",
  "accesses": [ { "id": "...", "role": "owner", "user": { ... } } ],
  "livekit": { "url": "wss://...", "room": "<room id>", "token": "eyJ..." },
  "is_administrable": true
}
```

| 字段 | 说明 |
|---|---|
| id | 房间 UUID |
| name | 房间名 |
| slug | **8 位数字会议号** —— 服务端生成、唯一；分享、加入用这个 |
| created_at | 创建时间 |
| closed_at | 房间结束时间 ISO 串；未结束为 `""` |
| accesses | 权限记录，仅 admin/owner 可见 |
| livekit | LiveKit 接入信息；**房间已结束时此字段不下发**（禁止重进） |
| is_administrable | 当前用户是否为该房间 owner/administrator |

### 2.1 创建房间

`POST /api/v1.0/rooms/?username=<显示名>`

```json
{ "name": "我的会议" }
```

成功 `201`：返回 Room 对象。`slug`（8 位数字会议号）由服务端生成，分享给他人加入。

### 2.2 获取房间信息

`GET /api/v1.0/rooms/{idOrCode}/?username=<显示名>`

`{idOrCode}` 可为房间 UUID 或 **8 位数字 slug（会议号）**。`username` 用于 LiveKit 内的显示名。

成功 `200`：返回 Room 对象，用 `livekit.url` + `livekit.token` 接入 LiveKit。

| 状态码 | 说明 |
|---|---|
| 404 | 房间不存在，或受限房间无权访问 |

> 房间已被 owner 结束后，本接口仍返回房间信息，但 **无 `livekit` 字段** —— 客户端据此判定不可再进入。

### 2.3 结束房间

`POST /api/v1.0/rooms/{id}/end/` —— **仅 owner**。

成功 `200`：

```json
{ "status": "success", "ended_at": "2026-05-22T07:30:00Z" }
```

服务端会踢出全部参会者；结束后该房间无法再加入。

| 状态码 | 说明 |
|---|---|
| 400 | 房间已结束 |
| 403 | 当前用户不是 owner |
| 404 | 房间不存在 |

---

## 3. 用户与个人资料

User 对象（`GET /users/me/` 等返回）：

```json
{
  "id": "9c6a2b4e-...",
  "email": "user@example.com",
  "full_name": "张三",
  "short_name": "三",
  "language": "zh-cn",
  "timezone": "Asia/Shanghai",
  "intro": "前端工程师",
  "avatar_url": "https://we-meet-avatar.oss-cn-shenzhen.aliyuncs.com/...?<签名>",
  "cover_url": ""
}
```

> `avatar_url` / `cover_url` 是**短期签名 URL**（私有桶，有效期约 1 小时）；未设置时为 `""`。客户端不应长期缓存该 URL 本身，应缓存其对象路径（`?` 之前部分）作为图片缓存 key。

### 3.1 获取我的资料

`GET /api/v1.0/users/me/` → User 对象。

### 3.2 更新个人简介

`PATCH /api/v1.0/users/{id}/` —— `{id}` 为本人 UUID（仅本人可改）。

```json
{ "intro": "新的个人简介" }
```

| 字段 | 说明 |
|---|---|
| intro | 0–100 字符；超长返回 400 |

成功 `200`：返回 User 对象。`language` / `timezone` 也可经此接口修改；`avatar_url` / `cover_url` 不可直接 PATCH（须走 3.3 + 3.4）。

### 3.3 申请图片上传 URL

`POST /api/v1.0/users/me/upload-url/`

```json
{ "kind": "avatar", "content_type": "image/jpeg", "size": 102400 }
```

| 字段 | 说明 |
|---|---|
| kind | `"avatar"` 或 `"cover"` |
| content_type | `image/jpeg` / `image/png` / `image/webp` |
| size | 字节数，`(0, 2097152]`（≤ 2 MiB） |

成功 `200`：

```json
{
  "upload_url": "https://we-meet-avatar.oss-cn-shenzhen.aliyuncs.com/...?<签名>",
  "object_key": "<user_id>/<hex>.jpg",
  "expires_in": 300,
  "headers": { "Content-Type": "image/jpeg" }
}
```

> 私有桶方案下**不再返回 `public_url`**。

### 3.4 上传并确认图片

三步流程：

1. **3.3** 取得 `upload_url` / `object_key` / `headers`
2. **PUT 二进制**到 `upload_url`，带上响应里的 `headers`（至少 `Content-Type`），**不要**加 `Authorization` 头。成功返回 200/204
3. **确认**：`PATCH /api/v1.0/users/me/profile-image/`

```json
{ "kind": "avatar", "object_key": "<user_id>/<hex>.jpg" }
```

成功 `200`：返回更新后的 User 对象（`avatar_url` / `cover_url` 已是新的签名 URL）。

| 状态码 | 说明 |
|---|---|
| 400 | kind/object_key 不合法、对象不存在、超 2 MiB、MIME 不在白名单 |

### 3.5 账号注销

`POST /api/v1.0/users/me/deregister/`

成功 `204`：账号被匿名化停用、Keycloak 用户删除，不可逆。客户端应清除本地 token 并返回登录页。

---

## 附录：与 jusi 后端的差异

现有 Android 客户端原对接 jusi 后端，迁到 we-meet 时的关键差异：

| 项 | jusi | we-meet |
|---|---|---|
| 会议号 | `slug` 即 6 位数字 | `slug` 即 **8 位数字**（服务端生成、唯一） |
| 头像/封面桶 | 公共读，URL 永久 | **私有桶**，URL 为短期签名 URL |
| upload-url 响应 | 含 `public_url` | **不含** `public_url` |

Android 端已适配：`RoomDto` 直接用 `slug`（8 位数字）作会议号；`UploadUrlResponse` 删除 `public_url`；头像/封面用稳定缓存 key。
