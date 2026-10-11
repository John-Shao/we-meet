# 完整声纹隔离链路部署前检

日期：2026-10-11（Asia/Shanghai）。用户已选择先部署完整声纹测试链路，使用合成音频；生产灰度发布不在本次操作范围。监控系统继续等待监控 ECS 到位。

## 当前环境与部署条件

2026-10-11 18:42 对已指定 ECS 做只读核验：单节点 allocatable 4 CPU，requests 3,650m，剩余 350m；内存 requests 7,334 MiB，根盘可用约 28 GB。30 个非终态 Pod，没有 Pending；现有业务部署全部就绪，未发现监控 Deployment。仅核验元数据，没有修改工作负载、读取业务环境变量或返回 Secret。

仅默认 encoder 和三类消费者就需要 1,700m CPU requests，尚未计入独立 API、数据库、Redis、sampler、LiveKit、Beat、撤销日志及临时清理。因此，不能在剩余 350m 内按完整配置部署，也不能把短期探针的低请求值作为完整隔离链路预算。独立 namespace 隔离不等于获得独立 CPU、磁盘或网络故障域。

前检时向用户确认本地 Docker 或独立测试 ECS／已有环境的选择，未创建测试集群资源、缩容现有业务或购买新 ECS。用户随后明确选择“先用本地 Docker 完成合成链路验收，ECS 验收后补”；后续部署结果见[本地合成链路记录](voiceprint-local-acceptance-review-2026-10-11.md)。

本地 Docker 当前为 Linux，提供 32 CPU／约 15.44 GiB 内存；已有容器一次采样约占 4.4 GiB。宿主 Windows 空闲内存约 1.9 GiB，需在实际执行前再核验内存及 Docker 可用预算，不能把 Docker 标称额度和宿主空闲内存直接相加。既有容器不属于本次清理范围。

随后用一个 32 MiB／0.1 CPU、非 root、只读且断网的临时容器只读取 Docker Linux 的内存元数据，观察到 `MemAvailable` 为 9,857,524 KiB（约 9.4 GiB）；探针正常退出并自动移除。该观察支持本地 Docker 作为候选环境，不等于完整链路已经运行，仍应在执行时再次核验。

## 已完成的部署入口修复

现有 `deploy/aliyun/run_voiceprint_rtc_probe.py` 已能部署独立 PostgreSQL 主库、独立 PostgreSQL 撤销日志、Redis、LiveKit、Qwen encoder、后端、sampler 和原生合成媒体 driver。后端进程包含真实 API、Beat 与 control／processing prefork 消费者，使用实际迁移、HTTPS／CSRF 和签名 webhook；部署结束回收自身容器、匿名卷、网络和临时凭据。

此次修复两类问题：

1. 数据库主库、Redis 和 LiveKit 未完整设置资源上限；现为每个自建容器设置 CPU、内存和 256 个 PID 上限，日志数据库的预算也统一纳入同一张表。
2. 启动前虽检查镜像缓存，创建时仍使用可变标签。现先解析全部缓存镜像的完整 `sha256` 本地 image ID，创建只使用已解析 ID 并设置 `--pull=never`；镜像缺失、ID 格式不合法或多行歧义均失败，不回退到下载。成功回执附带实际 image IDs、资源限制及 fixture 边界。

以下限制只用于本次合成 Docker 场景，不是 Kubernetes requests，也不修改生产建议：

| 自建组件 | CPU 上限 | 内存上限 |
|---|---|---|
| PostgreSQL 主库 | 0.5 | 512 MiB |
| PostgreSQL 独立日志 | 0.5 | 512 MiB |
| Redis | 0.25 | 128 MiB |
| LiveKit | 0.5 | 512 MiB |
| Qwen encoder | 2 | 2 GiB |
| 后端及其 API／Beat／消费者 | 2 | 2 GiB |
| sampler | 1 | 768 MiB |
| 原生媒体 driver | 1 | 768 MiB |

各 CPU 上限合计 7.75、内存上限合计 7,296 MiB；这是逐容器上限之和，不是整机独占保证。运行中仍应观察节流、内存、OOM、超时及其他业务竞争。

后续显式 `--import-web-review` 模式新增 MinIO（0.5 CPU／768 MiB）、文件转写协议 fixture（0.25／256 MiB）及本机 TCP 转发（0.25／128 MiB），共 11 个容器、上限合计 8.75 CPU／8,448 MiB，不含宿主 Vite／Chromium。转发仅发布 `127.0.0.1:5318`，Vite 仅监听 `127.0.0.1:5319`，默认模式仍无宿主端口；TLS 证书校验开启。实际通过及资源回收证据见[本地上传／Web 验收](voiceprint-local-import-web-review-2026-10-11.md)，真实 Qwen ASR 继续后补。

## 本轮验证及后续验收边界

9 项探针单元测试通过：固定镜像身份／重复引用、拒绝错误及歧义 ID、清理异常仍回收自建资源，以及可信音轨来源和终态擦除。模拟创建路径核验固定 image ID、禁止拉取、CPU／内存／PID 限制各出现一次且无宿主端口。Ruff 与差异检查通过。此记录不是完整链路已经启动或通过的证明；实际部署结果另行补录。

环境确定后，先用最新已校验的后端及 encoder 制品运行 `--media-boundaries`，验证授权 → 原生 RTC → 逐轨许可 → 队列 → Qwen 编码 → 本人确认 → 加密模板 → 音频擦除，并复验独立日志、静音恢复、重连及资源清理。既有[强制独立日志 RTC 记录](voiceprint-journal-rtc-review-2026-10-11.md)代表早期制品，不迁移为本轮新制品的通过证据。

前检时 RTC 入口**保持实名匹配关闭**，只启动 control／processing 两类消费者；语音质检为本地 ASR 协议 fixture，因此当时只覆盖采样登记。后续新增显式 `--synthetic-identification` 选项，在同等隔离范围接入真实 identity 消费者、私有合成来源媒体及建议查询／人工确认；默认仍关闭匹配。测试策略标记为合成测试用途，不安装到生产或作为真人校准策略，实际结果按上面的本地记录核验。

合成测试不证明真人 precision、未知 FAR、设备覆盖或污染率。真实 Qwen ASR、物理 Web／Android、生产 WSS／TURN／E2EE／CNI、容量与告警继续按[交付准入](voiceprint-delivery-audit-2026-10-11.md)验收；监控延期不自动取消发布条件。

本次私有元数据产物：工作区 `work/voiceprint-ecs-isolated-preflight-2026-10-11.json`，不纳入 Git。连接凭据不写入文档或回执。
