# ECS 上的 Qwen encoder CPU 与只读模型卷走查

日期：2026-10-11（Asia/Shanghai）。接续[交付走查](voiceprint-delivery-audit-2026-10-11.md)。使用用户提供的 ECS、独立测试 namespace、固定生产镜像、公开 encoder 权重和合成 FM 信号；没有采集真人声音、登记模板或调用云端 ASR。

## 制品与隔离条件

- 本地生产镜像 `we-meet-voiceprint:feature-20261011` 的 ID：`sha256:c68c772feb1a9914bbe1b0f52f89e84051abec61e1a326b98e1782da0ef0063a`。通过唯一测试镜像引用导出、SSH 传输及 containerd 导入，没有上传 registry。
- 镜像压缩归档 368,647,767 字节，SHA-256 `4c243aaf57cb9a7dd6cd57d014d84dcd1c546c356bb69ff223219d3e034b6881`；服务端导入前逐字节核对。两次实际 Pod 的运行镜像 ID 均为 `sha256:af73394bce7c35753529250904621abde59daa3b141721e3c94b9fd0c8eab67d`。Docker 源 ID 与导入后运行 ID 分别记录，未将两种导出格式的摘要直接等同。
- encoder 权重 SHA-256：`f8b8aa2a5a7e7ddc9043b4979a07bbefca13bfd402a0464a19c1974ea1f6a71a`；实际 encoder 源文件规范化摘要与工作树一致：`55d3aea4b6d0df2ebb4b0bf01975b462e875db121cd6a8d508bdcbd0c92c7835`。源码／依赖／manifest 的内置完整性检查通过。
- 测试 namespace `vp-encoder-bench-4e0ad8324002`；两个 Job 串行，每个请求 250m CPU／512 MiB，上限 2 CPU／2 GiB，deadline 120 秒、零自动重试。未缩放或修改现有业务工作负载。
- UID/GID 10001，禁止提权、只读根文件系统、丢弃全部 capabilities、RuntimeDefault seccomp、禁用 ServiceAccount token 自动挂载；设置拒绝进出流量的 NetworkPolicy。没有服务监听或公开入口；本轮没有独立的 CNI 正反对照测试。
- 使用 `local-path` 创建专属 1 GiB PVC；将两份公开模型文件放入经 claim UID、namespace 和 provisioner 根路径核对的专属 PV。模型挂载只读，内核 `statvfs` 只读标志在两个 Pod 内均为 true。临时缓存为有界 64 MiB 内存卷。

探针 [voiceprint_encoder_resource_probe.py](../../deploy/aliyun/voiceprint_encoder_resource_probe.py)无需生产镜像中不存在的 psutil。它只生成合成 PCM、验证有限 1024 维单位向量并输出聚合资源结果，向量及 WAV 不进入日志。通过 `/proc/self/cgroup` 定位自身 v2 层级，兼容 Docker 私有层级与 Kubernetes 挂载布局；实际 `cpu.max=200000 100000`、`memory.max=2147483648`。

## 实际结果

ECS 4 个逻辑 CPU、Linux x86_64；Python 3.13.13、Torch 2.10.0+cpu、numpy 2.2.6、librosa 0.11.0。每个线程设置为独立 Pod，每种 3 秒／10 秒片段执行 4 次：首次单列，其余 3 次计算中位数／最大值。两个 Pod 共 16 次提取，重复输出最大绝对差为 0，有限单位向量检查全部通过。

| Torch 推理线程 | 3 秒输入：首次／预热中位／预热最大 | 10 秒输入：首次／预热中位／预热最大 | 进程峰值 RSS | cgroup memory.peak |
|---|---|---|---|---|
| 1 | 369.86／93.64／113.82 ms | 298.09／210.53／215.84 ms | 474.18 MiB | 441.05 MiB |
| 2 | 76.34／51.34／51.48 ms | 177.33／132.63／151.83 ms | 500.98 MiB | 344.88 MiB |

1 线程 Pod 的模块导入 6.592 秒、encoder 加载 7.281 秒、探针总计 15.531 秒；2 线程分别为 3.867／3.759／8.498 秒。加载计时排除模块导入。线程设置还保留生产镜像中原有 BLAS 环境预算，不表示整个进程仅有 1／2 个系统线程。

进程 RSS 与 cgroup 计费峰值口径不同，不能互换为生产内存限额。第二个 Pod 运行在第一个之后，页面／文件缓存、共享页归属及背景负载会影响数值；没有清空节点缓存，不能称为可重复的冷启动对照。当前样本仅为短期单任务描述统计，不提供 P95、稳态吞吐或安全并发数。

节点 `top` 测量前为 409m CPU／7,200 MiB，后为 947m／7,364 MiB；这些有时延的节点采样包含其他工作负载，不能证明现有转写在竞争情况下仍满足 SLA。

## 调度失败与部署预算

初次尝试诊断不完整，仅记录校验失败，不能将其归因为模型效果或模型不兼容。补齐诊断后的 500m CPU 请求明确收到 `FailedScheduling: Insufficient cpu`；PVC 随之等待 Pod 调度，模型尚未启动。对应失败结果与清理记录保留，不计入成功探测。

独立只读容量核验显示节点 allocatable CPU 为 4，现有请求为 3,650m（91%），limits 共 6 CPU（150%）；内存请求 7,334 MiB、limits 15,594 MiB。低实时利用率不能替代剩余调度额度。

最后仅将短期测试请求改为 250m，仍保持原 2 CPU／2 GiB 上限，并串行运行，得到上述结果。**250m 是本次短期探针请求，不是生产资源建议。** 当前 Helm encoder 的 1 CPU／1 GiB 请求及 2 CPU／2 GiB 上限继续保留；编码器再加三个消费者／sampler 的完整预算需要安排可用节点或经负责人批准重新分配，不能在现有 350m 剩余额度下宣布可以部署。

这次验证支持继续使用 CPU Qwen 路线，尚无转向 CAM++ 的模型效果依据。它没有覆盖 5 秒输入、GPU、多人实际音频、模板规模、并发排队、长时间资源增长、HTTP／TLS 服务预热或真实 ASR 链路；第 6.4／15 节剩余准入继续保留。

## 清理与复验

实际回执确认测试 namespace、专属模型 PV、导入的测试镜像引用及私有传输目录均已删除。没有全局 prune 或删除共享缓存层；没有修改既有业务 namespace／PVC／资源请求。

私有产物：`work/voiceprint-ecs-resource-bench-final-2026-10-11.json`、`voiceprint-ecs-resource-bench-{initial,pvc}-2026-10-11.json`、`voiceprint-ecs-cpu-allocation-2026-10-11.json`。测试密码与对象存储凭据不进入这些产物或 Git。

在已核准的隔离 Linux 容器中复验，挂载审核过的模型目录与本仓库探针：

```text
python /probe.py --model-dir /model --encoder-sha256 f8b8aa2a5a7e7ddc9043b4979a07bbefca13bfd402a0464a19c1974ea1f6a71a --threads 1
python /probe.py --model-dir /model --encoder-sha256 f8b8aa2a5a7e7ddc9043b4979a07bbefca13bfd402a0464a19c1974ea1f6a71a --threads 2
```

每条命令使用新的 UID 10001 容器，模型只读、无网络、CPU／内存有界。线程比较需注明执行顺序、资源请求、运行上限及节点背景负载。身份效果准入仍需要授权真人样本、设备／会话隔离评测与门限校准。
