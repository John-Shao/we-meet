# App 端补齐 Web 端功能 二期 — 部署步骤

> 配套文档：[App端补齐Web端功能_二期_IM通讯录日历.md](App端补齐Web端功能_二期_IM通讯录日历.md)（设计）、
> [../installation/aliyun-release-runbook-cn.md](../installation/aliyun-release-runbook-cn.md)（日常发布 Runbook）
> 用法：逐项打勾，带命令的可直接复制执行。

## 0. 本次变更范围（三个仓库）

| 仓库 | 分支 / 提交 | 变更内容 | 部署动作 |
|------|------------|---------|---------|
| `we-meet-android` | `main` @ `b4201ba` | App：IM 一期补齐（群聊/图片/文件/已读回执/会话管理）+ 通讯录 + 日历 + 5 Tab 改造 | 构建 APK + 分发 |
| `jusi-light-im` | `main` @ `32dac0e` | **仅 Android SDK**（`sdk/android`，对齐 web alpha.7）；服务端代码零变更 | 只推送，**无需部署** |
| `we-meet` | `aliyun-dev` @ `f746cf2f` | **仅 Web 前端**（日历事件编辑/删除 + 详情展示提醒）+ 2 个文档提交；后端零变更、无迁移 | 前端镜像 build + rollout |

结论：**后端（Django）、jusi-light-im 服务端、Keycloak、LiveKit 均无变更**。App 依赖的服务端能力
（directory / calendar-events / IM 桥接 / jusi P9–P13）已在生产运行（Web 端正在使用），第 1 节做验证性核对即可。

## 1. 服务端依赖核对（只查不改，约 10 分钟）

任一失败 → 停止发布，先排查服务端。

- [ ] **jusi-light-im ≥ P13**（群成员 / 已读快照 / 会话设置 / conv 帧）：

  ```bash
  # 先用 we-meet token 换 IM token：
  TOK=<we-meet access_token>
  curl -s -X POST -H "Authorization: Bearer $TOK" https://meet.we-meet.online/api/v1.0/im/token/
  # 用返回的 token 查会话列表，返回体应含 name/members/pinned/last_message 字段：
  curl -s -H "Authorization: Bearer <im_jwt>" https://im.we-meet.online/v1/conversations
  ```

  快捷佐证：Web 端已读回执、置顶/免打扰当前在线可用 = 服务端已就位。

- [ ] **we-meet 后端桥接与业务端点**（demo 手机号 13800000000–009 取 token）：

  ```bash
  curl -s -H "Authorization: Bearer $TOK" "https://meet.we-meet.online/api/v1.0/directory/members/?page_size=1"
  curl -s -H "Authorization: Bearer $TOK" "https://meet.we-meet.online/api/v1.0/calendar-events/?page_size=1"
  ```

  两个都返回 200 即通过。

- [ ] **（非阻塞）日历提醒 CronJob 在跑**：

  ```bash
  kubectl -n meet get cronjob | grep reminders   # 期望 meet-backend-reminders  */5 * * * *
  ```

## 2. 代码推送（注意先后顺序）

- [ ] 先推 SDK（App 构建机 composite build 依赖它）：

  ```bash
  cd D:/workspace/jusi-light-im && git push origin main
  ```

- [ ] 再推 App：

  ```bash
  cd D:/workspace/we-meet/we-meet-android && git push origin main
  ```

- [ ] 推 we-meet（Web 前端 + 文档）：

  ```bash
  cd D:/workspace/we-meet/we-meet && git push origin aliyun-dev
  ```

## 3. Web 前端发布（按日常 Runbook，仅 frontend）

本次属于 Runbook 判断表的「仅前端代码」行：build frontend → rollout frontend，**不需要** helm upgrade / migrate。

- [ ] 阶段 A — 构建机 build + push：

  ```bash
  cd /mnt/d/workspace/we-meet/we-meet
  git pull origin aliyun-dev
  bash deploy/aliyun/build-and-push.sh frontend
  ```

- [ ] 阶段 B — 生产 ECS（aliyun-sjy）：

  ```bash
  cd /opt/we-meet && git pull origin aliyun-dev
  kubectl -n meet rollout restart deploy/meet-frontend
  kubectl -n meet rollout status  deploy/meet-frontend --timeout=120s
  ```

- [ ] 页面验证：Web 日历 → 打开自己组织的日程 → 出现「编辑 / 删除」按钮；编辑标题保存生效；
  详情显示「🔔 提前 N 分钟」；非组织者看不到编辑/删除。

## 4. Android APK 构建

- [ ] **构建机前置**：JDK 17；`jusi-light-im` 仓库 checkout 在 App 仓库上两级的同级路径
  （`we-meet-android/../../jusi-light-im`）且在 `main`（composite build 从源码编译 SDK）。
- [ ] **提版本号**（`app/build.gradle.kts`）：`versionCode 1 → 2`、`versionName "0.1.0" → "0.2.0"`。
- [ ] **确认生产配置**：`gradle.properties` 默认已是生产三件套
  （`meet` / `id` / `im.we-meet.online`）；确认构建机 `local.properties` 无本地覆盖残留
  （特别是 `WE_MEET_BASE_URL` / `JUSI_IM_BASE_URL`）。
- [ ] **构建**（二选一）：
  - 内测快速通道（debug 签名，可直接装机）：

    ```bash
    ./gradlew :app:assembleDebug
    # 产物 app/build/outputs/apk/debug/app-debug.apk
    ```

  - 正式包：⚠️ 当前 release buildType **未配置签名**，需先生成 keystore 并在
    `local.properties` 配 `RELEASE_STORE_FILE/STORE_PASSWORD/KEY_ALIAS/KEY_PASSWORD`、
    `build.gradle.kts` release 块加 `signingConfig`，再 `./gradlew :app:assembleRelease`。

## 5. 单机冒烟（1 台真机 + Web 对端，约 20 分钟）

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

前 4 项回归，后 6 项新功能：

- [ ] OTP 登录 → 默认落**会议** Tab；建会 / 输会议号入会 / 音视频互通 / 离会正常
- [ ] 5 个 Tab 顺序：消息 · 日历 · 会议 · 通讯录 · 我的
- [ ] 我的 → AI 助手 → 打电话，链路可达且能逐级返回
- [ ] 个人资料改昵称 / 上传头像正常
- [ ] **消息**：列表显示真名/头像/预览/时间；与 Web 互发文本；人在会议 Tab 时 Web 来消息 → 消息角标 +1
- [ ] **图片/文件**：App 发 >2MiB JPEG（Web 能看，验证 webp 压缩）；收 Web 图片可点开灯箱；互传文件可打开
- [ ] **群聊**：新建会话选 2 人 → 起名建群 → 两端出现；改名 / 拉人实时生效
- [ ] **已读回执**：直聊「已读/未读」实时翻转；群「n人已读」数字与名单正确
- [ ] **通讯录**：部门下钻 + 面包屑 + 系统返回逐级返回；搜索过滤；成员详情 → 发消息 → 直达聊天页
- [ ] **日历**：Web 建的日程 App 有点 + agenda（两端时间一致）；App 创建带参与人日程 → Web 可见、
  对方可 RSVP；带会议的日程「加入会议」→ 预览页 → 入会

## 6. 深度验收（双人双机，约 30 分钟，可与灰度并行）

- [ ] **断网重连**：断网 30 秒恢复 → 状态条「重连中→已连接」，断档期间对方发的消息重同步后出现（重点）
- [ ] 挂机超过 IM token TTL（24h，可临时缩短验证）→ 静默重连，不弹登录
- [ ] 群生命周期：踢人（被踢端实时消失 + 提示）、转让群主、群主退群自动转让、末人解散
- [ ] 置顶 / 免打扰 / 删除会话；被删直聊收到新消息后重新出现
- [ ] 头像 / 聊天图片闲置 1 小时后仍能渲染（presign 过期 vs Coil 稳定缓存 key）
- [ ] 300+ 消息会话向上翻页无重复、加载到头正确停止
- [ ] 空态不崩：空部门组织、无日程日、无 room 的日程（无入会按钮）、空会话列表

## 7. 分发与观察

- [ ] 按现有发包渠道推送 0.2.0 内测包，附功能说明（消息升级 + 新增通讯录/日历 + AI 入口移至「我的」）
- [ ] 观察面：
  - App：`adb logcat` 关注 `ImSession` / `ChatVM` / `CalendarVM` 的 warning
  - 服务端：jusi-light-im WS 连接数；we-meet 的 `im/users/resolve`、`calendar-events` QPS（新增调用源）
  - PostHog 默认关闭（key 为空），无新增埋点风险

## 8. 回滚预案

| 对象 | 回滚方式 |
|------|---------|
| Web 前端 | 构建机 checkout 上一提交重新 `build-and-push.sh frontend` + `rollout restart`（或直接 `kubectl rollout undo deploy/meet-frontend`，若旧 ReplicaSet 镜像未被 latest 覆盖则无效，以重建为准） |
| App | 停止分发新包，重发上一版 APK（versionCode 回退需卸载重装，内测阶段可接受） |
| SDK | 与 App 同包交付，无独立回滚面；修复后重新构建 App 即可 |
| 服务端 | 本次无变更，无需回滚 |

## 9. 已知风险

| 风险 | 应对 |
|------|------|
| release 包无签名配置 | 内测先用 debug 签名；正式发布前补 keystore（第 4 节） |
| 构建机缺 `../../jusi-light-im` 同级仓库 | composite build 会直接报错，按第 4 节前置摆放 |
| Web 日历「编辑」不同步参会人 | 设计如此（后端 update 不同步 attendees），需要时后端补 |
| 多提醒只发最大 lead | 后端单哨兵限制，待后端支持后放开 |
| App 无离线推送 | FCM 国内不可用已延期；离线消息靠重连重同步，属已知边界 |
