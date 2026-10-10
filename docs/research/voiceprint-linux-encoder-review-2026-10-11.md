# Qwen Linux CPU 编码器镜像与部署资源走查

日期：2026-10-11（Asia/Shanghai）。范围：feature 分支的私有编码器运行环境、聚合指标与 Helm 资源。未部署生产、上传镜像仓库、采集真人声音或调用收费 ASR。模型路线仍为 Qwen 优先。

## 变更与发现的问题

- 新增 Linux AMD64 CPU 镜像，Python 3.13.13、uv 0.10.9、Torch 2.10.0+cpu。生产／测试依赖分别在 Linux 中编译生成哈希锁，不含 CUDA／nvidia 依赖；安装本地代码不重新解析依赖。构建上下文排除模型、音频、密钥及虚拟环境。
- 生产镜像使用 UID/GID 10001，固定计算线程数，离线加载模型，临时缓存写入 `/tmp`。模型、凭证和证书在外部只读挂载，镜像不打包这些内容。
- 初次测试镜像的 `uv pip sync` 移除了不在依赖锁内的本地项目包：主进程能从当前目录导入，按脚本启动的子进程却无法导入。修复为同步后重新安装固定本地代码；测试镜像也使用 UID/GID 10001。原有故障、超时、清理断言均保留并通过。
- Linux 子进程归属于启动它的线程。初次生产探针只读取主线程的 `/proc/.../children`，误报未找到模型进程；修正为遍历服务所有线程并合并子进程集合。退出验证仍要求模型进程完全消失，不接受仅成为 zombie。
- 新增 `/metrics`：ready、active、uploads、固定四类请求结果计数及累计请求耗时。不读取正文或触发加载；不带身份、组织、令牌、nonce、摘要或向量标签，响应禁止缓存，未新增访问日志。
- 新增默认关闭的 `voiceprintEncoder` Helm Deployment、私有 HTTPS ClusterIP Service、NetworkPolicy。要求不可变镜像引用、Linux AMD64 节点、独立 Secret，校验线程／副本预算，限制权限、资源与临时存储，区分 startup／readiness／liveness。

## 实际验证

| 验证 | 结果与范围 |
|---|---|
| Windows 服务与指标回归 | 21 项通过，包含成功、拒绝、重放、忙碌与隐私指标 |
| Linux 完整编码器测试 | 84 项通过，16.83 秒；加载固定公开模型，包含复用／恢复、真实 HTTP 后端契约、故障及父进程退出保护 |
| 精简生产镜像探针 | HTTPS 证书验证、未授权拒绝、真实后端 EncoderClient、1024 维单位向量、重放 409、指标及 SIGTERM 后模型进程完全回收均通过 |
| Helm 实际渲染回归 | 编码器 10 项及现有 meeting AI 26 项通过，覆盖默认关闭、镜像、私有挂载、权限、预算、探针、隔离及轮换版本 |
| 静态检查 | 变更 Python lint／格式、Helm lint 及差异检查通过 |

Linux 测试和生产探针均使用非 root、只读根文件系统、断网、丢弃所有 capability、no-new-privileges、64 个 PID、2 CPU／2 GiB 上限、64 MiB 临时挂载。只使用合成信号和公开模型；凭证／证书为临时本地测试生成，输出仅含固定状态和聚合数值。未接入业务数据库、用户录音、外部模型服务或生产环境。

生产镜像一次冷启动至 ready 为 4.377 秒，第一次后端 RPC 为 0.066 秒，容器 cgroup 内存峰值为 364847104 字节（约 348 MiB）。这是 Docker Desktop Linux VM 中单次三秒合成信号的数据，**不能作为真人效果、吞吐量、P95 或生产容量结论**。

本地生产 image ID：`sha256:c68c772feb1a9914bbe1b0f52f89e84051abec61e1a326b98e1782da0ef0063a`，镜像大小 371670607 字节。它是本地构建标识，不能作为镜像仓库 manifest digest 填入部署配置。

复现入口：`src/voiceprint/Dockerfile`、两份 `requirements-*-linux-py313.lock`、`tests/linux_runtime_probe.py`、`deploy/aliyun/test_voiceprint_encoder_chart.py`；命令见[编码器 README](../../src/voiceprint/README.md)。uv 使用固定版本的官方 Docker 镜像形式，参考[官方 Docker 集成文档](https://docs.astral.sh/uv/guides/integration/docker/)。

## 部署配置与密钥契约

`voiceprintEncoder.enabled` 默认 `false`。开启基础服务不会开启后端采样、积累、质检、模板或匹配，也不代表用户授权。启用前准备同一命名空间内的外部资源，Chart 不生成其内容：

1. **公开模型 PVC**：离线制备的 `encoder.safetensors` 和 `manifest.json`；`modelSubPath` 可选 pack 子目录。`meet-voiceprint-prepare` 校验完整来源模型并提取，运行时检查固定 encoder SHA-256。确保 UID/GID 10001 只读可访问，并在目标 CSI 验证权限／fsGroup。
2. **凭证 Secret**：键为 `api-token`、`permit-key`，两个值不同且来自独立随机值。Token 为 32–256 字节可见 ASCII，permit key 为 32–4096 字节。建议两份独立随机 ASCII 值，避免二进制首尾空白与文件读取的 `strip()` 语义产生差异。不复用 Django、普通 agent 或采样凭证。
3. **TLS Secret**：键为 `tls.crt`、`tls.key`，SAN 匹配实际 Service DNS，最低 TLS 1.2。TLS Secret 与凭证 Secret 名称必须不同；后端验证 CA 和主机名。
4. **后端私有配置**：另行 Secret 挂载精确 JSON 字段 `url`、`api_token`、`permit_key`、`ca_bundle`，通过 `MEETING_VOICEPRINT_ENCODER_CONFIG_FILE` 指向它。`url` 为私有 HTTPS Service，`permit_key` 是编码器实际读取密钥字节的 Base64 表示，`ca_bundle` 为可信 CA 文件绝对路径或 `true`。CA 只读挂载；不关闭证书验证或使用环境代理／重定向。

不要将凭证写入 Helm values、命令行、ConfigMap、日志或 Git。Chart 只接收资源名称。后续业务消费者与私有配置接入见[消费者运行走查](voiceprint-consumer-runtime-review-2026-10-11.md)；外部资源供应和生产发布仍需部署验收。

以下仅为 **values 示例**，占位镜像和资源不存在，不能直接发布：

```yaml
voiceprintEncoder:
  enabled: true
  imageReference: registry.example.invalid/encoder@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  credentialsSecret: voiceprint-encoder-private
  tlsSecret: voiceprint-encoder-tls
  modelClaim: qwen-encoder-pack
  configurationRevision: initial
```

先运行 `helm template`／`helm lint` 并检查实际资源，再使用镜像仓库返回的真实 manifest digest。生产发布另行验收；本轮未运行 `helm install`、`helm upgrade` 或集群写入。

## 预算、隔离、轮换与观察

- 默认一个副本、两个计算线程，requests 为 1 CPU／1 GiB，limits 为 2 CPU／2 GiB，内存临时卷 64 MiB。线程／副本限定 1–8；每服务一次推理，最多两个并行上传。`Recreate` 控制更新预算但会产生不可用窗口，后端使用既有有限重试／租约。这是技术验证预算，真实容量仍需测量。
- NodeSelector 限定 Linux AMD64，未验证 ARM64 或其他 Python／Torch 组合。变更锁、模型、平台或预算后须复验实际模型与故障行为。
- NetworkPolicy 只允许同命名空间／同 release 的 backend、backend-ai、celery-voiceprint Pod 访问 TCP 8093，拒绝编码器全部出口；编码器不需要 DNS、模型下载、ASR 或对象存储。目标 CNI 必须支持策略，其他同时选中 Pod 的允许策略可能扩大有效权限，须在集群验证。
- 指标采集器通过 `networkPolicy.additionalPeers` 添加精确 namespace／Pod selector，并以可信 CA HTTPS 采集。指标无额外应用鉴权，依赖私有网络隔离；不要公开 Service／Ingress 或添加宽泛空 peer。目前未生成 ServiceMonitor／生产告警规则。
- 更新 Secret 后递增 `configurationRevision`，重启加载内存中的 token、permit key、TLS。轮换需协调后端配置和在途租约／旧许可；重启／多副本的全局幂等仍依靠业务 generation、持久租约及提交复核，不能只依靠单进程 nonce 缓存。
- startup／ready 检查模型可用性，live 只检查 HTTP 进程，避免恢复期间反复杀进程。Kubernetes HTTPS 探针不替代调用客户端的证书验证。关注持续 warming、503／超时、活动请求滞留、重启及业务队列，不添加实名／音频／向量标签。

## 剩余工作

独立编码器镜像／资源及基础指标已完成，整个生产部署尚未完成。持续处理见[调度走查](voiceprint-processing-scheduler-review-2026-10-11.md)；消费者资源、后端 ffmpeg／ffprobe 制品、统一 Secret 挂载及独立临时文件清理后续见[消费者运行走查](voiceprint-consumer-runtime-review-2026-10-11.md)。仍需采样 agent 制品与私有凭证、生产指标／告警、实际 RTC／设备、历史版本／搜索、外部可信墓碑的备份恢复验证。目标集群的 CNI、PVC、轮换、硬限额及压力测试尚未验收。

暂无获授权真人样本，不宣称准确率达标或开启自动身份归属；Qwen 不满足既定效果要求时再考虑 CAM++。这些限制不改变继续完成代码与技术验证的授权。
