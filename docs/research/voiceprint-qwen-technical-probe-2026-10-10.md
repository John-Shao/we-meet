# Qwen 编码器技术探测与证据

日期：2026-10-10（Asia/Shanghai）。范围：本机 Windows、固定公开 Qwen 权重、合成 FM 信号；未使用真人录音，未测身份准确率、VAD、混合说话人识别或生产容量。保持 Qwen 优先；技术链路可用还不能决定是否满足方案效果门槛。

## 固定来源与提取结果

采用 [Qwen3-TTS-12Hz-0.6B-Base 固定模型](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base/tree/5d83992436eae1d760afd27aff78a71d676296fc)，encoder 配置以该版本 [config.json](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base/blob/5d83992436eae1d760afd27aff78a71d676296fc/config.json)和 [官方源码](https://github.com/QwenLM/Qwen3-TTS/blob/022e286b98fbec7e1e916cb940cdf532cd9f488e/qwen_tts/core/models/modeling_qwen3_tts.py)为准。许可文件及改动说明随源码子集保留，见 [LICENSE](../../src/voiceprint/voiceprint/_vendor/LICENSE.qwen)和 [NOTICE](../../src/voiceprint/voiceprint/_vendor/NOTICE.qwen)。

| 对象 | 校验／结果 |
|---|---|
| 来源源码 SHA-256 | `25c42656bcf810f06ef6bc1839bd7083f3c8cfedac3a147c4060b4262b1c96a0` |
| 完整模型权重 | 1,829,344,272 字节；SHA-256 `180b3b10eb1c9f1b4db7806d5475bae3071c0243c299d49926bab1da3b6946f6` |
| encoder 权重 | 17,716,496 字节，76 tensors，8,854,336 参数；SHA-256 `f8b8aa2a5a7e7ddc9043b4979a07bbefca13bfd402a0464a19c1974ea1f6a71a` |
| 特征空间 | `qwen3tts-speaker:2ce8c66530f607837b8cdb4f95ce4a359bfee604dc2a2731adc46b89866c5df5` |
| 推理规则 | CPU float32，单声道 24 kHz，官方 mel128 计算，1024 维输出后 L2 归一化 |

两次在独立目标目录制备 encoder，结果哈希与特征空间一致。运行时不加载完整 TTS，不联网取模型，不接受任意远程代码。归一化是本项目明确的特征规则；不同模型和特征空间禁止混比。

完整[权重制备 manifest](voiceprint-qwen-encoder-manifest-2026-10-10.json)和[资源探测 JSON](voiceprint-qwen-technical-probe-2026-10-10.json)保留元数据，不含向量或音频；源码、依赖版本和复现命令见[服务说明](../../src/voiceprint/README.md)。

## 合成探测结果

环境：Windows AMD64，Python 3.13.9，Intel Family 6 Model 183；本机 24 个物理核心／32 个逻辑核心。Torch `2.10.0+cpu`，numpy `2.2.6`，librosa `0.11.0`；推理限制 2 个 Torch 线程。每种长度 4 次调用，首轮单列，后 3 次计算中位数。

| 合成片段长度 | 首次推理 | 后 3 次中位数 | 后 3 次最大值 |
|---|---:|---:|---:|
| 3 秒 | 0.109 秒 | 0.026 秒 | 0.033 秒 |
| 10 秒 | 0.113 秒 | 0.110 秒 | 0.126 秒 |

进程 RSS 每 20 ms 采样的峰值为 449,110,016 字节（约 428 MiB），包含本次探测进程的依赖与模型；不是容器请求／限制建议或生产媒体峰值。encoder 加载计时约 0.078 秒，排除模块导入。重复输入输出最大绝对差为 0，所有输出为有限 1024 维单位向量。

这些数字只描述本机合成信号的 encoder 计算。没有媒体解码、上传、业务授权、存储、多人分人、跨设备声音或端到端吞吐，不能用于承诺某配置服务器的并发人数。

## 契约与剩余验证

服务 61 项测试、后端调用 45 项测试通过。包含实际模型 HTTP 提取、后端至模型联通、输入／模型绑定、重放、过期、畸形 RIFF／上传边界、单推理并发、取消后保留预算、无效输出和错误脱敏。原始 WAV、向量和凭证均不输出到报告或日志。

质量字段明确是 `signal-only-v1`，语音／说话人一致性均未检查；本人登记、三类授权、可信通话采样、加密模板、撤销、数据库任务租约及入库复核仍未实现。Linux 镜像、TLS 实际部署、原生推理进程回收、生产容量和获授权真人评测继续待验证，进度见[开发记录](../plan/speaker-identity-implementation-2026-10-10.md)。
