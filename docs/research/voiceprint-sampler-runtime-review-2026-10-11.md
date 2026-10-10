# 独立声纹采样服务运行与部署走查

日期：2026-10-11（Asia/Shanghai）。本阶段补齐独立制品、凭据文件、进程预算、健康接口、日志边界与 Helm。默认关闭，未部署生产、推送镜像、访问真实房间、调用收费 ASR 或录制真人声音。

## 行为与修复

- 独立入口支持 `start` 与离线 `--check`，拒绝 `dev`、`console`、`connect`；调用固定 SDK 的公开 `AgentServer` 生命周期，不经过可能打开麦克风的通用 CLI。
- 修复 Windows 信号回退清理：只移除已成功安装的循环信号，恢复原生处理器。部分启动和关闭失败仍回收任务、监听器与信号，取消的等待任务始终被等待。
- LiveKit key／secret、采样 token 支持同名 `*_FILE`，绝对路径、有界读取、可见 ASCII、禁止重复来源；采样 token 不得与 LiveKit key／secret 或普通 agent token（含文件来源）重用。配置错误固定码，凭据／URL 不进入 `repr`。
- 后端 HTTPS 可加载显式 CA 文件，限 1 MiB、单次读取，保留主机名与证书校验；配置错误不回退到关闭验证。后端请求继续禁止环境代理、重定向、自动解压和 Cookie。
- 每房间独立子进程，无预热池、无主机 CPU 推导并发；每副本 1–8 房间，每子进程 128–2048 MiB，默认 1／256。SDK 待接收任务的保留容量也参与限制。
- 总开关与采样开关同时启用才接收任务。逐轨许可与持续复验继续保留；参与者可见，不允许发布媒体／数据／修改 metadata。内存短片段、有界队列、溢出整段丢弃与擦除不变。
- 私有 TCP 8094 健康与四项无标签指标不含身份、房间、凭据；`/worker` 不存在，SDK HTTP 绑定 loopback 8081。就绪要求已注册且未断连／关闭／排空，不表示允许采样。状态依赖 SDK 1.4.5 私有字段，缺失时拒绝就绪，升级须重做原生验证。
- 日志只有 `sampling_sdk_event` 与 `info|warning|error`，丢弃消息、参数、异常栈与 extra。SIGTERM 排空 45 秒，关闭最多 10 秒，Pod 宽限 60 秒。

## 制品与部署契约

`src/agents/Dockerfile.sampler` 默认目标 `production`，另有 `verification`；Python 3.13.13 slim、uv 0.10.9，依赖锁强制哈希。直接依赖 aiohttp 3.13.5、LiveKit RTC 1.1.2、Agents 1.4.5，约束来自项目 `uv.lock` 的普通依赖闭包。无可选转写插件、Torch／CUDA、Silero 或 Qwen 权重；SDK 自身间接依赖仍保留，不能把它理解为没有任何供应商 SDK 包。

```powershell
# 在 src/agents 下，只构建／验证本地制品，不推送仓库。
docker build -f Dockerfile.sampler --target verification -t we-meet-voiceprint-sampler:verification .
docker run --rm --network none we-meet-voiceprint-sampler:verification
docker build -f Dockerfile.sampler -t we-meet-voiceprint-sampler:local .
```

APT 支持 `APT_MIRROR`，增加有限重试／连接超时。首次默认 Debian 主索引下载明确报连接失败，终止该失败构建后用国内镜像源完成。依赖锁须在含 Python 的 Linux 环境更新，纯 uv 镜像缺少 libc 发现工具，不能用于以下命令；更新版本／约束后须重跑容器测试和原生探针。

```bash
uv pip compile requirements-sampler.in --constraint constraints-sampler.txt \
  --python-version 3.13 --python-platform x86_64-manylinux_2_28 \
  --generate-hashes --no-header --output-file requirements-sampler-linux-py313.lock
```

`voiceprintSampler.enabled` 默认 `false`，要求私有运行配置、三个消费者、非 eager Celery 与单例 Beat。独立镜像必须用真实仓库不可变 digest。独立 `credentialsSecret` 提供 `api-key`、`api-secret`、`sampling-token`，sampler 只读挂载这三个文件；API／AI API／Beat／三个消费者引用同一 `sampling-token` Secret，禁止 token／agent name 漂移。

Pod 固定 Linux amd64、UID／GID／fsGroup 10001、无 ServiceAccount token、只读根、无提权、丢弃 capabilities、RuntimeDefault seccomp、64 MiB 内存 `/tmp`、Recreate 更新。默认每副本 CPU 上限 1、内存上限 `512 + maxRooms × jobMemoryMb` MiB（默认 768 MiB），为起始预算，不是生产容量结论。

默认 NetworkPolicy 禁止入站，可给监控显式放行 TCP 8094；出站仅默认允许集群 DNS 和本 release 后端目标端口，必须填精确 LiveKit 信令／RTC／TURN `additionalEgress`。自定义后端网关、NodeLocal DNS、Service DNAT／真实 CNI 仍需按实际环境配置验收，无默认公网全放行。受控内部网络支持 HTTP／WS，生产 TLS 与传输范围按环境选择。

`backendCASecret` 的 `ca.crt` 仅用于后端 HTTPS，不是 LiveKit WSS 私有 CA；后者使用系统信任链，私有 CA 接入尚未验证，不得关闭证书校验替代。

## 验证证据与边界

- Windows 源码 sampler／配置／运行 28 项通过（5.255 秒），其他通用入口 3 项通过（1.935 秒）；独立入口包含实际模块执行测试。
- Linux verification 镜像在断网、只读根、10001:10001、1 CPU／768 MiB、64 MiB 临时卷下，28 项通过（4.331 秒），覆盖双开关、Secret、令牌复用、隐私输出、真实 SDK 参数、HTTP 状态、部分启动与信号清理。
- 编码器／私有配置／sampler 的真实 Helm 渲染组合 28 项通过（13.313 秒）；覆盖默认关闭、后端共用 Secret、开关、不可变制品、资源、CA、平台、配置漂移、网络策略。未连接集群。
- 本地生产镜像 `we-meet-voiceprint-sampler:feature-20261011`：`sha256:8f6ff029b213d4c0ec92609f2f4446323415f9c66f0858bc7e768353bf61ed44`，143,511,081 字节。实际 UID／GID 10001；依赖符合锁，Torch／Silero 不存在。此为本地证据，不是已上传仓库的部署引用。
- 原生探针 `deploy/aliyun/voiceprint_sampler_probe.py` 使用本地 LiveKit server 1.13.1、Redis、真实 sampler 与两个合成发布者，专用 Docker internal 网络、无宿主端口。许可服务器为受控 fixture；音频真实经过 RTC／Opus／PCM，验证 3 秒、72,000 帧、24 kHz 单声道 16 bit WAV 上传；无许可发布者未被订阅，第二段在实际 PCM 开始后撤权且未上传；第二房间未突破容量 1，房间结束后活跃任务归零。
- 检查 sampler 可见且不发布媒体／数据／metadata、HTTP 无 SDK 枚举、父子 SDK 日志只有固定事件与级别、SIGTERM 正常退出。前两次 fixture 禁用发布者 `can_subscribe`，失败于 RTC 连接；允许正常参与者订阅权限、仍关闭自动订阅后通过。只调整测试发布者，未放宽 sampler 逐轨许可。

上述原生合成证据不等于可信 webhook、本人声明、派发恢复、加密候选、Qwen 质检及设备模板的完整 RTC 端到端同时通过。下一步仍需连接这些已有组件，并完成真实 Web／Android 设备、静音／轨道替换／重连／中断、私有 TLS／CNI／集群资源、监控与容量、历史版本／搜索、可信外部删除墓碑备份恢复和获授权真人校准。当前无真人样本；完整目标保持不变，不宣告完成或生产启用。
