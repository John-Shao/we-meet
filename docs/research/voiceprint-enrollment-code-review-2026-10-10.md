# 声纹登记代码走查与修复

日期：2026-10-10（Asia/Shanghai）。分支：`feature/speaker-identity-voiceprint`。

本轮检查后端授权、加密、保留期、Qwen 客户端，以及未提交的主动登记服务与 Android 人工标记控制器。主动登记目前是内部服务，尚未接通登记 HTTP API、客户端登记界面和执行 worker。

## 已修复的问题

| 问题 | 修复 |
|---|---|
| 非 ASCII 上传令牌触发 `compare_digest` 异常 | 先检查 ASCII 与长度，统一拒绝，不创建样本 |
| 已确认样本的幂等重试绕过当前授权 | 接受结果的重试仍检查权限、generation、档案状态和组织许可版本 |
| 已关闭登记和样本快照显示撤销前的可访问状态 | 所有状态重新检查授权，撤销后不提供令牌、可试听或可确认标志 |
| 试听与撤销、到期存在竞态，未核对音频摘要 | 按用户、组织、授权、档案、样本顺序加锁；解密后核对摘要，再检查授权和到期 |
| 撤销和保留期清理未停止排队或持有租约的任务 | 许可版本变更、删除、到期同步清除任务租约及重试状态 |
| 修改 WAV 元数据可将同一 PCM 当作多份证据 | 严格检查 RIFF 长度、子块边界、唯一格式/数据块及 PCM 参数；规范化后摘要去重并加密保存 |
| 布尔/浮点版本与整数版本相等 | 登记和确认严格拒绝非整数版本 |
| 加锁前记录被删除可触发未处理的异常 | 失效授权、登记和样本统一返回不可用 |
| 登记删除后，失去许可引用的片段仍可访问 | 主动登记样本必须保留登记许可引用 |
| 新增模型缺少迁移 | 补充 `0203_voiceprint_enrollment`，约束槽位、幂等键和最多三次尝试 |
| Android 校验裁剪后的标签，漏过首尾控制字符 | 检查原始输入的控制/格式字符、非法代理码点及行/段分隔符；正常空格仍可裁剪 |

后端最初 19 项测试复现 14 个失败，修复后通过；随后补充并发、级联删除、数据库约束、跨所有者、到期和组织许可版本等回归。Android 非法标签测试补充首尾控制字符后复现一个失败，修复后通过。

## 验证

- 后端登记、授权、加密、Qwen 客户端、人工身份决策、离职、个人热词和用户模型共 232 项相关回归通过。追加试听跨到期保护后，最终登记专项 39 项通过；两次运行有重叠，共验证 233 个不同用例。
- Android 控制器 13 项、真实 Retrofit 身份契约 10 项，共 23 项 JVM 回归通过，编译通过。
- 修改服务和测试的 Ruff 检查及格式检查通过；迁移无漂移。
- 从空测试库应用完整迁移链，登记、加密、试听和幂等验证通过。

测试使用隔离 PostgreSQL、随机测试密钥和合成音频，不涉及真人声音或实名识别效果评测。

```powershell
# 后端：使用已有本地隔离验证环境
& 'D:/workspace/jusi-meet/we-meet/src/backend/.venv/Scripts/python.exe' `
  'D:/workspace/jusi-meet/work/run-speaker-identity-validation.py' `
  core/tests/services/test_voiceprint_enrollment.py -q
```

```powershell
# Android：在 Android feature worktree 执行
$env:JAVA_HOME = 'D:/Program Files/Java/jdk-17'
& "$env:JAVA_HOME/bin/java.exe" -classpath gradle/wrapper/gradle-wrapper.jar `
  org.gradle.wrapper.GradleWrapperMain :app:testDebugUnitTest `
  --tests 'com.we.meet.ui.records.SpeakerIdentityControllerTest' `
  --tests 'com.we.meet.data.MeetingRecordIdentityContractTest' `
  --offline --console=plain
```

## 后续边界

登记内部服务限制每人滚动 24 小时内 3 次登记，每次 6 个槽位；上传许可 10 分钟、待确认片段 24 小时。最小请求回执支持幂等并防止删除后重置配额。令牌由档案密钥派生，不保存明文令牌。片段为 24 kHz、单声道、PCM16 WAV，3–10 秒。输入只做结构检查，随机数字提示语不构成已验证的活体检测。

Qwen 当前只返回信号质量，语音和单人一致性标志均为 `False`；样本保持 `quality_pending`，不能确认或激活模板。内部确认仅记录本人决定，不自动开启积累和识别。

任务租约字段和尝试次数约束已存在，但执行 worker、硬期限与进程回收未完成。慢速 HTTP 响应头和卡住的原生推理仍需执行层兜底，任务模型不代表已验证的资源隔离。登记 API、语音/单人质量、模板和实名匹配、通话采样、跨端登记及部署继续按[完整开发记录](../plan/speaker-identity-implementation-2026-10-10.md)推进。
