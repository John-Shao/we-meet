# Android 成果复核交付验收

Android `0.3.0-work.2`（versionCode 4）增加 Pi 复核历史：状态、模型、选定成果、结论、意见、证据文件与 SHA-256、预留及实际 token 用量。复核由桌面显式选择并同步成果后启动；Android 只调用 Work 业务接口，模型供应商配置留在服务端。iOS 不在本批范围。

Android 源码提交：`4313af8a`。SDK composite build 来源 `jusi-light-im` 提交 `f41f52e9ad696f56528b9903f90b0575dc4ded5c`，工作区干净。

## 权限与兼容行为

- 原任务成功后，排队/运行中的复核继续轮询；轮询只在页面生命周期 STARTED 时运行。
- capabilities 没有 `review_enabled` 时跳过旧服务端不支持的接口；false 时保留有权限的历史。
- 文件、报告或访问检查失败后清除缓存的文件、预览与报告，不把请求失败显示成“没有成果”。恢复访问后重新读取，旧预览不自动恢复。
- 仓库绑定登录 session，在 HTTP 前后确认身份。重新登录、换号或退出使迟到响应失效；刷新 access token 不改变 session。SavedState 派发意图也绑定 session。
- 关闭详情后到达的文件/报告响应不重新打开详情。引用文件和哈希必须属于该复核快照；原运行 ID、历史数量、报告长度和用量结构受校验。
- 模型内容用原生 Text 展示，不执行 HTML 或脚本；手机没有新增模型调用、文件修改或命令执行入口。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| Android 全应用 JVM | 553 项通过，0 失败/错误/跳过；其中 Work 9 项 |
| Android Compose + Retrofit | API 29 专用模拟器 2 项通过：原派发/成果页与复核进度/证据/撤权隐藏 |
| PostgreSQL Work 回归 | 86 通过，5 个显式 opt-in 跳过；包含锁定 Pi Docker 与合成 SSE |
| Android 实际后端/Pi 联调 | 3 项通过：fixture flow、实际 Pi flow、实际 Pi → Work API → Android 页面与成果哈希预览 |
| 构建与规范 | 正常 APK、隔离仪器测试 APK、design token 检查及变更 Python Ruff 检查通过 |
| APK 签名 | apksigner 验证通过，Android Debug / v2；不是商店发布签名 |

实际联调使用真实 PostgreSQL、Work API、Gateway 和锁定 Pi Docker 运行时；身份是预置合成业务账号，模型是合成 SSE。Pi 本次返回输入 100 / 输出 30 tokens，后端交付与手机展示一致，没有付费供应商调用。桌面本地成果的设备 report 是 fixture；之前实际 dsh/DeepSeek 执行的跨端证据仍见 [跨端验收](work-cross-device-acceptance-2026-10-07.md)。本次没有重复付费执行，也没有声称完成真实 OTP/OIDC 登录。

截图已查看，模型/用量/意见/引用文本正常换行。凭据、数据库、测试应用及 adb reverse 清理完成；用户原安装 `com.we.meet` 未覆盖。原始证据在 gitignored [本地目录](../../.work-acceptance/work-android-review-20261007/backend.json)，含 `work-review-live/review.png`、`result.png`、`receipt.json` 与仪器测试输出。

## 内部候选

正常包 `../we-meet-android/app/build/outputs/apk/debug/app-debug.apk`：`com.we.meet`，versionCode 4，168677437 字节，SHA-256 `d2ece0fca3f518cc7e253ce800c0d851a695005c6e097ff13cf17bc8a2f67711`。测试完成后恢复正常构建，未安装到用户原 App，未上传商店。

## 复验入口

Android 使用 JDK 17 / SDK 34；隔离仪器测试使用 `.fixturework` 和 `com.we.meet.ui.records.IsolatedRecordsRunner`。实际后端联调先构建指定 `WE_MEET_BASE_URL=http://127.0.0.1:48761` 的隔离 APK/仪器 APK，然后在 backend 既有 Test 设置及独立 PostgreSQL 下设置：

```text
WORK_ANDROID_REVIEW_TEST=1
WORK_AGENT_PI_TEST_IMAGE=we-meet-work-agent:pi-review-schema-poc
WORK_ANDROID_REVIEW_SERIAL=emulator-5556
WORK_ANDROID_REVIEW_OUTPUT=<新的本地验收目录>
```

运行 `python -m pytest work/tests/test_local_review_flow.py work/tests/test_android_review_delivery.py --reuse-db`。后者默认跳过，要求专用模拟器、空闲 48761 端口、没有已安装 `.fixturework` 测试包。它不使用供应商真实 key，Pi broker 返回合成 SSE。最后正常运行 `gradlew :app:testDebugUnitTest :app:assembleDebug`。

本批未部署生产。测试集群部署仍需确认 context/namespace、专用 Docker 节点、镜像仓库和 TLS Secret；Windows 正式发布仍缺证书和产品更新信任根。
