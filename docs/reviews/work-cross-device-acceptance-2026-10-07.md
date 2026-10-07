# Android 与桌面联合验收

2026-10-07。接续 [交付阶段](work-delivery-and-android-2026-10-07.md)，本轮将两端真实 Work 界面、HTTP API、PostgreSQL 与最终内置 Agent 连成同一次任务。机器回执见 [JSON](work-cross-device-acceptance-2026-10-07.json)。未部署生产，未开发 iOS。

## 联合链路通过

Android `WorkScreen → WorkViewModel → WorkRepository → ApiClient.workApi` 使用真实 Retrofit/HTTP 访问隔离 Django API；Electron 使用实际打包 renderer 与主进程协调器，内置 Agent `0.3.1`、dsh `0.1.5rc1` 和真实 `deepseek-flash` 执行。任务 UUID `b6d2dcbb-dea0-4990-9a07-8f3be72265ec`、工作空间 UUID `691774b9-4819-4721-b663-3f84d02b941d` 在两端一致。

1. 桌面授权中文路径目录、配置本机密钥，发布工作空间；手机实际联网读取别名与在线状态。
2. 手机填写目标并派发，桌面待办出现；领取前本机任务列表为空，证明轮询不触发执行。
3. 桌面通过“审阅并领取”启动原 UUID；四次工具调用停在审批前，分别审阅具体命令、目录和 SHA-256 后批准。读取/复制只涉及临时测试目录及本次 `output/report.md`。
4. DeepSeek 共 5 次调用，输入 1196、缓存读取 5504、输出 1173 tokens；包含审阅等待的整轮测试约 206 秒。原始 `input.txt` 未变。
5. 桌面成功后云端文件列表仍为空；选中 `report.md` 主动同步后，Android 校验 SHA-256 并展示 `cross-device-marker-20261007`。正文未混入状态回报，设备用量不写供应商计费账本。
6. 手机另发一条待办并从详情取消，服务端原 run 进入 `canceled`，未由桌面自动领取。

证据：[联合回执](../../.work-acceptance/work-cross-device-20261007/receipt.json)、[Android 成果截图](../../.work-acceptance/work-cross-device-20261007/android-result.png)、[桌面成果截图](../../.work-acceptance/work-cross-device-20261007/desktop-result.png)。两张截图已视觉检查。Android 使用 API 29 模拟器、独立 `com.we.meet.fixturework`；测试后卸载 fixture APK，并移除仅本轮创建的 adb reverse 端口。

身份由测试桥识别专用 bearer，再将合成账号交给真实 Work 权限与 ORM；桌面与 Android 使用预置测试会话。**这是两端界面与实际业务执行的联合验收，尚未包含真实 OTP/OIDC 登录或真实用户账号。**原生目录/密钥选择和确认弹窗由测试程序控制，不作为真人选择器 UX 验收。模型工具审批逐项核对后才加入允许列表，不自动批准模型输出。

## Windows 安装与运行环境

为避免替换既有客户端，使用相同当前产品代码，构建独立 `online.we-meet.desktop.workacceptance` / `We-Meet Work Acceptance` 安装包；移除登录协议注册和快捷方式。它是内部验收衍生包，不是原始正式产品安装包。

| 检查 | 结果 |
| --- | --- |
| NSIS 一键静默安装 | 退出码 0，实际安装目录中的 `app.asar` 启动成功 |
| 安装后自包含 Agent | 限制 PATH 排除系统 Python/Node，内置 SDK ready 与中文目录授权通过 |
| NSIS 升级 | `0.4.0-delivery.1 → .2` 退出码 0，实际安装 App 显示新版本，隔离用户状态保留 |
| NSIS 回退 | `.2 → .1` 退出码 0，实际安装 App 启动与状态保留通过 |
| 卸载 | 退出码 0，程序已移除，隔离用户状态按配置保留 |
| 独立 Agent 签名切换 | 对完整已安装 payload 使用内存中临时 Ed25519 fixture 签名，原生探测通过后切换 |
| 篡改与回退 | 修改清单覆盖文件后拒绝启动，重新校验并原生探测上一版本后回退成功 |

NSIS `.2` 仅改变版本元数据，代码与 `.1` 相同；用于验证安装流程及状态保留。Agent 测试版本 `0.3.2-test.1` 同样复用 `0.3.1` 二进制，只改变签名清单版本，测试密钥不进入产品信任根。未测试干净 Windows VM、下载后的 SmartScreen 行为或正式 Authenticode 签名。启动只访问公开配置，不登录生产账号。

本机未找到 DisplayName 精确为 `We-Meet` 的既有卸载项，所以不声称完成其前后快照对比；隔离依靠不同 appId/名称/目录及不注册原协议。用户态测试配置保留在独立 profile 中供检查。

## 复验与交付

新增验收入口：后端 `work/tests/test_cross_device_live.py`、桌面 `scripts/cross-device-acceptance.cjs`、Android `WorkRemoteIntegrationTest.kt`。仅显式 `WORK_CROSS_DEVICE_LIVE=1` 才运行付费联合测试；默认跳过。相关本地/远程后端复验 11 项通过、1 项 opt-in 跳过；Ruff 与脚本语法通过。既有错误场景（审批拒绝、断线、重复回报、重启不重放等）保留原阶段契约测试，不把它们写成本轮新增的真实界面故障注入。

Android 联合测试构建参数：

```powershell
./gradlew.bat :app:assembleDebug :app:assembleDebugAndroidTest '-PWE_MEET_TEST_ID_SUFFIX=.fixturework' '-PWE_MEET_TEST_RUNNER=com.we.meet.ui.records.IsolatedRecordsRunner' '-PWE_MEET_BASE_URL=http://127.0.0.1:48761'
```

使用专用模拟器 `emulator-5556`；后端设置项目 Test 配置、隔离 PostgreSQL，提供 `WORK_COORDINATION_LIVE_KEY_FILE` 的本机文件路径，并将 `WORK_CROSS_DEVICE_OUTPUT` 指向新的验收目录。后端 pytest 自动迁移测试数据库至 `work.0005`，开关仅在测试进程启用，监听 loopback。测试运行时逐项检查 `pending-approval.json`，只将确认过的审批 ID / SHA-256 写入 `approved-fixture-operations.json`。

测试完已重新正常构建 Android `com.we.meet` / `0.3.0-work.1`，不携带 fixture 安装 ID 或本机测试服务地址。正常 APK SHA-256：`a2d7b2ba0d637d6d0f90b71ce0063b1bf34c344171d856bbff4a4d8bbe5c5c73`。原 Windows 内部候选仍为 `0.4.0-delivery.1`，哈希未变：`a6aa971ab93dedb215843000b46a881801e2d2a98bd59c6d4bf815626caa36a0`。

下一待验项是专用测试服务/账号的真实登录、真实安装包的人工文件选择及干净 Windows 环境。测试服务地址与专用账号尚未收到；Windows 正式证书和产品运行时更新信任根仍未配置，生产发布仍关闭。
