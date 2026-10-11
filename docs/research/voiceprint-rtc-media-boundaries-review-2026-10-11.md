# RTC 媒体边界与空派发恢复走查

后续[自动解除静音走查](voiceprint-rtc-autounmute-review-2026-10-11.md)已补齐无需手动暂停／恢复的验证，修复停止回执未终结许可的问题。本文保留先前运行的独立证据；仅解除静音已验证，长时间空闲退出后的恢复仍需继续。

日期：2026-10-11（Asia/Shanghai）。在[完整 RTC 合成链路](voiceprint-full-rtc-review-2026-10-11.md)基础上，补充原生静音、轨道替换、连接重建和容量恢复。仍使用合成用户及音频、真实 LiveKit／后端／Beat／消费者／Qwen encoder；ASR 为本地协议 fixture。未使用真人录音或生产环境。

## 空派发问题与修复

两次实际隔离运行在第三个房间实例等待采样时失败。第二次在 25 秒和 75 秒均观测到 sampler 空闲、就绪，派发 `jobs` 仍为空，没有新增许可。原后端将同实例的空派发无限视作 `existing`，后续重查也不重新创建任务；这使短暂容量不足留下的空回执可以永久阻塞采样。

`voiceprint_sampling_dispatch.py` 改为：

- pending／running job 继续复用；遍历全部匹配派发后先判断活跃任务，避免列表前面的空回执导致取消后面的活跃任务。
- 空回执保留 30 秒启动宽限期；超过后重新读取这条派发，确认仍为空、属于同一个 agent／room SID，再复查当前房间实例并删除、重新派发。
- 每个既有 5 秒 RPC 批次最多替换一个空回执。读取、删除超时或失败走原有固定错误／持久重试；不输出 provider 私有错误。
- 未知或未来创建时间保持复用，避免在缺少依据或时钟偏差时取消启动中的任务。其他 agent、其他实例、删除状态或无效 metadata 不会被清理。

LiveKit 1.13.1 使用 Unix 纳秒时间写入派发创建时间，删除前的读取使用已安装 Python SDK 的 `get_dispatch`／`delete_dispatch` 接口。依据为[同版本官方实现](https://github.com/livekit/livekit/blob/v1.13.1/pkg/rtc/room.go#L1832)；此处冻结已核验的时间单位，没有按整数位数猜测。

## 原生媒体证据

首次补充运行已经通过四个会议实例、42 次签名 webhook 和 9 个许可，所有房间／参与者／轨道／owner 绑定一致；候选和已消费许可始终只有最初三个。已确认 30 秒有效语音、一个加密 headset 基准模板和三个支持样本保持不变，原始音频为零。

- 在实际采样后原生 `mute()`，等待采样状态退出，确认中断片段没有入库。解除静音场景显式暂停取消旧许可，再恢复积累、取得新许可；仅解除静音后的自动恢复尚需单独测试。
- 实际 `unpublish_track()` 后在同一连接发布新 microphone track。新 SID 必须获得新许可才出现采样状态；旧片段不能合并到新轨道，随后暂停并结束实例。
- 同账号显式 `disconnect()` 后在同一 room SID 重建连接。旧 participant SID 的查询被拒绝，新 SID 从 revision 0／共享状态重新声明，声明前未被订阅；重新声明 handset 后实际采样，再删除房间以中断缓冲。

上述连接重建采用显式断开／新 participant SID，不替代网络丢包、ICE 恢复、TURN 或 SDK 保留 SID 的软重连测试，也不代表耳机、手机或相机设备测试。

## 制品与验证

按仓库根 Dockerfile 的 `backend-voiceprint` 目标完整重建本地后端，UID 10001:0，Python 3.13.5、FFmpeg 6.1.2。sampler／encoder 使用已有 Linux 制品（Python 3.13.13）。未推送镜像或部署集群。

```powershell
docker build --target backend-voiceprint --build-arg DOCKER_USER=10001:0 `
  -t we-meet-backend:voiceprint-dispatch-20261011 .
python deploy/aliyun/run_voiceprint_rtc_probe.py --media-boundaries `
  --model-pack D:/private/encoder-pack-v1 `
  --diagnostics-dir D:/private/voiceprint-rtc-diagnostics
```

本地后端镜像 ID 为 `sha256:ece2c5849c10529ff7d8393e9a874b26c9d4f9e9e760393292a9fa687401fc5b`，216,664,207 字节；修复文件 SHA-256 为 `69b6a6b65f6a4f306a4b3da8b405393786a45d58e165772d7d2e0927c9bec448`，制品内与源码一致。这是本地验证身份，不是仓库部署引用。

38 项后端派发专项测试通过（8.28 秒），覆盖宽限期、时钟偏差、读取后变为活跃任务、作用域变化、不同 agent、房间替换、provider 超时和每批清理上限。16 项 sampler 测试通过（5.086 秒），包含原生 SDK 队列、源变化、撤权、取消和缓冲擦除。四个探针文件按后端 Ruff 配置通过。

最终扩展运行通过容量确定占满时的真实空派发恢复：保留当前 sampler 的既有 30 秒空闲期限，在第二个业务房间取得真实空回执；不重启 sampler，等待实际采样，再检查旧空回执已退出、新回执已有 job。随后暂停、清理并继续全部媒体边界场景。后续两个实例还实际观测到 26 秒的同作用域空回执，随后都成功恢复。

最终汇总为 5 个已结束会议实例、50 次签名 webhook／50 次成功、10 个绑定一致的许可（3 个已消费、7 个已取消）、3 个已确认候选／3 个编码成功／3 个质检成功、1 个加密模板／3 个支持样本、30 秒确认有效语音、0 个未授权用户候选和 0 份原始音频。driver／backend 正常退出，sampler SIGTERM 正常退出且无 OOM；自建容器及网络实际清理。四实例运行和五实例运行是两次不同验证，不能合并当作容量或稳定性统计。

## 剩余验收

仍需真实 Web／Android 设备、仅解除静音的自动恢复、网络软重连／故障注入、多端同账号、屏幕／系统／翻译音轨、共享／回声场景，以及生产 TLS／CNI／容量、历史搜索、可信删除墓碑备份恢复和获授权真人的效果校准。Qwen 优先和完整目标不变，功能继续默认关闭；本轮合成证据不作为真人识别准确率。
