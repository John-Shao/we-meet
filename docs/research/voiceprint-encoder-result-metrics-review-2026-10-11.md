# 编码器结果分类与许可缓存监控走查

日期：2026-10-11（Asia/Shanghai）。对应方案第 18 节运行保障。前述[短时并发](voiceprint-encoder-load-review-2026-10-11.md)和[五分钟运行](voiceprint-encoder-soak-review-2026-10-11.md)证明正常过载也返回 503；原来的 5xx 汇总不能区分该情况与模型故障。本次补齐平台无关的指标契约，尚未安装监控平台、告警规则或发送通知。

## 修改与指标契约

保留 `voiceprint_encoder_requests_total{outcome}` 和原有就绪／活动／上传指标；新增 `voiceprint_encoder_results_total{result}`。每次 embeddings 请求只计一个固定分类，健康／metrics 请求不进入业务计数。分类使用内部响应元数据，不解析响应向量，也不将错误正文、请求 ID 或许可内容作为标签。

| result | 含义 |
|---|---|
| success | 成功响应 |
| busy | `503 encoder_busy`，当前实例活动推理／上传达到上限 |
| permit_capacity | `503 permit_capacity_exceeded`，有效许可的重放缓存容量不足 |
| unavailable | 模型不可用、非预期异常或未细分的服务失败 |
| timeout | `503 encoder_timeout`，模型进程推理超时 |
| rejected | 授权、许可、重放、音频等请求拒绝 |
| canceled | 处理协程收到取消；不表示模型进程已停止 |

只允许上述七个标签值；未知错误归入固定类，不扩展标签集合。新增三个 gauge：

- `voiceprint_encoder_permit_entries`：内存字典中的实际条目数，可能含已过期、尚未在下一次 reserve 时清理的条目。
- `voiceprint_encoder_permits_active`：读取时仍未过期的条目数。
- `voiceprint_encoder_permit_capacity`：重放屏障的容量，生产默认 1,024。

读取指标不删除条目、不改变推理／授权状态，也不输出 jti、token、签名 key、音频摘要或向量。HTTP JSON 与状态码保持原契约；指标仍为私有、`private, no-store`，既有 NetworkPolicy／CA 访问要求继续适用。

## 验证与制品

1. Linux 验证镜像全套 **87 项通过、无跳过**，17.41 秒，使用固定实际 Qwen pack；覆盖 busy 与模型故障分开计数、超时／未知错误脱敏、许可容量拒绝、自然过期后的读指标不清理缓存，以及原有协议／进程／向量约束。首轮因测试命令漏挂载后端 transport 得到 86 通过、1 失败；补齐 `/backend` 后复验通过，不修改该测试或跳过互通检查。
2. 新生产镜像的真实 HTTPS 探针通过：当前后端 `EncoderClient` RPC、可信 CA、重放、success／rejected 计数、许可 entries／active／capacity 以及正常子进程退出。该探针使用合成音频，无 Django 或业务数据库。
3. 新生产镜像再跑 3／10 秒、1／2／4／8 路、每组 30 波共 **1,140 次请求**。481 次有效向量、659 次 `encoder_busy`；新增指标精确对应 success=481、busy=659，其余五类均为 0；许可 entries=481、active=481、capacity=1,024。240 次波次后串行恢复通过。此轮未再执行五分钟阶段，不把旧镜像的持续结果记到新镜像。
4. 四份改动 Python 文件的 Ruff／格式检查、源码摘要及清理回执通过；两次真实生产探针的临时证书／凭证与容器全部清理。

本地生产镜像 `we-meet-voiceprint:metrics-20261011`，ID `sha256:43e4b7c4b77199bc31f4352dd0d6d617e881c6d227860f67b4074a83bdd32bd7`；验证镜像 ID `sha256:57d31f1c9bc933eb5c79126b655b090aa7797211c617261a4d8083d4eb8b82a0`。构建实际解析 Python 基础镜像 digest `aa938a849bcb82dce8f49480f056ab82bf5c1c3ebc294f0430f37b6820e7f286`。依赖仍按 Linux hash lock 安装，公开模型及预处理不变。以上为本地 ID，未上传 registry，也未作为目标集群已部署的证明；旧测试镜像保留。

生产镜像中已安装的六份相关模块与当前工作树逐份核验，`server.py` 规范化 SHA-256 为 `1be9843f4e208f89bc8970858744bd1ce42e87816756ec05fad415354a8dc226`；模型 `encoder.py` 继续为 `55d3aea4b6d0df2ebb4b0bf01975b462e875db121cd6a8d508bdcbd0c92c7835`，权重继续为 `f8b8aa2a5a7e7ddc9043b4979a07bbefca13bfd402a0464a19c1974ea1f6a71a`。真实探针 SHA-256 `a5aa4ee2d4efe585bb66bae0ebc6f16dfc01ca3a2fd91e87735cb9eef11fe325`；并发探针 SHA-256 `82481659da92ab0857bc74faf43270cc367ed519e13efc9e19b2df746cccc7c9`。

并发复验使用[探针](../../deploy/aliyun/voiceprint_encoder_load_probe.py)的 `--require-result-metrics`，要求七类齐全、计数与实际 HTTP 回执一致、许可指标有界且无秘密字段；该选项默认不启用，旧版本镜像的历史测试范围保留。私有原始结果：`work/voiceprint-encoder-metrics-{runtime,load}-result-2026-10-11.json`、对应 `.log` 及 `voiceprint-encoder-metrics-source-check-2026-10-11.json`。

## 后续接入

监控系统分别观察 busy／permit_capacity 的容量压力与 unavailable／timeout 的故障，结合 ready、活动任务和用户排队信息解释；不把预期 busy 计为模型故障，也不将 entries 中的过期条目误认为有效许可占满。单进程计数重启后归零，接入方按实例／重启处理 counter；不将其作为跨副本全局幂等或业务授权证明。

目标监控平台、采集身份／精确网络 peer、聚合窗口、告警阈值／接收人仍需确定。组织层队列、清理与人工拒绝继续使用已有管理接口；完整目标部署、持续容量、独立日志及真人／设备准入未因新增指标而通过。
