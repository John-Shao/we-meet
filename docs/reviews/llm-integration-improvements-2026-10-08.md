# 大模型接入改进验收

日期：2026-10-08。本轮为未生产部署的候选改动，基于后端 `eb2f82f5b`、Android `4dd01188`。接入方案见 [llm-integration.md](../features/llm-integration.md)。

## 改动与结果

| 改进 | 候选行为 | 验证 |
| --- | --- | --- |
| 翻译模型兼容 | Android 会议／录音翻译接受 3.8 和历史 3.5 配置，拒绝未知模型 | 两个 Repository 的兼容测试通过；不将独立双语互译验收等同于完整会议／录音链路验收 |
| Embedding 批处理 | 每请求最多 10 条，按响应 index 恢复顺序；校验 1024 维及有限数值；每批收费请求前验证来源快照 | 23 条分为 10／10／3；乱序、重复／缺失／越界索引、无效向量、来源变化及旧索引保留测试通过 |
| AOQ 分配 HTTP 复用 | Omni 和互译分配接入现有 `provider_http` Session；WebRTC 控制请求也使用同一入口 | 接口和 HTTP 池生命周期回归通过，保留逐请求鉴权、有界读取、禁止重定向及不自动重试 |
| 固定方向翻译 | 设置中新增两个固定方向，仅申请、连接一个翻译模型；自动双向仍为三个模型连接 | 偏好／设置／生命周期测试及一次真实固定方向 AOQ 验证通过 |
| 直连申请观测与准入 | 新增按账号隔离的申请记录、心跳、关闭及失联回收；活动／日申请限额可配置，默认 0 | 真实 PostgreSQL 的两个并发工作线程未突破同账号限制；权限、失败回收、期限和客户端停止行为测试通过 |

Filetrans、文本 OpenAI SDK、Work/Pi Broker 的既有复用层继续使用，未仅为池化替换 DashScope SDK。云端实时 WebSocket 保留原生命周期。个人录音翻译的完整直连迁移仍需补齐文字同步、恢复和归档发布契约，本轮只修复其模型兼容。

## 自动验证

- 后端：117 项通过，143.51 秒；涵盖 Omni／互译／ASR 分配、申请准入、Embedding 来源一致性及 HTTP 连接复用。测试使用本机 PostgreSQL 16，模型 HTTP 响应使用桩。完成工具会话为 `40718`、退出码 0；原完整日志随后被管理命令覆盖，验收记录保留完成结果，不将该日志作为完整逐项报告。
- Android：`app` 561 项、`feature-assistant` 30 项单元测试全部通过，无失败或跳过。包括可选 DTO 兼容、三个 Retrofit 生命周期接口实际发送请求、心跳失败策略、批次及方向规划。
- 模拟器：初轮 47 项中 46 项通过，1 项真实 ASR 测试因未开启付费探针而跳过；最终 ASR 控制器 9 项全部通过，其中 2 项新增租约建连拒绝与纯观测故障测试。合计 48 项独立设备回归通过，重复执行的 7 项不重复计数。
- Debug APK、Android 测试 APK、未签名 Release APK 构建，以及 `checkDesignTokens` 均通过。涉及的后端模块 Ruff、两仓库 `git diff --check`、`makemigrations --check --dry-run` 通过，无额外迁移漂移。

后端验证命令（测试配置使用本机隔离数据库及 LocMemCache，不依赖生产 Redis）：

```sh
pytest --reuse-db --no-cov core/tests/test_ai_call.py core/tests/test_assistant_translation_direct.py core/tests/test_assistant_transcription.py core/tests/test_direct_ai_allocations.py core/tests/services/test_embeddings.py core/tests/services/test_embedding_consistency.py core/tests/services/test_embed_task.py core/tests/services/test_provider_http.py core/tests/services/test_capture_direct_asr.py
python manage.py makemigrations --check --dry-run
```

Android 验证命令：

```sh
gradlew :app:testDebugUnitTest :feature-assistant:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest :app:assembleRelease checkDesignTokens
```

## 真实 AOQ 固定方向验证

在 `emulator-5554` 以 ARM 进程执行 `AoqBilingualLiveTest#fixedDirectionUsesOneRealSessionAndKeepsPlaybackAndFinish`，通过已有登录态调用当前生产签发接口，输入测试仓库的合成英文 PCM。成功探针耗时 17.316 秒，断言只申请一个 `qwen3.8-livetranslate-flash-realtime` 英文→中文会话，并验证最终原文、译文、译音回放、结束后 IDLE；不申请反向翻译或 Omni 语言识别。

首次 x86 进程探针已获取一个分配结果，但 AOQ 原生库加载失败，未发送音频。确认原因后使用 `adb install --abi arm64-v8a -r` 安装再验证；成功探针另申请一个会话。两次合计两个分配，未伪造供应商费用或声称失败分配不计费。当前生产接口尚不返回新 `session_lease`，因此该探针验证的是固定方向真实媒体链路及旧后端兼容；新租约协议由后端、Retrofit、客户端单元和 ASR 设备测试覆盖。

固定方向的“一条连接”不等于费用降至三分之一；真实网络延迟、供应商用量和多设备容量未在本轮压测。ARM 原生库边界继续保留。

## 新版 APK

本机验证包：`artifacts/llm-improvements/we-meet-llm-improvements-debug.apk`（工作区根目录，测试签名）。版本名 `0.3.0-work.2`，versionCode `4`，SHA-256：

```text
8311002cf48b2ecdd6ace091d207ce75b081e545bb54dd86776a06b76cd704e3
```

`verification.json` 保存在相同目录，记录测试计数、APK 与两仓库候选文件哈希；设置截图为 `bilingual-direction-settings.png`。这些是本机产物，不作为源码提交。正式分发仍使用项目发布签名。

## 发布及回退

1. 发布后端候选镜像并执行新增迁移 `0197_directaiallocation`；先保持 `DIRECT_AI_MAX_ACTIVE_ALLOCATIONS=0`、`DIRECT_AI_MAX_DAILY_ALLOCATIONS=0`。
2. 分发新版 Android，核对申请→心跳→关闭记录、失联回收及正常直连音频。新版兼容缺少租约字段的旧后端；旧客户端也兼容新后端的额外响应字段，但不会报告心跳。
3. 按部署调度周期执行 `python manage.py expire_direct_ai_allocations` 回收过期声明并查看按模型／传输／状态的聚合。状态、申请次数不等同于真实上游连接数或账单。
4. 客户端升级情况与业务额度明确后，才启用申请限额。自动双向互译占三个申请，固定方向或单条 ASR 任务占一个；日限额按 UTC 日期计算，包含失败申请。临时 ASR Key 可建立多个任务，应用租约不能充当供应商硬限流。

开启活动限额时，客户端在租约被拒绝或连续三次心跳失败后关闭当前连接，避免迟到回调影响后续新会话；纯观测故障仅结束观测，继续正常音频，并等待服务端声明过期。最长声明期限 12 小时；服务端过期不会直接撤销供应商连接。

回退时将两个限额设为 0，并回退对应 APK／后端镜像；新增表可保留，避免删除观测数据。固定方向可在会话开始前手动改回自动双向。不会自动改用另一个收费接入方式，也不会自动重放音频。
