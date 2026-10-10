# AI 录音 Android 接入与代码走查

日期：2026-10-10（Asia/Shanghai）。Android 提交：`366df582d253c62801455bb2fc5ff948f2dfc943`；分支：`feature/speaker-identity-voiceprint`。

Android 录音详情已接通明确费用确认后的分人请求、加密持久意图／原请求恢复、关闭创建后的取消、ASR 与派生版本共同固定的原文分页、录音身份候选与人工确认，以及连续区间试听。版本更新清除旧候选和游标；编辑保留原阅读版本和草稿，并禁止新分人请求。试听最多 10 秒，原生输出的 WAV 实际裁到区间末端，不预取下一说话人的分片。

本轮代码走查修复六类问题：Compose 分组提前返回导致崩溃、身份状态在网络回调线程恢复导致界面持续加载、试听总期限被当成外部取消、取消请求失权后残留私有历史、后续存储失败误报，以及旧派生草稿借用新记录 revision 保存。另修正了取消状态测试的完整文本匹配。模型路线仍为 Qwen 优先，没有切换 CAM++。

## 验证与复现

- 120 项 JVM 回归全部通过，覆盖分人契约／控制器、ASR／录音播放／记录仓库、原生播放边界和身份契约／控制器。
- 35 项 API 29 隔离模拟器回归全部通过，覆盖费用确认、真实加密意图恢复、原 nonce／revision、创建关闭后的取消、登录切换、候选／建议确认、合成静音的原生 AudioTrack 跨分块试听、新版本分页、编辑保留和旧版本保存冲突。
- Debug 和 AndroidTest APK 构建、设计规范检查、五种语言各 21 个资源键及占位符一致性、XML 与 Git 差异检查通过。中文暗色 1.5 倍字号截图已检查，费用确认与操作无横向裁切。
- 首轮 34 项中 9 项失败，修复分组／测试断言后 34 项通过；追加草稿用例后的第一次 35 项有一项目录加载失败，单独复现后固定状态收集线程，最终 35 项全通过。新增异常 JVM 用例先复现 3 项失败再完成修复。各轮测试不直接相加。

实现、问题细节、Gradle 复现参数及日志路径见[Android 完整走查记录](https://github.com/John-Shao/we-meet-android/blob/366df582d253c62801455bb2fc5ff948f2dfc943/docs/voiceprint-capture-diarization-review-2026-10-10.md)。最终日志为 `work/android-capture-diarization-review-final-build-2026-10-10.log`、`work/android-capture-diarization-review-main-thread-build-2026-10-10.log` 和 `work/android-capture-diarization-review-verified-ui-2026-10-10.log`。

测试使用裸 Application、独立包 `com.we.meet.fixturespeakeridentity`、本地拦截响应与合成 WAV；录音权限撤销并由 appops 禁止。没有真人声音采集、收费 ASR、生产接口访问或部署。主要交互组件、仓库和控制器已验证；完整产品 Application 与真实设备回归仍需后续验证。

## 完整方案的剩余范围

可信通话采样／暂停／共享设备排除、实际设备分组、部署调度／清理／可信恢复演练，以及获授权真人多人／跨设备效果、生产容量与上线验收仍待完成。本轮结果证明技术链路及交互边界，不代表真人识别准确率达标或完整方案已交付。
