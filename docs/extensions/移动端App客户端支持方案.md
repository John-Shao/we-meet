# 移动端 App 客户端支持方案

> 状态：Part A 后端已实施，待部署与回归验证
> 范围：会议核心 + 个人资料
> 设计原则：**只扩展、不修改** —— 优先新增独立文件/字段/动作，少动现有代码路径

## 1. 背景与目标

- **we-meet 现状**：v1.16.0，纯 web 客户端，后端（`suitenumerique/meet` 的 rebase）原本无任何移动端能力。
- **参考实现**：同团队早期 fork `jusi_meet_suite1.9`（v1.9.0）已建成完整移动端后端，其 `docs/mobile-integration-*.md` 是现有 Android App 依赖的 API 契约。
- **目标**：把 jusi 已验证的移动端后端按"只扩展不修改"方式移植进 we-meet，使现有 Android App 经少量适配即可对接；App 首版聚焦**会议核心 + 个人资料**。
- **本期不纳入**：device-api（IoT 推流）、discover/UGC、AI 智能体 —— 列为后续阶段。

## 2. 总体认知

实时音视频全部由 **LiveKit** 承担。we-meet 后端 DRF 已配 `OIDCAuthentication`，**主 API 已能接受 `Authorization: Bearer <access_token>`**，移动端调用主 API 无需新增鉴权层。移动端真正缺的三块以**最小改动**实现：OTP 登录入口、房间结束动作、个人资料字段与图片上传；外加把房间 `slug` 改为 8 位数字会议号。

## 3. 已确认的关键决策

| # | 决策 | 说明 |
|---|------|------|
| 1 | **会议号** | 房间 `slug` 改为服务端生成的**唯一 8 位数字**（`save()` 时生成），它本身即会议号；不再保留 `meeting_code` 字段。这同时修掉了中文房名 `slugify()` 为空串导致的 `slug` 唯一性冲突 |
| 2 | **结束后禁止重进** | `end` 后 `RoomSerializer.to_representation` 不再下发 `livekit` token，`request_entry` 对已结束房间返回 404；房间信息（含 `closed_at`）仍可 GET |
| 3 | **图片存储** | 头像/封面桶**私有**（阻止公共访问开启）；后端存 `object_key`，读取时下发 1 小时有效的**预签名 GET URL**。避免公共读桶的全桶枚举/盗链/合规风险 |
| 4 | **对象存储** | 全部统一到**阿里云 OSS**（华南1 深圳）：主桶 `we-meet-video`、头像 `we-meet-avatar`、封面 `we-meet-cover` |

## 4. Part A — 后端移植（`src/backend`，已实施）

### A1. 移动端 OTP 认证（100% 新增）

| 动作 | 内容 |
|------|------|
| 新建 `core/api/mobile_auth.py` | `SendOtpView`、`VerifyOtpView`、`MobileAuthThrottle`，火山引擎 SMS 发送 + Keycloak Token Exchange |
| 改 `core/urls.py` | **仅追加** 2 条 path：`api/mobile/auth/send-otp/`、`api/mobile/auth/verify-otp/` |

OTP 用户首次携 token 调 API 时，`OIDCAuthentication`（`OIDC_CREATE_USER=true`）自动建 Django 用户，无需改鉴权。jusi 的 `keycloak_sms.py`（Keycloak 自带登录页走短信）本期不需要，已舍弃。

### A2. 房间：8 位数字 slug + 结束动作

| 动作 | 内容 | 性质 |
|------|------|------|
| `Room` 加 `ended_at` | `DateTimeField(blank, null)` | 加列 |
| `Room` 加 `is_ended` 属性、`generate_unique_slug()` 静态方法 | 仿 `generate_unique_pin_code` 模式，生成唯一 8 位数字 | 类内新增 |
| `Room.save()` 调整 slug 生成 | 新房间无 `slug` 时生成 8 位数字（不再依赖 `slugify(name)`） | 现有方法内调整 |
| `RoomViewSet.get_object` | 非 UUID 时按 `slug=pk` 匹配 | 现有方法内简化 |
| `RoomViewSet` 新增 `@action end` | `POST /rooms/{id}/end/`，owner-only，置 `ended_at` + 踢出全部人 | 新增方法 |
| `ParticipantsManagement.remove_all()` | 列出并移除房间全部参会者 | 类内新增方法 |
| `RoomSerializer`/`ListRoomSerializer` 加 `created_at`/`closed_at` | `closed_at` 为 `SerializerMethodField` | 向后兼容字段新增 |
| `RoomSerializer.to_representation` 门控 + `request_entry` 守卫 | 已结束房间不下发 token / 拒绝入场 | 现有方法内各加判断 |

> 删除 `meeting_code` 字段：它原是为可输入会议号新增的独立字段；现 `slug` 本身即 8 位数字会议号，独立字段已无必要。迁移 `0022` 删列。

### A3. 个人资料扩展（私有桶 + 预签名 URL）

| 动作 | 内容 | 性质 |
|------|------|------|
| `User` 加 `intro`/`avatar_key`/`cover_key` | `CharField(100)` / `CharField(500)` ×2（存 object_key，非 URL） | 加列 |
| `UserSerializer` | 加 `intro`（可写）；`avatar_url`/`cover_url` 为 `SerializerMethodField`，读时按 key 生成预签名 GET URL | 向后兼容（API 仍返回 URL 字段） |
| `core/utils.py` 追加个人资料函数 | `generate_profile_image_upload_url`（预签名 PUT）、`generate_profile_image_get_url`（预签名 GET）、`head_profile_object`、`delete_profile_object`；独立 boto3 client | 文件尾新增 |
| `UserViewSet` 新增 3 个 `@action` | `me/upload-url`、`me/profile-image`、`me/deregister` | 新增方法 |
| 新建 `core/services/deregistration.py` | `UserDeregistrationService` | 新文件 |

### A4. 配置、依赖与迁移

- `meet/settings.py` 追加：`AWS_STORAGE_BUCKET_NAME_AVATAR/COVER`、`VOLC_SMS_AK/SK/ACCOUNT/SIGN/TEMPLATE_ID`、`MOBILE_AUTH_SERVICE_CLIENT_ID/SECRET`、`MOBILE_AUTH_OTP_EXPIRY/MAX_ATTEMPTS/LENGTH`、`MOBILE_AUTH_DEMO_PHONES/OTP`
- `pyproject.toml` 新增 `volcengine`、`tenacity`；`uv.lock` 已同步
- 迁移：`0020_room_meeting_code_ended_at`（加列）、`0021_user_intro_avatar_cover`（加列）、`0022_remove_room_meeting_code`（删 `meeting_code` 列）
- OTP 验证码用 `django.core.cache`，依赖 `CACHES` 指向 Redis（we-meet 已是）

### A5. 主动放弃的修改

为贯彻"只扩展不修改"：`expires_at` 会议码过期、`list` 排序、限速类、`generate_token` 改动 —— 全部不做。`slug` 改为 8 位数字后，`Room.clean_fields()` 原本的 `slugify(name)` 赋值已无意义，连同该重写一并移除（`slug` 现由 `save()` 生成）。

## 5. Part B — App 客户端路线图

- **B1（v1，本期，已实施）**：App API 基址指向 we-meet；`RoomDto` 直接用 `slug`（8 位数字）作会议号；`UploadUrlResponse` 去掉 `public_url`；头像/封面签名 URL 用稳定 Coil 缓存 key（按对象路径）处理缓存与过期。
- **B2（v1.x）**：Android App Links 深链；FCM 推送；access_token 预刷新。
- **B3（后续）**：后端续移植 discover/UGC、AI 智能体、device-api。

## 6. 部署清单（Part A 上线）

- [ ] 阿里云 OSS：`we-meet-video`（主桶）、`we-meet-avatar`、`we-meet-cover` 三个桶**均保持私有**（阻止公共访问开启）
- [ ] Helm `values.meet.yaml`：`AWS_S3_*` 指向 OSS（`oss-cn-shenzhen.aliyuncs.com` / `cn-shenzhen`）；`values.secrets.yaml` 填 OSS 的 AK/SK
- [ ] Keycloak：`token-exchange` 特性开启（compose 加 `KC_FEATURES` 后重建容器）；`meet-service` 机密客户端 + 服务账户角色（见 `deploy/aliyun/keycloak/bootstrap-mobile.sh`）
- [ ] 火山引擎 SMS：`VOLC_SMS_*` 已复用 jusi 配置
- [ ] `python manage.py migrate`（含 `0020`/`0021`）
- [ ] CI/Docker 跑 `pytest` 全量回归

## 7. 验证（逐接口对照契约）

部署后用 `MOBILE_AUTH_DEMO_PHONES`/`OTP` 取 `<access_token>`：

| 接口 | 验证点 |
|------|--------|
| send-otp / verify-otp | 响应键、400/429 对照 [移动端API接口文档.md](../apis/移动端API接口文档.md) §1 |
| GET /users/me/ | 含 `intro`/`avatar_url`/`cover_url`；图片字段为签名 URL，未设时为 `""` |
| upload-url → PUT → profile-image | 三步上传流（私有桶预签名 PUT），`object_key` 形如 `<user_id>/<hex>.jpg` |
| POST /rooms/ + GET /rooms/{slug}/ | `slug` 为 8 位数字；响应含 `created_at`/`closed_at` |
| POST /rooms/{id}/end/ | 返回 `ended_at`；结束后 GET 房间无 `livekit` 块 |
| POST /users/me/deregister/ | 返回 204 |

✅ 阿里云 OSS 的 S3 兼容(SigV4)预签名 PUT/GET 已在生产验证走通：`values.meet.yaml` 配 `AWS_S3_SIGNATURE_VERSION=s3v4` + `AWS_S3_ADDRESSING_STYLE=virtual`，头像/封面(`we-meet-avatar`/`we-meet-cover`)与 IM(`we-chat-*`)桶均已投产，**无需改用 OSS 原生 SDK**。

## 8. 关键文件

**新建**：`core/api/mobile_auth.py`、`core/services/deregistration.py`、迁移 `0020`/`0021`

**扩展**：`core/urls.py`、`core/utils.py`、`core/api/viewsets.py`、`core/api/serializers.py`、`core/models.py`、`core/services/participants_management.py`、`meet/settings.py`、`pyproject.toml`

**参考源**：`jusi_meet_suite1.9/src/backend/` + `docs/mobile-integration-*.md`
