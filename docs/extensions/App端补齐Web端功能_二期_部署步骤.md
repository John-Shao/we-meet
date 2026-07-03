# App 端补齐 Web 端功能 二期 — 部署步骤（0.2.0 全栈发布）

> 配套文档：[App端补齐Web端功能_二期_IM通讯录日历.md](App端补齐Web端功能_二期_IM通讯录日历.md)（设计）、
> [../installation/aliyun-release-runbook-cn.md](../installation/aliyun-release-runbook-cn.md)（日常发布 Runbook）
> 用法：逐项打勾，带命令的可直接复制执行。
> ⚠️ 本次与最初版本不同：**含后端代码 + 一个迁移**，是全栈发布，且**后端必须先于 App 分发上线**。

## 0. 本次变更范围（三个仓库）

| 仓库 | 分支 / 提交 | 变更内容 | 部署动作 |
|------|------------|---------|---------|
| `we-meet` | `aliyun-dev` @ `21b64040` | **后端**：审批 urge/delegate（迁移 `0048_approvaldelegation`）、日历日期范围过滤 + **组织者对象权限** + 改期同步 Room；**前端**：审批列表分页、日历事件编辑/删除、日历按日期窗口拉取 | 后端镜像 build + rollout + **migrate**；前端镜像 build + rollout |
| `we-meet-android` | `main` @ `1b25fd1` | App：IM 一期 + **二期**（富消息接收渲染 / 长按菜单 / 语音 / @提及 / 转发·合并转发）+ 通讯录 + 日历（含**编辑·删除**）+ **审批模块** + 5 Tab；版本 **0.2.0**（versionCode 2） | 构建 APK + 分发 |
| `jusi-light-im` | `main` @ `32dac0e` | Android SDK（对齐 web alpha.7）；已在 `origin/main`，服务端零变更 | **无需操作** |

关键依赖链：
- App **日历编辑/删除** 的授权依赖后端 `组织者对象权限`（`678daebf`）。
- App **审批模块** 依赖 approval 端点（base 端点早已在线；本次 `0048` 委托表为增量，App 不直接调用 delegate/urge）。
- ⇒ **必须先完成 Step 2 后端上线，再做 Step 4 App 构建/分发。**

## 1. 服务端依赖核对（只查不改，约 5 分钟）

用 demo 手机号 13800000000–009 取 `<access_token>`：

- [ ] jusi-light-im ≥ P13（群成员/已读/会话设置）——Web 端已读回执、置顶免打扰在线即已就位。
- [ ] we-meet 桥接与业务端点返回 200：

  ```bash
  TOK=<access_token>
  curl -s -X POST -H "Authorization: Bearer $TOK" https://meet.we-meet.online/api/v1.0/im/token/
  curl -s -H "Authorization: Bearer $TOK" "https://meet.we-meet.online/api/v1.0/directory/members/?page_size=1"
  curl -s -H "Authorization: Bearer $TOK" "https://meet.we-meet.online/api/v1.0/calendar-events/?page_size=1"
  ```

## 2. 代码推送（先后无强依赖，建议先推 we-meet）

```bash
cd d:/workspace/we-meet/we-meet          && git push origin aliyun-dev
cd d:/workspace/we-meet/we-meet-android  && git push origin main
# jusi-light-im 已在 origin/main，跳过
```

## 3. 后端发布（**含迁移，必须先于 App 分发**）

按日常 Runbook「后端有新迁移」路径：build backend → rollout backend → migrate。

- [ ] 阶段 A — 构建机（WSL）build + push：

  ```bash
  cd /mnt/d/workspace/we-meet/we-meet && git pull origin aliyun-dev
  bash deploy/aliyun/build-and-push.sh backend
  ```

- [ ] 阶段 B — 生产 ECS（aliyun-sjy）rollout：

  ```bash
  cd /opt/we-meet && git pull origin aliyun-dev
  kubectl -n meet rollout restart deploy/meet-backend
  kubectl -n meet rollout status  deploy/meet-backend --timeout=120s
  ```

- [ ] 阶段 C — 迁移（latest 镜像不触发 migrate hook，手动执行）：

  ```bash
  kubectl -n meet exec deploy/meet-backend -- python manage.py migrate --no-input
  kubectl -n meet exec deploy/meet-backend -- python manage.py showmigrations core | tail -5
  # 期望看到 [X] 0048_approvaldelegation
  ```

- [ ] 端点冒烟：

  ```bash
  curl -s -H "Authorization: Bearer $TOK" "https://meet.we-meet.online/api/v1.0/approval-templates/?page_size=1"
  curl -s -H "Authorization: Bearer $TOK" "https://meet.we-meet.online/api/v1.0/approvals/?role=pending"
  ```

## 4. 前端发布（仅 rollout，无迁移）

- [ ] 构建 + rollout：

  ```bash
  cd /mnt/d/workspace/we-meet/we-meet && bash deploy/aliyun/build-and-push.sh frontend
  cd /opt/we-meet
  kubectl -n meet rollout restart deploy/meet-frontend
  kubectl -n meet rollout status  deploy/meet-frontend --timeout=120s
  ```

- [ ] 页面验证：审批列表「加载更多」；日历日程「编辑/删除」；日历翻月按窗口拉取（不再一次拉全量）。

## 5. Android APK 构建（0.2.0）

- [ ] **构建机前置**：JDK 17；`jusi-light-im` 在同级 `D:\workspace\we-meet\jusi-light-im` 且在 `main`
  （composite build 从源码编译 SDK）。
- [ ] **版本号**：已是 `versionCode 2` / `versionName 0.2.0`，无需再改。
- [ ] **确认生产配置**：`gradle.properties` 默认生产三件套（`meet` / `id` / `im.we-meet.online`）；
  确认构建机 `local.properties` 无本地覆盖残留。
- [ ] **构建**（二选一）：
  - 内测（debug 签名，可直接装机）：

    ```bash
    ./gradlew :app:assembleDebug   # 产物 app/build/outputs/apk/debug/app-debug.apk
    ```

  - 正式包：⚠️ release buildType **未配置签名**，需先生成 keystore 并在 `local.properties` 配
    `RELEASE_STORE_FILE/STORE_PASSWORD/KEY_ALIAS/KEY_PASSWORD`、`build.gradle.kts` release 块加
    `signingConfig`，再 `./gradlew :app:assembleRelease`。

## 6. 单机冒烟（1 台真机 + Web 对端，约 25 分钟）

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

回归（快速扫）：OTP 登录 → 5 Tab（消息·日历·会议·通讯录·我的）→ 建会/入会/音视频 → 通讯录下钻 → 个人资料。

**本轮新增重点（务必逐项）**：

- [ ] **IM 二期·接收**：Web 往群里各发一条 → App 正确显示：语音（点击播放）、引用回复、撤回（墓碑）、表情回应（emoji×n）、合并转发（卡片→点开看全文）
- [ ] **IM 二期·发送**：长按消息 → 复制/引用/撤回/表情；按住麦克风录音、松手发送（首次弹 RECORD_AUDIO 权限）；输入 `@` 弹成员下拉、群里被 @我 的会话列表出红「@」；多选 → 合并转发到目标会话
- [ ] **日历编辑/删除**：自己组织的日程详情出现「编辑/删除」；编辑标题保存生效；删除确认后消失；非组织者看不到
- [ ] **审批（新模块）**：我的 → 审批 → 两 Tab（待我审批带角标 / 我发起）；发起（选模板 → 填动态表单 → 提交）；待办「通过/拒绝」+ 意见；我发起「撤销」；`needs_assignment` 显示引导文案；「加载更多」翻页
- [ ] Web ↔ App 双向：App 发的引用/撤回/表情/语音/@，Web 端正确显示（wire 对齐）

任一崩溃/错位 → 记 logcat（`ChatVM` / `ApprovalVM` / `CalendarVM` / `ContactsVM`），不放行。

## 7. 深度验收（双人双机，可与灰度并行）

- [ ] 断网 30 秒恢复 → 状态条「重连中→已连接」，断档消息重同步（重点）
- [ ] 群生命周期：踢人/转让/群主退群自动转让/末人解散
- [ ] 撤回仅自己 2 分钟内消息；表情回应聚合正确（多人同 emoji 计数）
- [ ] 审批完整链路：A 发起 → B（当前审批人）待办可见 → 通过/拒绝 → A 侧状态更新
- [ ] 头像/聊天图片闲置 1 小时后仍能渲染（presign 过期 vs Coil 稳定缓存 key）
- [ ] 空态不崩：空部门组织、无日程日、无模板时发起页、空会话列表

## 8. 分发与观察

- [ ] 推 0.2.0 内测包，功能说明：IM 升级（语音/引用/撤回/表情/@/转发）+ 日历编辑删除 + 新增审批模块
- [ ] 观察面：
  - App：`adb logcat` 关注 `ImSession` / `ChatVM` / `ApprovalVM` / `CalendarVM` 的 warning
  - 服务端：jusi WS 连接数；we-meet 的 `im/users/resolve`、`calendar-events`、`approvals` QPS（新增调用源）
  - PostHog 默认关闭（key 空），无新增埋点风险

## 9. 回滚预案

| 对象 | 回滚方式 |
|------|---------|
| 后端 | `kubectl -n meet rollout undo deploy/meet-backend`。迁移 `0048_approvaldelegation` 是**新增表**，旧代码忽略它，向后兼容，**无需回滚迁移** |
| 前端 | `kubectl -n meet rollout undo deploy/meet-frontend`（或重建上一提交镜像 + rollout） |
| App | 停止分发新包，重发上一版 APK（versionCode 回退需卸载重装，内测阶段可接受） |
| jusi-light-im | 本次无变更，无需回滚 |

## 10. 已知风险

| 风险 | 应对 |
|------|------|
| 后端未先上线就分发 App | 日历编辑/删除授权、审批可能异常 → **严格按 Step 3 → 5 顺序** |
| 迁移 `0048` 漏跑 | 审批委托相关报 relation 不存在 → Step 3 阶段 C 的 `showmigrations` 必须确认 `[X]` |
| release 包无签名配置 | 内测先用 debug 签名；正式发布前补 keystore（第 5 节） |
| 构建机缺 `../jusi-light-im` 同级仓库 | composite build 直接报错，按第 5 节前置摆放 |
| 审批 UI 真机渲染未验 | 开发环境模拟器 screencap 全黑（GPU 问题，App 实际运行正常/无崩溃）；审批界面渲染以真机冒烟为准 |
| 语音录制链路 | 模拟器常无麦克风，录音发送以真机为准 |
| Web 日历「编辑」不同步参会人 | 设计如此（后端 update 不同步 attendees），App 编辑模式同样隐藏参会人选择 |
| App 无离线推送 | FCM 国内不可用已延期；离线消息靠重连重同步，属已知边界 |
