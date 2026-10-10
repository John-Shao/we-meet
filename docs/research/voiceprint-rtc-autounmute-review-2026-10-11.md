# RTC 解除静音与许可终态走查

后续[空闲退出与首次订阅走查](voiceprint-rtc-idle-exit-review-2026-10-11.md)已验证长时间静音导致任务自然退出后的重新派发，并修复首次订阅前漏发停止回执的竞争。本文保留先前运行的独立证据；网络软重连及实际设备仍需继续。

日期：2026-10-11（Asia/Shanghai）。接续[媒体边界走查](voiceprint-rtc-media-boundaries-review-2026-10-11.md)，将静音后的探针改为仅执行原生 `unmute()`，不再调用本人暂停／恢复接口。仍使用合成音频及用户、真实 LiveKit／HTTPS 后端／Beat／消费者／Qwen encoder，ASR 为本地协议 fixture。

## 失败证据与修复

修复前运行明确失败：静音中断后，解除静音等待 75 秒仍无新许可和采样；25 秒、75 秒诊断均显示 sampler 空闲且就绪，同作用域派发仍报告 running job。三个已确认候选和模板保持不变，没有中断音频入库。探针正常记录失败并清理环境，未以观察超时重启进程。

代码走查确认，sampler 已释放媒体、擦除缓冲并上报 `stopped`，但后端仅更新活动阶段，没有终结其 `issued` 许可。同轨道下一次申请因此被旧许可阻挡；许可期限与 sampler 空闲期限都是 30 秒，这还可能导致 sampler 在取得新许可前退出。

`voiceprint_sampling_activity.report()` 在通过既有服务凭据、许可令牌、房间／participant／track、owner／组织、授权版本、阶段及序号检查后，将有效停止回执的许可更新为 `canceled`。更新与活动回执处于同一事务和既有锁顺序内。旧许可不能继续验证、上传或重放，新许可仍重新核验当前授权和来源。

取消只释放该轨道的活跃许可槽位，不退还已预约时长、不修改本人的暂停／设备声明或 revision。已消费许可的停止上报不能取消成功候选。过期或已撤销许可也不会被恢复。

第一次修复后运行停在探针的 `mute_discards_capture` 检查：仍只有三个候选，但终态许可已被真实周期清理器擦除私有字段，探针错误地要求所有许可保留原始上下文。已修正验证器：始终检查 track／owner／source session 的配额来源绑定；有 profile 的许可检查完整 RTC 来源，已清理者则必须为 canceled／expired、无 sample、profile 为空且全部私有上下文为空。活跃或已消费许可缺失上下文、部分擦除或错 owner／session 均不能通过。该运行没有到达解除静音检查，不作为恢复成功证据。

## 回归与制品

117 项许可／活动恢复／维护组合回归通过（83.35 秒），另一个新增的连续中断配额测试通过（2.29 秒）。新增覆盖有效终态后的新许可、旧许可失效、控制版本不变、无效令牌／作用域／序号／撤销授权，以及连续三次中断仍用完 30 秒会话额度。Ruff 和差异空白检查通过。

探针的 6 项清理／绑定证据测试通过（0.114 秒），包含 owner／session／RTC 来源不一致、部分清理和活跃上下文缺失的拒绝，以及两种合法终态清理状态。测试通过不替代后续真实 RTC 结果。

按根 Dockerfile 的 `backend-voiceprint` 目标重建本地镜像：`we-meet-backend:voiceprint-stop-20261011`，UID 10001:0。本地镜像 ID `sha256:1e51c4a2b54de4a7a8f157faaba5477f43a8cf2608f4faac3a99205d492b0819`，216,665,217 字节。修复文件 SHA-256 `b8e4a7f1d321cc49136fd2817c793cc25ef88527b96ac03b4e73a846d3733166`，镜像内与源码一致。未推送镜像或部署生产。

```powershell
docker build --target backend-voiceprint --build-arg DOCKER_USER=10001:0 `
  -t we-meet-backend:voiceprint-stop-20261011 .
python deploy/aliyun/run_voiceprint_rtc_probe.py --media-boundaries `
  --backend-image we-meet-backend:voiceprint-stop-20261011 `
  --model-pack D:/private/encoder-pack-v1 `
  --diagnostics-dir D:/private/voiceprint-rtc-diagnostics
```

## 验收范围

本次探针要求解除静音后出现新许可及实际采样，保持控制 revision 不变、未暂停、三个候选不变，随后继续轨道替换、显式新连接和房间中断。恢复耗时仅为单次合成观测，不能作为生产延迟或识别准确率。

最终运行通过全部场景：仅原生解除静音后 2.21 秒观测到实际采样和新许可，控制版本保持不变；后续替换轨道、显式重建连接及房间中断也通过。5 个已结束会议实例、50 次签名 webhook／50 次成功、10 个许可（3 个已消费、7 个已取消）绑定及终态清理规则全部一致。最终检查时已擦除终态上下文的数量为零；清理分支的证据来自前次实际周期清理及上述验证器拒绝测试，不能将此终点快照解释为遍历了所有清理时序。

仍只有 3 个确认候选、3 个编码成功和 3 个质检成功、1 个加密 baseline 模板及 3 个支持样本，共 30 秒确认有效语音、0 个未授权用户候选、0 份原始音频。driver／backend 正常退出，sampler SIGTERM 正常退出且未 OOM；自建容器、网络和临时凭据已实际清理。三次运行是不同验证，不能合并统计为性能或稳定性样本。

长时间静音／暂停导致空闲任务退出后的派发恢复、授权后首次订阅前的静音竞争、网络软重连、多端同账号、系统／屏幕／翻译音轨、实际设备与获授权真人、历史搜索／纪要版本、外部删除墓碑备份恢复及生产 CNI／TLS／容量验收仍需继续。此次修复不将 provider 的 running 状态视作已证明有实时采样。Qwen 优先、功能默认关闭及完整目标保持不变。
