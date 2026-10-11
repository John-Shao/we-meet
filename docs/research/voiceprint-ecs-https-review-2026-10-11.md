# ECS 私有 HTTPS 编码器、Secret 权限与轮换核验

日期：2026-10-11（Asia/Shanghai）。接续[实际 CNI 走查](voiceprint-ecs-network-review-2026-10-11.md)。使用合成三秒 PCM、公开 Qwen encoder pack、临时 A／B 证书链与凭证，以及当前后端 `EncoderClient` 源码。没有真人声音、ASR、业务数据库、登记模板或身份门限。

## 部署与制品

- 独立 namespace `vp-https-probe-e2621c6f4f5d`，创建前拒绝已有名称，删除前核验两项归属标签。只渲染和应用 encoder Deployment／Service／NetworkPolicy；Secret、公共模型 PVC 和测试 caller 均新建，不修改既有工作负载或业务凭证。
- 采用实际 Chart 的 `Recreate`、UID/GID/fsGroup 10001、只读根、Secret 模式 0440、只读模型卷、HTTPS 健康探针及默认无出口的 encoder NetworkPolicy。短期 encoder 请求改为 250m CPU／512 MiB，上限保持 2 CPU／2 GiB；caller 请求 50m／128 MiB，上限 250m／256 MiB，总请求 300m／640 MiB。生产 1 CPU／1 GiB encoder 请求未据此降低。
- caller 只允许到本 namespace encoder TCP 8093 和 `kube-system` CoreDNS TCP／UDP 53 的出口，没有公开端口。实际使用 `https://<encoder-service>.<namespace>.svc:8093` 经 DNS 和 ClusterIP 调用，未添加 hostAliases 或关闭证书校验。
- 两个 Pod 使用同一离线镜像，实际运行 image ID 为 `sha256:af73394bce7c35753529250904621abde59daa3b141721e3c94b9fd0c8eab67d`；本地原 ID 为 `sha256:c68c772feb1a9914bbe1b0f52f89e84051abec61e1a326b98e1782da0ef0063a`。归档 368,647,766 字节，SHA-256 `6610bb4bdd22d3164f0ec6e4d85ef67585f70982b88b94cd513d869ae206bd1e`。模型 SHA-256 继续为 `f8b8aa2a5a7e7ddc9043b4979a07bbefca13bfd402a0464a19c1974ea1f6a71a`，传输及载入均核验。
- 后端 transport 单文件只读挂载为内部 `core.services.voiceprint_encoder`；规范化 SHA-256 `76d1f18ac2bf9c162094b65cece33b81ea53a61128062d175c0a7be5bf4bb2fb` 与当前工作树一致。该模块不初始化 Django，也不替代 API／consumer 的业务授权与发布复核。
- client 探针 SHA-256 `80859c589807b3f0d310802b8a569ad676748c2938d0bdaa3ad0753de48847df`；实际 ECS 执行时编排探针 SHA-256 `9c7e94a10da3eda8e82d2148c19b7efeb48856e313742a8cb6409a3d9bda86c3`。凭证仅在测试 Secret 和私有传输目录中，不进入 ConfigMap、argv、日志或 Git；ConfigMap 只含公开代码。

## 实际 A／B 两阶段结果

| 项目 | 结果与范围 |
|---|---|
| CA／主机名 | 两阶段均使用可信 CA 与 Service DNS 成功；错误 CA、以 ClusterIP 作为主机名均抛出证书校验错误 |
| 未授权 | 两阶段不带 token／permit 的请求均为 401 |
| 真实后端 RPC | `EncoderClient.extract` 两阶段均通过，有限 1024 维单位向量及固定特征空间检查通过；单次耗时约 176.05／166.39 ms，不计算 P95 或生产容量 |
| 重放 | 每阶段同一许可第一次 200，第二次 409；与后端 RPC 合计四次成功推理，其中两次经过实际后端解码／向量契约检查 |
| Secret／模型内核权限 | caller Secret 为 0440、GID 10001、只读；两个 server Pod 的四份 token／key／TLS 文件均为 0440、GID 10001，UID 10001，实际模型和凭证挂载只读 |
| 协调轮换 | 更新 encoder TLS／凭证 Secret，再修改 `configurationRevision`；`Recreate` 后 server Pod UID 改变，新 B 凭证完成真实 RPC |
| 旧凭证拒绝 | 在可信 B CA 下，旧 A token 请求为 401；新 B token 配旧 A 签名 key 为 403。旧 A CA 也不再信任 B 服务证书 |
| 指标 | HTTPS `/metrics` 的缓存策略为 private／no-store；正文不含测试 token／key、向量或音频摘要字段 |

两个 server Pod 均位于 `lavm-emzsrnxdeh`，资源字段与上述短期预算一致。模型 PVC 为专属 1 GiB `local-path`，写入前核验 claim UID、namespace 和 provisioner 根路径；未递归操作共享模型目录。

此次证明的是单实例编码器 RPC 与协调重建轮换，不证明热更新即时生效、零停机、跨副本全局 nonce 幂等、外部密钥服务、完整 Django／队列／RTC 链路或真人身份效果。当前节点完整生产预算及第 15 节准入继续保留。

## 发现、修复与服务端验证

首轮探针误在 Deployment Pod 模板加入 `activeDeadlineSeconds`，在创建 listener 前失败并清理。该字段被 [Kubernetes v1.36.2 的 Deployment／ReplicaSet 校验](https://github.com/kubernetes/kubernetes/blob/v1.36.2/pkg/apis/apps/validation/validation.go)禁止。本次修正只涉及测试编排；Chart 原模板没有该字段。

复验在目标 API server 先用带该字段的变体执行 dry-run，确认拒绝，再验证修正后的 Deployment dry-run 成功，随后完成两阶段调用。caller 是独立 Pod，仍使用有效的 Pod deadline；所有 RPC、rollout 和清理等待有界。编排进程及其资源清理必须纳入操作者监督，不能把 Deployment 当作带自动过期的 Job。

临时 PKI 在本地相同生产镜像中另行验证过可信链成功、错误 CA／主机名拒绝。证书使用真正 CA／server 两级链、Service DNS SAN 和一日期限，不复用业务证书；该本地结果不与 ECS 结果混为同一测试。

最终代码检查另修复 CLI 将 `failed` 回执以退出码 0 输出的问题：现在失败返回 1、成功返回 0，两项 CLI 回归通过。此改动不改变 ECS 编排或 transport；未重新部署。修正后的编排源码 SHA-256 为 `b06fee4a951dc938ddeb0ab71df2b216ad5ee0f2c38149b318cf9d43e0de3d13`，与上述实际执行版本区分记录。三份探针／回归文件的 Ruff 检查和格式检查通过。

## 清理、复验与剩余范围

最终回执为 `passed`，namespace、专属模型 PV、唯一导入镜像引用和私有传输目录全部清理。没有 registry 上传、全局 prune、业务 namespace 改动或真人采集。私有原始结果：`work/voiceprint-ecs-https-{initial,result}-2026-10-11.json`、`voiceprint-https-local-chain-result-2026-10-11.json`。

本地十份临时 A／B 证书与凭证文件、对应镜像归档及唯一测试镜像引用也已删除；保留测试回执和公开模型缓存，原发布镜像保持可用。四份相关文档的 85 个相对链接存在性检查通过。

入口：[voiceprint_https_ecs_probe.py](../../deploy/aliyun/voiceprint_https_ecs_probe.py)、[voiceprint_https_client_probe.py](../../deploy/aliyun/voiceprint_https_client_probe.py)。复验需先创建带唯一 task ID 归属标记的受控私有 stage、离线镜像、固定公开模型包、临时 A／B PKI／凭证及经过审核的 JSON task；只应用 task 中 encoder 三份资源。CLI 在受控 k3s 权限下执行 `--task-file`，不接收真人音频或业务凭证。复验必须同时核对退出、两阶段状态、源码／模型摘要及全部清理回执。

完整消费者、API／对象存储／独立日志协作、持续并发与端到端延迟、真实设备、授权真人数据和校准门限仍需验收；不会因本次 transport 通过而开启业务采集或发布身份建议。
