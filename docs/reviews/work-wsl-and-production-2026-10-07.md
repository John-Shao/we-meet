# WSL 验收与生产执行器决策

环境确认：本地 WSL 用于开发和测试；京东云主机用于生产。生产连接凭据仅用于交互式 SSH/sudo 认证，未写入仓库、配置或回执。本轮生产操作全部为只读查询，没有发布、更改节点或启动生产任务。

## 生产只读库存

生产主机为 Ubuntu，内核 `6.8.0-53-generic`；Docker `29.6.1` 可用，Docker 自身运行容器数为 0。K3s 集群只有一个 Ready 节点，版本 `v1.36.2+k3s1`，节点运行时为 containerd；后端、数据库、Redis 和多个现有业务 agent 正在该节点运行。没有 `work-agent=dedicated` 标签或同名污点。两个预定 agent 状态目录尚不存在；cert-manager 已部署。

Docker 的空闲不代表这台主机是独占 runner，因为业务由 K3s/containerd 承载。现有 Docker chart 的专用节点要求在该主机不成立。没有读取生产模型 Secret、TLS 私钥或业务数据；TLS、registry、备份和网络策略仍需后续检查。

## 本地独立 daemon 验收

本地 WSL2 `Ubuntu-22.04` 的 Docker client 当前连接 Docker Desktop，不运行原生 dockerd 服务。因此启动一个临时独立 Docker-in-Docker 实例，私有网络为 `none`、仅开启 Unix socket，不映射 Windows 端口，也不挂载外层 Docker socket。它验证独立 Linux 网络命名空间中的 host-network 路由，不能替代物理生产节点的整体验收。

daemon 镜像为官方 `docker:29.5.3-dind` 的固定 amd64 manifest：`sha256:d312be976e29a556e97100aa16564773ecc31f52cccf73fb95c06127b291ffad`。该测试按 [官方 DinD 用法](https://hub.docker.com/_/docker) 使用 privileged 容器，仅用于本机临时夹具；生产选定方案不会使用此夹具。

Gateway、Pi、dsh 使用 [上一批固定镜像](work-node-check-2026-10-07.md)。离线 save/load 丢失仓库 digest 引用后，在独立实例内部启动 loopback registry，核对镜像 Config 和 RootFS layers 未变，再固定内部 digest；三个 digest 与源镜像一致。真实执行 [仓库回归](../../deploy/aliyun/test_work_node_docker.py)，4 项通过，包括 2 项夹具边界和 2 项真实 worker 测试。

Pi `1.0.4` 与 dsh `0.1.5rc1` 的只读检查、独立 Linux host-network 路由、任务挂载、临时鉴权、只读根目录和版本故障均通过。没有 Desktop 端口转发。没有启动 agent CLI 或调用模型，模型调用数 0。合成 Inbox 标记未变；临时 daemon、其数据卷、内部 registry 及任务容器已清理。原始回执与本机运行脚本位于 Git 忽略的 `.work-acceptance/work-wsl-native-20261007/`；[公开摘要](work-wsl-and-production-2026-10-07.json) 从实际回执核对生成。

## 用户选择的下一实现

用户明确选择适配现有 K3s 的任务容器执行，沿用当前生产主机。新增 Kubernetes 执行器，继续保留 Docker/桌面执行路径和 `work-agent/v1`，业务与 dsh/Pi 仍独立更新。

Gateway 使用持久 PVC，任务使用独立 namespace、非 root Pod、临时目录和固定镜像；Gateway 以限定 namespace 的 RBAC 创建/查询/删除任务 Pod，任务自身不挂载 ServiceAccount token。材料与结果通过任务级短期凭据和 HTTPS 交付，不共享完整 Inbox、不挂载宿主机目录或 Docker socket；实际模型 key 仍只在 Gateway。默认关闭新执行路径，先在本地独立测试集群完成验证，再准备生产候选。

任务不使用自动重试控制器，取消、超时、Gateway 重启及创建应答丢失须保留原 UUID 和未知执行语义；任务网络仅允许 DNS 与 Gateway 的任务/模型入口。namespace/RBAC、网络策略实际阻断、TLS、持久状态和资源上限必须通过验收，不能只以 Helm 渲染成功作为上线依据。参考 [ServiceAccount](https://kubernetes.io/docs/concepts/security/service-accounts/) 与 [NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/) 官方说明。
