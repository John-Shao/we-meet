# 单账号受控验收入口

该入口只用于已授权的演示账号生产联调。先完成账号核验、候选镜像/运行环境验证以及生产清单审批；不得因脚本存在就再次执行收费任务。操作助手 `deploy/aliyun/work-account-cohort.py` 的 root-only 状态目录不可覆盖重用；再次联调必须准备新的快照、目录和完整 spec 哈希清单。

新清单为每次联调指定唯一的 `--release-id`（例如 `cohort-e92f9eec4-retest-032`），所有阶段必须使用相同值；省略时仍指向历史首轮目录，不得用来准备新一轮。目录只能位于 `/var/lib/we-meet-work-maintenance`，助手拒绝路径穿越、符号链接及已有状态；所有 release 共用原生产操作锁。准备阶段只在新授权后执行，完整快照及真实账号标识仍留在服务器 root-only 目录。

Android 测试需要专用 emulator-5556，不能覆盖日常 App。按现有 Android 配置构建，仅覆盖测试包后缀及 runner（PowerShell 参数必须完整引用）：

```powershell
./gradlew.bat :app:assembleDebug :app:assembleDebugAndroidTest '-PWE_MEET_TEST_ID_SUFFIX=.fixturecohort' '-PWE_MEET_TEST_RUNNER=com.we.meet.ui.records.IsolatedRecordsRunner' --console=plain
```

确认构建 URL 为 `https://meet.we-meet.online`。协调入口 `src/desktop/scripts/account-cohort-coordinator.py` 要求 `WORK_ACCOUNT_COHORT=1`、私有新目录 `WORK_CROSS_DEVICE_OUTPUT`（位于 `.work-acceptance`）及本地 `WE_MEET_LOCAL_KEY_FILE`。手机号和 OTP 交互输入；密钥仍通过本机文件配置，不能放入命令行或脚本。仅初始化专用 fixture 包和 loopback 临时会话桥；`clients-prepared.json` 生成后等待 `start-clients`，此时尚未创建任务或调用模型。

只有生产开放验证通过后才创建 `start-clients`。脚本核验真实账号 UUID 哈希、local/remote 开启、cloud/review 关闭及 20000 token 上限。真实 HTTPS 会话保存在进程和产品加密 profile 中，凭据不写日志。它不是原生登录 UX 验收。Android 从本次桌面返回的 workspace UUID 选择目标，避免领取以前的测试工作区。

桌面入口 `account-cohort-acceptance.cjs` 等待 Android 的请求，经真实界面审阅领取。每条 `pending-approval.json` 中的操作必须独立审查，确认只作用于本轮合成目录后，才能将该条 id/sha256 写入 `approved-fixture-operations.json`。原生对话框夹具只接受该次匹配的参数与审批哈希；不得批量无条件批准。终态会先保存无凭据诊断，随后检查调用次数、完整用量、原始输入和成果。

仅显式选择 `report.md` 后同步，Android 校验预览。成功后停用本次 workspace 别名，验证终态取消幂等，等待生产关闭。关闭并验证全部入口后创建 `production-closed`；脚本检查新派发拒绝、终态重领拒绝，登出并清理本次 profile、fixture 包和 ADB reverse。关闭操作应由已受审的生产清单完成，协调脚本不会自行修改集群。

任何失败均先停止收费任务、关闭生产入口，再按受审快照回退。使用 `abort-client` 只停止本次桌面任务/会话；保留失败回执，不重用 `started.json` 目录，不自动创建替代任务。完成后重新构建普通 debug APK，恢复 `com.we.meet` 输出包名。
