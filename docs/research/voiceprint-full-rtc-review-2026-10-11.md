# 声纹采样完整 RTC 合成链路走查

日期：2026-10-11（Asia/Shanghai）。本轮将可信来源、本人声明、真实 RTC、独立队列与 Qwen 编码接在同一条隔离链路上。只使用合成用户和合成音频，无真人录音、收费 ASR、镜像仓库上传或生产部署；识别匹配开关关闭。

后续原生媒体边界及空派发恢复已通过，见[媒体边界走查](voiceprint-rtc-media-boundaries-review-2026-10-11.md)。下文 20 次 webhook 等数据为前一轮基础模式的证据；扩展模式使用 `--media-boundaries`，最终为五实例、50 次 webhook 和 10 个许可，ASR 仍是本地协议 fixture。

## 可复现的验证入口

三个脚本分别负责隔离环境、真实后端与原生发布者：

- `deploy/aliyun/run_voiceprint_rtc_probe.py`：仅使用本地缓存镜像，创建唯一 Docker internal 网络、临时 PostgreSQL／Redis 与私有凭据；不暴露宿主端口。模型包和诊断目录必须由操作者明确指定，诊断目录不能在仓库内。
- `deploy/aliyun/voiceprint_rtc_backend_probe.py`：生产后端镜像、真实迁移、Django SessionAuthentication／CSRF、HTTPS、签名 webhook、固定 prefork 消费者及单实例 Celery Beat。只创建合成用户、登录会话和业务房间，不预置会议实例、参与记录、轨道、许可、向量或模板。
- `deploy/aliyun/voiceprint_rtc_media_probe.py`：生产 sampler 镜像中的原生 LiveKit SDK。通过真实 HTTPS 本人 API 声明授权及设备，发布 24 kHz 单声道合成音频，由后端真实派发 sampler；没有手工 LiveKit dispatch 或替代许可服务。

```powershell
# 在 feature 仓库根目录执行。Python 环境需提供 cryptography；Docker 使用 Linux 容器。
python deploy/aliyun/run_voiceprint_rtc_probe.py `
  --model-pack D:/private/encoder-pack-v1 `
  --diagnostics-dir D:/private/voiceprint-rtc-diagnostics `
  --backend-image we-meet-backend:voiceprint-dispatch-20261011 `
  --sampler-image we-meet-voiceprint-sampler:feature-20261011 `
  --encoder-image we-meet-voiceprint:feature-20261011 `
  --livekit-image livekit/livekit-server:latest
```

默认镜像标签是本地验证入口，不是发布用不可变引用。脚本启动前检查所有镜像已缓存，不拉取仓库。实际验证使用 LiveKit server 1.13.1；sampler／encoder 为 Python 3.13.13，后端为 Python 3.13.5。sampler 制品身份及依赖锁见[采样运行走查](voiceprint-sampler-runtime-review-2026-10-11.md)。后端、encoder 的基础验证见[消费者运行走查](voiceprint-consumer-runtime-review-2026-10-11.md)；后续重建后端已包含空派发修复，制品身份见[媒体边界走查](voiceprint-rtc-media-boundaries-review-2026-10-11.md)。

## 验证边界

后端与 sampler 使用一次性私有 CA 的 HTTPS，保留证书与主机名校验；本人请求保留生产 HTTPS／CSRF／安全 Cookie 行为。LiveKit 的内部签名 webhook 使用专用 HTTP 监听，仅精确豁免该 webhook 路径的 HTTPS 重定向；签名及请求体哈希由项目原有接收器校验。LiveKit 信令和媒体在隔离网络内使用 WS／RTC，此测试不证明生产 WSS／TURN／CNI。

Qwen speaker encoder 实际读取模型包、处理 RTC 音频并返回向量；向量与模板走真实加密及持久化。语音质检的 ASR 服务是 loopback 协议 fixture，提供单人、10 秒及有效词时间戳，不调用云 ASR。有效语音时长和单人证据来自 fixture；不能把它解释为 Qwen ASR 已准确识别合成音频，更不能解释为真人声纹效果验收。

## 已取得的证据

完整链路已验证：未声明设备前不隐式订阅；未授权发布者没有订阅和候选。真实 sampler 经 Opus／PCM 上传三个 10 秒候选，每段为 24 kHz、单声道、16 bit、240,000 帧；总会话配额限定为 30 秒。三个编码任务与三个质检任务成功，音频及向量加密。本人确认前没有模板；通过真实本人确认 API 后生成一个包含三个支持样本的加密 headset 基准模板，确认有效语音合计 30 秒，原始音频随后被实际维护任务清除。

最终一次隔离运行正常退出并完成所有自建容器／网络清理。真实 Beat 按既有周期发布处理和恢复任务；没有手工 `/tick`。同一业务房间重新创建新的 LiveKit room SID 后，对旧连接的查询被精确拒绝，新连接从 revision 0／共享麦克风状态重新声明设备。实际收到采样状态后，本人暂停使运行状态立即停止、许可被取消，缓冲没有生成第四个候选；第二实例结束后持久会话数为 2，采样活跃房间归零。driver／backend 退出码 0，sampler SIGTERM 退出码 0 且无 OOM。

最终汇总为 20 次 webhook 请求／20 次成功、3 个已消费许可／1 个已取消许可、3 个已确认候选／3 个编码成功／3 个质检成功、1 个加密模板／3 个支持样本、0 个未授权用户候选及 0 份保留原始音频。该结果是单次合成场景的验证证据，不是容量、稳定性或真人效果统计。

合成向量的余弦一致性只用于检查模板工程门槛，没有用于计算真人误认率／拒识率，也没有据此启用多人实名自动匹配。

## 走查中修复的验证问题

- 本地 ASR fixture 按真实请求协议读取 `speaker_diarization_enabled` 和 `input_audio.data`；早期错误字段造成的是验证服务失败，没有修改业务接口来迁就 fixture。
- 等待真实后端完成迁移和消费者启动后才创建发布者，避免使用固定启动延时。
- 使用真实 Beat 的既有处理／恢复周期，移除高频手工 `/tick` 扫描。早期一次模板等待超时未保留完整消费者日志，原因未能确定；不宣称已定位业务根因。现在诊断保留三个进程日志及固定字段的汇总状态。
- 旧已结束连接被现有 `connected()` 守卫以 403、`voiceprint_sampling_connection_ended` 拒绝；验证严格检查这一契约，不将所有 403 视为成功，也不把旧连接映射为新实例。
- 诊断写入失败仍执行消费者、监听器和容器清理；宿主脚本逐项尝试回收全部自建容器、匿名卷和唯一网络，不操作既有容器或数据。

最终验证要求 driver／backend 正常退出，sampler 正常 SIGTERM 排空且无 OOM；任何失败都不作为通过证据。私有诊断可能包含合成用户／任务标识，不进入 Git；原始声纹向量、登录 Cookie 和密钥不在验证汇总中返回。

另外按后端 Ruff 配置检查四个 Python 文件通过。`python -m unittest discover -s deploy/aliyun -p test_voiceprint_rtc_probe.py -v` 的两项失败路径检查通过：诊断写入失败和 Docker 日志超时都保留原始启动错误，并继续尝试清理全部六个自建容器与唯一网络。此检查使用模拟 Docker，不连接宿主服务；完整 RTC 证据来自上面的实际隔离运行。

## 后续验收

原生静音、显式恢复、轨道替换、新 participant SID 重建及房间中断已补充，边界见[媒体边界走查](voiceprint-rtc-media-boundaries-review-2026-10-11.md)。仍需真实 Web／Android 设备、仅解除静音的自动恢复、网络软重连／故障注入、多端与系统音轨、生产私有 TLS／CNI／资源／监控／容量、历史版本／搜索、可信外部删除墓碑的备份恢复，以及获授权真人的 Qwen 效果校准。当前没有获授权真人样本。完整目标不变；上述合成链路通过不代表整体 P0、真实设备或生产发布验收完成。继续 Qwen 优先，只有效果不满足要求时才评估 CAM++ 私有部署。
