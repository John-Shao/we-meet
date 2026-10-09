# Qwen 私有编码器技术基础

这是供后端已授权任务调用的独立 CPU 编码器。本人登记 API 与独立编码 worker 已接入；候选身份匹配、跨端登记界面和生产部署仍待完成。已验证固定 Qwen 模型加载、特征提取和进程故障恢复；没有真人声纹准确率、语音检测或混合说话人检测结论。

## 模型与特征空间

- 模型：`Qwen/Qwen3-TTS-12Hz-0.6B-Base`，revision `5d83992436eae1d760afd27aff78a71d676296fc`。
- 编码器源码：官方 [Qwen3-TTS 固定版本](https://github.com/QwenLM/Qwen3-TTS/blob/022e286b98fbec7e1e916cb940cdf532cd9f488e/qwen_tts/core/models/modeling_qwen3_tts.py)。保留 speaker encoder 和 mel 计算；修改说明及 Apache-2.0 许可在 `voiceprint/_vendor/`，不加载 TTS 或远程代码。
- 运行时只加载约 17.7 MB 的 encoder 权重；完整来源模型约 1.83 GB，仅在离线制备时使用。原始权重、源码、提取权重与特征空间均固定哈希，不在请求期间下载模型。
- 输入：单声道、PCM16、24 kHz WAV，3–10 秒，文件不超过 484096 字节。输出：CPU float32、1024 维、L2 单位向量。不能与 CAM++ 的模板直接比较。
- 信号检查仅拒绝过静、直流和明显削波；`speech_checked` 与 `speaker_consistency_checked` 始终为 `false`。业务入库前仍需语音、单人质量检查及本人确认。

所有固定值位于 `voiceprint/spec.py`；后端客户端固定同一空间，跨项目真实 HTTP 测试验证契约一致。

## Windows 技术验证复现

在此目录使用 Python 3.13。以下命令不包含用户录音或业务秘密；本地权重路径须指向审核过的公开模型文件。

```powershell
python -m venv .venv
& .venv/Scripts/python.exe -m pip install torch==2.10.0+cpu --index-url https://download.pytorch.org/whl/cpu
& .venv/Scripts/python.exe -m pip install -c constraints-windows-py313.txt -e '.[test]'
& .venv/Scripts/meet-voiceprint-prepare.exe --source-model 'D:/public-models/qwen/model.safetensors' --destination 'D:/public-models/qwen/encoder-pack'
$env:VOICEPRINT_TEST_MODEL_DIR='D:/public-models/qwen/encoder-pack'
$env:VOICEPRINT_TEST_ENCODER_SHA256='f8b8aa2a5a7e7ddc9043b4979a07bbefca13bfd402a0464a19c1974ea1f6a71a'
& .venv/Scripts/python.exe -m pytest -q
& .venv/Scripts/python.exe -m ruff check voiceprint tests
& .venv/Scripts/meet-voiceprint-probe.exe --model-dir $env:VOICEPRINT_TEST_MODEL_DIR --encoder-sha256 $env:VOICEPRINT_TEST_ENCODER_SHA256 --output 'probe.json'
```

制备工具要求完整来源文件的固定 SHA-256，目标目录须不存在。普通测试无需模型；实际模型测试必须显式提供上述环境变量，否则会跳过。约束文件记录本次 Windows 环境的依赖版本，尚未提供 wheel 哈希锁或 Linux 镜像验证。资源报告只包含合成信号指标，不输出向量、音频或身份。

## 私有服务配置与调用

启动变量：

| 变量 | 用途 |
|---|---|
| `VOICEPRINT_MODEL_DIR` | 已制备且只读挂载的目录 |
| `VOICEPRINT_ENCODER_SHA256` | 审核过的提取权重固定 SHA-256 |
| `VOICEPRINT_CPU_THREADS` | 1–8，默认 2；每进程只运行一次推理 |
| `VOICEPRINT_API_TOKEN_FILE` | 私有 bearer token 文件，32–256 字节可见 ASCII |
| `VOICEPRINT_PERMIT_KEY_FILE` | 与 token 不同的 HS256 密钥文件，32–4096 字节 |
| `VOICEPRINT_TLS_CERT_FILE` / `VOICEPRINT_TLS_KEY_FILE` | 服务端证书和私钥，必须同时配置 |

`meet-voiceprint` 默认监听 `127.0.0.1:8093`。非回环监听必须启用 TLS，最低 TLS 1.2；仅回环技术测试允许 HTTP。证书、密钥、录音和权重不提交仓库。生产隔离网络、只读挂载、资源限制、证书轮换与 Helm 开关仍需后续部署工作验证。

`POST /v1/embeddings` 要求 bearer token 与 `X-Voiceprint-Permit`：由后端签发的 HS256 JWT，固定 issuer/audience/scope，绑定 job UUID、唯一 jti、WAV 字节数／SHA-256、特征空间，最长 120 秒且不得超过任务租约。`Content-Type` 必须是 `audio/wav`；不接受 URL、用户姓名或任意模型参数。凭证和正文读取后、结果返回前均校验授权有效期。每服务最多两个正在读取的正文，10 秒读取上限；单次推理，繁忙返回 503，客户端取消后仍保持预算直到实际完成或推理子进程被回收。

HTTP 服务与原生推理分属两个进程。启动先预热，失败拒绝启动；正常请求复用已加载的子进程。预热和推理各有 20 秒期限，超时、崩溃或协议错误会终止、回收整棵模型进程树。推理超时返回 `encoder_timeout`／503，恢复期间返回 `encoder_unavailable`／503；后台重新预热，恢复尝试至少间隔 10 秒。PCM 与配置只通过有界管道传递，不写音频文件，也不将密钥或音频放入命令行。

Windows 10／Server 2016 及以上在创建进程时原子加入 Job Object，包含虚拟环境解释器后代；Linux 在加载原生库前设置父进程退出 SIGKILL 保护。只支持这两类平台，无法建立保护则拒绝启动。Windows 创建适配保留 Python 3.13 的 Popen 管道与等待逻辑，升级 Python 时需复验。父进程异常退出也会终止模型进程，不能仅依靠 Python 清理回调。

`GET /health/live` 返回 200/alive；`GET /health/ready` 在可接受推理时返回 200/ready，恢复期间返回 503/warming。健康接口不触发模型加载，不暴露模型、模板或身份。服务不记录访问日志，不持久化请求音频，响应禁止缓存。模型子进程重建保留 HTTP 进程的 jti 防重放缓存；缓存不替代数据库任务幂等、generation 或提交复核，重启／多副本仍由业务任务层保护。

后端 `core/services/voiceprint_encoder.py` 接收音频字节，关闭环境代理与重定向，校验证书，拒绝压缩响应并限制 JSON 为 64 KB；验证输出模型、输入摘要、1024 维有限单位向量及质量契约。连接／空闲读取超时为 3 秒，正文读取设置 30 秒绝对期限及租约期限。该期限在每次正文读取前检查，阻塞读取可能额外占用一个空闲超时；HTTP 响应头的慢速传输仍需外部 worker 硬期限兜底。客户端自身不提供本人授权或结果持久化权限。

## 当前证据与剩余工作

见[技术报告](../../docs/research/voiceprint-qwen-technical-probe-2026-10-10.md)、[登记 API 与 worker](../../docs/research/voiceprint-enrollment-api-worker-2026-10-10.md)、[进程隔离走查](../../docs/research/voiceprint-qwen-process-review-2026-10-10.md)和[开发记录](../../docs/plan/speaker-identity-implementation-2026-10-10.md)。授权、登记 API、加密样本与撤销、独立编码 worker 已验证；真正的分人质量、模板激活、多人匹配门限、跨端界面和生产部署仍待完成，技术探测向量不能登记为真人模板。Linux 本轮只验证父进程退出保护，尚未验证完整模型镜像；加入 HTTP 父进程后，容量应重新实测。
