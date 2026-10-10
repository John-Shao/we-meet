# 声纹消费者与私有运行配置走查

日期：2026-10-11（Asia/Shanghai）。本阶段补齐消费者镜像、启动校验、Helm 配置和本地异常退出清理。基础设施开关及业务开关默认关闭；没有生产部署或真人声纹评测。

## 修复及部署行为

- 根 Dockerfile 增加 `backend-voiceprint` 可选目标，包含镜像内 FFmpeg／FFprobe，供普通 API、AI API、三个消费者和清理进程使用同一后端制品。普通 `backend-production` 仍是默认目标。权重、私有配置和录音均不放入镜像。
- 三个独立 Deployment 分别只消费 `voiceprint`、`voiceprint-processing`、`voiceprint-identity`。启动命令为 `python manage.py run_voiceprint_worker --role control|processing|identity`，固定 prefork、并发 1、预取 1，每处理 100 个任务替换子进程；不接收任意队列或用户参数。每类默认一个副本，可配置 1–8。
- 消费者拒绝未启用 Celery 或 eager 模式。启用业务后按角色离线校验必需的私有配置，异常只输出固定错误码。控制队列不依赖声纹配置，保证删除／恢复可运行；关闭实名匹配时，身份队列也不依赖声纹文件，普通 AI 录音分人仍可使用它。启动校验不访问模型、ASR、数据库或对象存储。
- API／消费者按 Pod 独立使用受容量限制的 `/tmp`，同时运行同 UID 的清理进程。查询目录为 0700；独立进程每 30 秒扫描最多 100 项，只删除专用目录内已过租约及 45 秒排空期的查询残留。进程异常退出后不再依赖原任务的 `finally`；输出只有固定状态与计数，清理容器不挂载凭证。
- 原 API `extraVolumes` 遇到 Secret 会退化为空目录，现已补上 Secret 分支。启用运行配置后拒绝占用私有卷名、覆盖 `/tmp` 或私有配置目录、错误平台和不同 UID 的配置。
- API、AI API、消费者和单例 Beat 使用同一后端镜像及一致的数据库／Celery／声纹设置；拒绝池间或 Beat 覆盖产生的漂移。Beat 同样挂载私有文件及可写调度目录，并按配置版本重启。只读根文件系统应用于消费者、Beat 和清理进程；API 保留现有根文件系统策略。
- 关闭业务总开关时，Beat 不再向可选处理队列发布空任务；关闭匹配时不发布身份扫描。Redis 队列的 `expires` 由消费时处理，不能依赖它直接删除无人消费的任务。删除／恢复周期任务继续保留，以便在撤销或关闭采集后清理已有数据；这些控制任务仍须部署独立消费者。

## 配置契约

`voiceprintRuntime.enabled` 和 `voiceprintWorkers.enabled` 默认 `false`。启用消费者要求运行配置、单例 Beat、`backend.envVars.CELERY_ENABLED=true` 及 eager 关闭；启用运行配置要求真实仓库 `repository@sha256:digest` 后端镜像和外部 Secret。

| 外部 Secret 文件 | 用途及字段 |
|---|---|
| `keyring.json` | 应用加密密钥环：`active`、`keys`；独立管理、轮换及备份 |
| `encoder.json` | `url`、`api_token`、`permit_key`、`ca_bundle`；URL 为私有 HTTPS，permit key 是实际密钥字节的 Base64 |
| `encoder-ca.crt` | 与编码器 Service 主机名匹配的可信证书链；`ca_bundle` 指向此文件 |
| `quality.json` | `url`、`api_key`、`ca_bundle`；质检使用获准的 Qwen 短 ASR 路径 |
| `media.json` | `ffmpeg=/usr/bin/ffmpeg`、`ffprobe=/usr/bin/ffprobe`，精确 JSON 字段 |
| `threshold.json` | 已评审的真实校准策略；开启匹配时必需，无默认身份阈值 |

Secret 只读挂载到 `/run/voiceprint-backend`，模式 0440，API／消费者／Beat 的 UID、GID、fsGroup 默认均为 10001，可统一调整到 1000–65535。其他共享应用凭证优先使用 `backend.envVars` 的 `secretKeyRef`；使用 `*_FILE` 时，文件也必须放在这个共同挂载目录中。API 自有 `mountFiles`／PVC／`extraVolumes` 不自动给消费者或 Beat 复制，Chart 拒绝共同凭证引用未挂载路径。

业务开关仍须明确配置，基础资源启用不等于允许采集。匹配关闭时可不提供 `threshold.json`；不能把合成测试策略当作真人校准结果。开启质检也不代表允许上传真人录音。编码器 PVC、凭证、TLS 及网络策略见[编码器走查](voiceprint-linux-encoder-review-2026-10-11.md)。

以下仅是占位 values，需替换真实镜像及外部资源名称：

```yaml
backend:
  image:
    reference: registry.example.invalid/backend@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
  envVars:
    CELERY_ENABLED: true
    CELERY_TASK_ALWAYS_EAGER: false
celeryBeat:
  enabled: true
voiceprintRuntime:
  enabled: true
  configurationSecret: voiceprint-backend-private
  configurationRevision: initial
  userId: 10001
  tmpSizeLimit: 2Gi
voiceprintWorkers:
  enabled: true
  replicas: 1
```

`configurationRevision` 变更使 API／消费者／Beat 重启读取新配置。普通与 AI API 自动限定 Linux AMD64；其他自定义 nodeSelector 标签保留。消费者限制为 Linux AMD64，编码器与消费者平台必须共同验证。

## 资源与运行检查

| 每个消费者 | CPU 请求／上限 | 内存请求／上限 | 停机宽限 |
|---|---|---|---|
| 控制 | 100m／500m | 256Mi／512Mi | 210 秒 |
| 编码、质检、模板 | 100m／1 | 256Mi／1Gi | 150 秒 |
| 录音分人、实名匹配 | 500m／2 | 512Mi／2Gi | 930 秒 |

消费者使用磁盘 emptyDir，默认容量 2Gi，每个消费者 ephemeral-storage 上限 3Gi；清理进程另请求 10m／32Mi，限制 100m／64Mi。停机宽限覆盖既有任务硬期限及回收余量。以上是工程初始预算；生产并发、两小时媒体容量、节点驱逐、滚动恢复和压力数据仍须实测。

构建与离线检查：

```sh
docker build --target backend-voiceprint --build-arg DOCKER_USER=10001:0 -t backend-voiceprint:verification .
python manage.py run_voiceprint_worker --role processing --check
python manage.py run_voiceprint_worker --role identity --check
python manage.py run_voiceprint_worker --role control --check
helm lint src/helm/meet
python -m unittest deploy.aliyun.test_voiceprint_runtime_chart deploy.aliyun.test_voiceprint_encoder_chart deploy.aliyun.test_meeting_ai_chart
```

运行命令检查时须已注入独立测试环境的 Django 配置和凭证。不要将配置值或 Secret 内容放进 shell 参数、Git、values 或诊断输出。配置错误只阻止需要它的角色，控制清理仍须独立存活。API 的总体健康检查不因声纹配置失效而关闭整个应用；业务接口保留各自预检门禁。

## 验证证据与剩余项

- 最终后端组合回归 **267 passed、3 skipped，189.61 秒**，覆盖新角色启动校验／清理及编码、质检、模板、租约、维护、身份任务和默认关闭的实际调度配置。3 项跳过依赖可选的外部测试制品，不计为通过。
- 后续增加默认关闭时的周期发布门禁，**46 项专项通过，19.39 秒**；4 个全新 Celery 进程覆盖总开关／匹配开关的全部组合，验证实际调度配置、注册／路由、关闭状态不发布处理／身份任务以及删除／恢复任务保留。
- 最终 Helm 模板回归 **46 项通过，23.866 秒**，覆盖 API 双池、三类消费者、Beat、Secret、路径／权限／平台／数据库／队列漂移和既有 AI／编码器资源；`helm lint` 与 Ruff 通过。
- 本地生产后端制品已构建，Docker image ID 为 `sha256:c4703a0f13c0d707f39c87df02eded49c6bf3f4b3fa7c2669e4f114f28701e93`，UID 配置 `10001:0`，镜像大小 216663088 字节。它是本地标识，不是可直接发布的仓库 manifest digest。
- 普通 `backend-production` 目标另行成功构建，并在无网络、只读根文件系统的容器中确认不存在 FFmpeg／FFprobe；可选媒体目标不改变默认镜像的系统依赖。
- 实际 Linux prefork 消费与恢复验证使用仓库内 `deploy/aliyun/voiceprint_consumer_probe.py`：限定非 root、显式 opt-in、专用空数据库 `voiceprint_runtime_fixture`、真实 Redis／Qwen TLS、公有 encoder pack 和合成音频；ASR 仅为严格本地模拟器，匹配强制关闭。三个队列均实际消费；3 个样本完成真实 Qwen 编码及模拟质检，人工确认后生成一个加密模板；控制任务清除确认样本的原始音频。真实 SIGKILL 后，活租约未重放，等待实际到期再以第二次尝试恢复；FFmpeg 6.1.2／FFprobe 实际截取 3 秒规范 WAV，独立 janitor 清除异常退出残留。最终聚合输出为 `passed`，UID 10001，本地 ASR 共 4 次（含被中断的一次）。

Linux 探针的三个 prefork 进程及 janitor 位于同一个后端测试容器，共用 2 CPU／2Gi 限额；Qwen、PostgreSQL、Redis 位于单独容器，使用新建 internal 网络，无外部出口、无宿主端口发布。全部 fixture 容器、数据库卷、网络和临时凭证运行后删除。它证明制品／队列／租约／本地清理链路，不能替代 Kubernetes 每 Pod 权限、磁盘 emptyDir、CNI、部署更新或容量验收。重启就绪检查只使用本次启动新增的日志区间，避免旧 `ready` 记录产生假通过。

复现探针需自行制备独立 local fixture：固定后端制品、公开编码器包和测试 TLS／凭证；新建 PostgreSQL 的 `voiceprint_runtime_fixture` 空库和 Redis；注入 `DJANGO_CONFIGURATION=Production`、`PYTHONPATH=/app`、`VOICEPRINT_SYNTHETIC_PROBE=1`、Celery 异步设置及私有文件路径。仅 fixture 的声纹／质检／模板开关为 true，匹配为 false；`quality.json` URL 固定为 `http://127.0.0.1:8765/api/v1/services/aigc/multimodal-generation/generation`，其 key 使用新的测试值。探针自己启动本地 ASR 服务器。将仓库探针只读挂载为 `/probe.py`，在后端镜像中以非 root 执行 `python /probe.py`，同时提供可写 `/tmp`。禁止复用应用数据库、现有业务队列或真实 ASR 凭证；末尾聚合 JSON 必须为 `passed`，退出码必须为 0，两者共同作为结果。

本阶段没有 registry 推送、Helm 安装或集群变更。生产 sampler 的制品／凭证接入、完整 RTC／实际设备／真实媒体、可信外部删除凭据的恢复、历史检索和完整监控／发布验收继续推进；暂无获授权真人样本，不能宣称 Qwen 实名匹配准确率或生产容量达标。
