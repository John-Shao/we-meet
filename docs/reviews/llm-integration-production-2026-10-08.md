# 大模型接入改进生产发布记录

日期：2026-10-08，环境：阿里云生产 `meet` namespace。后端已发布并完成真实请求验证；Android 新版内部验证 APK 已归档，安装后才能获得固定方向和客户端租约行为。

## 发布版本与范围

- 后端源码：`ffb1c5890cbdb42813869cac1d6acbca595d1b5a`，镜像 `meet-backend:ffb1c5890`。
- 实际运行镜像 SHA-256：`b54439fd58a0e6399e3d2c75201141c9c9ee64b7ce8b6a76eec21a02a54d82c6`，已逐个核对五个 Deployment 的 Pod imageID。
- [Release Guard 37735383200](https://github.com/John-Shao/we-meet/actions/runs/37735383200) 对同一提交通过；使用现有 `deploy/aliyun/release-meet.sh`，保留 CI、镜像存在性和 Work 配置检查。
- Helm revision `459` 为 `deployed`；新增迁移 `0197_directaiallocation` 已应用。
- 更新七个消费者：`meet-backend`、`meet-backend-ai`、`meet-celery-backend`、`meet-celery-beat`、`meet-celery-work`，以及 `meet-backend-docs-profiles`、`meet-backend-reminders` 两个 CronJob。五个 Deployment 均就绪，两种定时任务均有成功执行。
- `DIRECT_AI_MAX_ACTIVE_ALLOCATIONS=0`、`DIRECT_AI_MAX_DAILY_ALLOCATIONS=0`，保持观测模式。

其余十五个消费者的镜像及配置语义与发布前一致。四个 Summary／转写消费者因 Helm 重新排序环境变量发生一次滚动重建，已恢复就绪；环境值和镜像未改变。未将“配置一致”表述为“没有任何重启”。七个消费者的 Work 灰度配置检查通过；独立 Work Gateway 保持原 `3d97bb6c…` 镜像并就绪，未重新发布 Pi／Broker 或扩大账号范围。

生产原 `/root/we-meet` 带有历史手动修改。本次通过 Git bundle 建立独立、干净的发布 worktree，并核对提交，不重置该目录。仅修正下文的生产配置管理项。发布前保留了实际工作负载、Helm values／manifest 和近期成功备份记录。

## 真实验证

| 验证 | 结果与边界 |
| --- | --- |
| 业务、AI 后端存活与就绪 | 两个 Pod 的 `/__heartbeat__`、`/__lbheartbeat__` 均返回 200；使用实际 Pod IP，避免错误 Host。公网鉴权接口另行验证。公网同名根路径实际返回前端页面，不算后端健康证据 |
| 固定方向 AOQ 互译 | Android `AoqBilingualLiveTest#fixedDirectionUsesOneRealSessionAndKeepsPlaybackAndFinish` 通过，18.349 秒；真实英→中单连接、原文／译文、译音回放和正常结束；不申请反向翻译或 Omni 语言识别 |
| Omni AOQ 分配与租约 | 正常演示账号通过公网接口申请，响应禁止缓存；心跳为 active，关闭为 closed，迟到心跳 410，未知租约 404，无登录态 401。仅验证控制面，没有在此探针发送 Omni 音视频 |
| 个人录音直连 ASR | `CaptureDirectAsrLiveTest#directPauseResumePublishesFormalTextAndKeepsAudioArchive` 通过；真实 ASR 3.1，暂停／续录两条任务，上传原音频分段，检查完整时长、无缺口、续录时间偏移、正式文字发布及任务 succeeded。仅将本次测试实录移入回收站 |
| 演示账号任务流程 | 既有 `TaskBackendE2eTest#createCompleteRestoreAndDeleteTask` 同次通过；创建、完成、恢复、删除仅针对新建测试任务。与 ASR 合计两项通过，55.345 秒 |
| Embedding | 真实 `text-embedding-v4` 请求包含两条合成文本；返回两条 1024 维向量，全部数值有限，不修改既有向量索引 |
| 失联回收 | 另申请一个真实 ASR 临时凭证，只上报一次心跳，不连接模型。timer 在 `06:38:13Z` 将其回收为 expired；随后正常公网 heartbeat 返回 410，未复活 |

验证后的申请元数据为：互译 closed 1、Omni closed 1、ASR closed 2／expired 1；五条均有心跳及结束时间。此计数是本轮应用申请记录，不是供应商权威用量、并发或账单。新客户端实测覆盖观测模式；未在生产开启限额或进行付费高并发压测。

模拟器以 ARM 进程运行 AOQ 原生库。ASR 单独启动探针两次遇到进程 DNS 解析失败，均在登录请求前失败，未创建 ASR 任务；随后先运行仓库既有绑定活动网络的 Task 测试，再在同一 instrumentation 进程执行 ASR，完整通过。失联探针首次最终心跳因本机代理连接超时失败，使用直连 HTTPS 重试同一已过期租约，无新增分配。

## 发布阻塞及处理

首次 Helm revision `458` 失败，未更新七个目标消费者；迁移最终成功。修复后重试得到 revision `459`：

1. `meeting_ai_credentials.yaml` 的 pre-upgrade hook 重建共享 Secret 时遗漏外部追加的 `DASHSCOPE_ASR_CLIENT_API_KEY`，导致迁移 Pod 配置错误。由仍在运行的旧实例恢复原专用 Key，全程不输出凭证。生产将 `meetingAIWorkers.credentialsFromExistingEnv` 设为 `false`，改用保留完整字段的既有 `meet-ai-credentials`，后续不再由该 hook 重建。
2. 原 `VOLC_SMS_ACCOUNT` 字符串在 YAML 往返处理中被 Kubernetes 解释为数字，七个资源的 patch 被拒绝。将其原值准确保存在外部管理的 `meet-sms-account` Secret，通过 `secretKeyRef` 注入；比对解码后与发布前完全一致。没有改变短信账号。
3. 重试前检查所有目标消费者的 Secret 引用，并使用 `kubectl replace --dry-run=server` 验证完整资源 schema，再执行既有发布流程。

两项生产配置调整和原配置备份保存在操作目录，未将密钥写入仓库。临时 GitHub 认证文件已删除。原发布脚本后的首次本地健康请求因使用未允许的 `127.0.0.1` Host 返回 400，已按实际 Pod IP 重新检查两个后端，四项均为 200；Helm 发布状态本身为 deployed。

## 持续回收与后续发布

生产宿主机已安装并启用 `meet-direct-ai-expiry.timer`／`.service`，每分钟执行：

```sh
kubectl -n meet exec deployment/meet-backend -- python manage.py expire_direct_ai_allocations
```

该命令只回收过期的应用声明并输出按模型／传输／状态的聚合，不调用模型或关闭供应商连接。service 已实测 `Result=success`、`ExecMainStatus=0`，journal 记录一次 `expired=1`。单条租约 TTL 为 120 秒，实际回收还包含 timer 调度间隔。

后续生产发布先加载已核对的持久化配置 profile，避免重新采用过时的模型、短信或 Secret 配置，再按现有 runbook 执行对应模块发布和 CI 检查：

```sh
source /root/.config/we-meet/release-llm-production.env
```

该文件引用 `/home/johnshao/llm-integration-ffb1c5890/` 内的私有 `release-values.yaml`、`release-secrets.yaml` 和按实际七个消费者导出的 `values.work-cohort.yaml`。目录权限 700，凭证及配置文件权限 600；不要将这些文件复制到公开产物或删除后再引用。

## Android 交付与回退

Android 源码 `353e404af859aae4b65044cdd2fc4613a3fa831b`，版本名 `0.3.0-work.2`／versionCode `4`。使用仓库 `scripts/package-work-candidate.py` 归档到工作区 `we-meet-android/release/0.3.0-work.2-353e404af859/app-debug.apk`，SHA-256 为 `8311002cf48b2ecdd6ace091d207ce75b081e545bb54dd86776a06b76cd704e3`。该包为 Android Debug 内部测试签名，未声称应用商店或正式发布签名已交付。完整候选回归见[接入改进验收](llm-integration-improvements-2026-10-08.md)。

旧 APK 可继续调用新增可选响应字段的后端，未报告心跳的记录会过期，观测模式不会中断模型音频。固定方向和客户端心跳需安装新版 APK。

回退前停止新增业务工作并检查正在执行的任务；停止／禁用 expiry timer，保留两个限额为 0。依据操作目录的 `before-private.json`，带当前 UID／resourceVersion 检查恢复七个目标消费者的发布前完整 spec，并等待滚动完成。原镜像 digest 为 `e80b10e82eebea449076901453cf0669838fbd33aaae5afd176f6ab44b948e61`。保留新增数据库表和外部 Secret，不执行删表回退。不要直接回滚旧 Helm revision `457`：其 manifest 不含后来手动修正的完整生产配置。Android 可回退对应旧包；固定方向也可在会话开始前手动恢复自动模式。

本地脱敏发布证据在工作区 `artifacts/llm-improvements/production-*.json` 和测试日志中；私有 Helm／资源日志仅留在服务器操作目录。
