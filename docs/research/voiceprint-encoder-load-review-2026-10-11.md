# Qwen 编码器短时 HTTPS 并发与过载恢复

日期：2026-10-11（Asia/Shanghai）。对应[方案容量项](../plan/speaker-identity-voiceprint-plan-2026-10-09.md#64-配置依据与-p0-容量验证)。本次补充真实编码器 HTTP 并发证据，使用合成信号及临时凭证，不使用真人、ASR、登记模板、数据库或业务队列。

## 固定环境与验证范围

- 本地 Docker Linux x86_64，WSL2 内核 `6.6.87.2-microsoft-standard-WSL2`，CPU 型号 `Intel(R) Core(TM) i9-14900HX`。生产镜像 `we-meet-voiceprint:feature-20261011`，ID `sha256:c68c772feb1a9914bbe1b0f52f89e84051abec61e1a326b98e1782da0ef0063a`，Python 3.13.13、Torch 2.10.0+cpu、NumPy 2.2.6、librosa 0.11.0。硬件与 ECS 不同，两者耗时不合并比较。
- UID/GID 10001，非 root、只读根、丢弃 capabilities、禁止提权、网络 `none`、128 PID、64 MiB 临时卷；公开模型、临时 Secret 文件及代码均只读挂载。实际 Docker 配置核验通过；内核 `cpu.max=200000 100000`、`memory.max=2147483648`。
- **服务、模型子进程、测试 caller 与采样线程共享 2 CPU／2 GiB 测试 cgroup**，不是单独隔离给 server 的生产容量。实际 HTTPS 回环地址验证临时 CA 和 IP SAN，没有关闭证书校验。
- 固定公开 Qwen pack，权重 SHA-256 `f8b8aa2a5a7e7ddc9043b4979a07bbefca13bfd402a0464a19c1974ea1f6a71a`，FP32、batch 1、两个 Torch 线程、24 kHz 单声道 PCM16、1024 维单位向量。运行中核验镜像安装的 `server.py`、`encoder.py`、`isolated_encoder.py`、`permits.py`、`audio.py`、`spec.py` 摘要与工作树一致。
- 使用当前后端 `decode_result` 校验所有 HTTP 200 的完整向量／质量／来源摘要契约，transport 规范化 SHA-256 `76d1f18ac2bf9c162094b65cece33b81ea53a61128062d175c0a7be5bf4bb2fb`。没有执行 Django、业务租约、重试消费者或身份建议发布。
- [探针](../../deploy/aliyun/voiceprint_encoder_load_probe.py) SHA-256 `e2b759323e4dde67e5aeb250efc322061b71b5f7678dd8d2212ec5112af5c4fd`。每组用线程屏障同时发起请求，共 30 波；每波完成后额外串行提取一次，并检查 ready/live。许可均新生成，不输出音频、向量、许可、凭证或请求 ID。

## 实测

8 组共 900 个并发波次请求和 240 个串行恢复请求，合计 **1,140 次**。481 次 HTTP 200 均通过实际后端解码；659 次均为固定正文 `503 encoder_busy`，没有其他失败码、超时或客户端异常。没有自动重试或把拒绝改记为成功。

| 音频 | 并发 | 波次请求 200／503 | 成功 HTTP 经验 P95 | 拒绝 HTTP 经验 P95 | 波次后串行恢复 P95 |
|---|---:|---:|---:|---:|---:|
| 3 秒 | 1 | 30／0 | 39.55 ms | — | 42.61 ms |
| 3 秒 | 2 | 30／30 | 37.51 ms | 8.39 ms | 39.66 ms |
| 3 秒 | 4 | 30／90 | 45.40 ms | 13.92 ms | 42.65 ms |
| 3 秒 | 8 | 30／210 | 53.31 ms | 21.47 ms | 39.38 ms |
| 10 秒 | 1 | 30／0 | 92.03 ms | — | 98.11 ms |
| 10 秒 | 2 | 30／30 | 97.02 ms | 14.16 ms | 92.43 ms |
| 10 秒 | 4 | 31／89 | 152.61 ms | 16.16 ms | 90.08 ms |
| 10 秒 | 8 | 30／210 | 265.09 ms | 21.77 ms | 93.42 ms |

经验 P95 使用 nearest-rank `ceil(0.95×N)`，按成功、拒绝与串行恢复分别计算，样本数见原始回执。第一组包含首次实际推理，没有把该组称为独立预热基准。单次服务冷启动至 ready 约 6.001 秒；八组负载阶段合计约 33.507 秒，每组约 2.4～6.4 秒，**不是持续生产压测或长期增长验证**。

10 秒／4 路一波中有两次成功，说明请求到达／读取时间跨过前一次推理完成时刻；不会把每波请求数当作同时活动的模型数。1,112 次轮询采样的活动推理峰值为 1、上传峰值为 2，所有样本均在实现上限内。该轮询不证明未采样时刻的绝对峰值。

server 与唯一模型子进程的采样 RSS 合计峰值约 560.68 MiB；整个测试 cgroup 的内核内存峰值约 695.92 MiB，后者包含 caller 和其他测试开销。模型子进程在八组前后未变化；正常 SIGTERM 后 server 返回 0、该子进程退出。240 次恢复调用和全部波次后的 ready/live 均成功。

## 失败记录、清理与剩余准入

首轮未通过 startup、未执行负载，保留失败回执。补全测试 PKI 的 CA KeyUsage／SKI 与 leaf AKI／SKI 后，复验通过；未更改生产 TLS 或模型代码，也不将首轮计入上述负载统计。探针增加固定类型的启动诊断，不输出异常消息或 Secret 内容。本次探针 Ruff 检查与格式检查通过。

测试容器及五份临时 CA／证书／私钥／token／permit-key 文件均清理。没有开放端口、修改 ECS、上传 registry 或修改功能开关。私有产物：`work/voiceprint-encoder-load-{initial,result,source-check}-2026-10-11.json`、`work/voiceprint-encoder-load-2026-10-11.log`；清理回执及源码摘要核验通过。

复验需要在受限独立容器内只读挂载经过校验的模型包、实际后端 transport 到 `/backend`、临时凭证到 `/run/fixture`，并设置服务使用的 `VOICEPRINT_*_FILE`、模型路径／摘要和线程数。先确认容器资源与无网络配置，再执行 `/opt/venv/bin/python /probe.py`；必须检查 JSON `status`、非零失败退出码和清理回执。临时密钥不得写入 argv、日志或 Git。

该结果证明当前镜像短时并发的有界拒绝和波次后恢复；增加 caller 并发不能增加单实例同时推理数。完整消费者排队、重试公平性、长时资源增长、ASR 竞争、生产目标节点预算及端到端 P95 继续待验收。真人效果、门限校准和真实跨端设备仍按原准入执行，未取得 Qwen 不合格的证据。
