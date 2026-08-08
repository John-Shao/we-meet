# P11c — 日程助手代理退群组织者

> 状态：**已实现，待按 jusi → we-meet 顺序发布**（2026-08-08）。
>
> 前置设计：[`p8-im-calendar-integration.md`](./p8-im-calendar-integration.md)、
> [`p11-im-group-bots.md`](./p11-im-group-bots.md)、
> [`p11b-im-group-bots-cards.md`](./p11b-im-group-bots-cards.md)。

## 1. 职责边界

日程助手只解决一个明确的协作问题：日程仍指向原来源群，但组织者已经退出
该群，无法再以群成员身份发布后续的修改或取消通知。此时由日程助手向原群
代理发送 `event-card`，卡片继续用既有 `organizer_name` 标明真实组织者。

发送身份规则：

1. 组织者仍在来源群：组织者发送；
2. jusi 明确判定组织者不是群成员：日程助手代理发送；
3. 组织者 UID 无法解析：SYSTEM 发送，不用助手掩盖技术异常；
4. 日程助手发送失败：最终尝试 SYSTEM；
5. 所有通知均为 best-effort，不影响日程修改或取消本身。

“在消息列表提醒日程”是每个用户自己的实时聚合视图，可由用户关闭，不创建
聊天消息。日程助手不负责倒计时、即将开始、每日摘要或系统自动改期；当前也
没有系统自动修改既有日程的业务。

## 2. 跨仓严格发送协议

`POST /admin/messages` 新增可选请求字段：

```json
{
  "cid": "...",
  "sender_uid": "...",
  "content_type": "event-card",
  "body": "{...}",
  "require_sender_membership": true
}
```

当 `require_sender_membership=true`、显式 `sender_uid` 不是当前会话成员时，
jusi 必须在分配 seq、写消息、冒泡、广播和离线推送之前返回：

```http
HTTP/1.1 409 Conflict
Content-Type: application/json

{"code":"sender_not_member","message":"sender is not a conversation member"}
```

字段缺省或为 `false` 时保持兼容：非成员发送者仍被改写为 SYSTEM。SYSTEM
身份不需要成员资格；真人和 `role=bot` 的成员均可通过严格检查。

we-meet 只把上述稳定错误码解释为“组织者已退群”。其他 4xx、5xx、超时或
异常响应仍是普通 IM 故障，不能触发日程助手代理。

## 3. 投递流程

`calendar_im_notify.push_card()` 先解析组织者 UID，并用严格模式投递：

- 成功：结束；
- `sender_not_member`：调用 `post_as_builtin(calendar-assistant, ...)`；
- UID 解析失败：直接以 SYSTEM 投递；
- 助手未 seed、无法入群或发送失败：最终以 SYSTEM 投递。

`event-card` 协议不变，Web 与 Android 继续从消息发送者渲染日程助手头像、
名称和机器人标签，从卡片的 `organizer_name` 展示责任人。助手成功代发后按
现有规则创建 `ImBotInstallation`，进入 C/M 端机器人治理视野。

## 4. 验证

- jusi：严格成员发送成功；严格非成员返回 409 且零消息、零 seq、零广播、
  零推送；缺省字段保持 SYSTEM 改写；机器人成员不被拒绝。
- we-meet：留群修改由组织者发送；退群后的改期、参与人变化和取消均只产生
  一条日程助手消息；卡片保留组织者姓名；UID 解析失败走 SYSTEM；其他 jusi
  错误不误判；助手失败最终走 SYSTEM。
- 双端：回归助手身份和卡片显示；“在消息列表提醒日程”的开关、聚合列表和
  进入会议行为不变。

## 5. 发布

无数据库迁移、无卡片协议升级、无历史回填。必须先发布支持严格字段的 jusi，
再发布 we-meet；旧 jusi 可能忽略未知字段并继续把退群组织者改写为 SYSTEM。
上线后分别记录组织者严格发送成功、非成员转助手、UID 异常转 SYSTEM、助手
失败转 SYSTEM 四类日志。
