# ECS 编码器 NetworkPolicy 的实际连通与拒绝核验

日期：2026-10-11（Asia/Shanghai）。补充[交付走查](voiceprint-delivery-audit-2026-10-11.md)中的目标 CNI 证据。使用 Chart 实际渲染的默认 encoder NetworkPolicy／ClusterIP Service，以及独立 namespace 内的合成 TCP listener；没有部署业务编码器、加载模型、使用录音或接入既有业务服务。

## 制品、权限与隔离

- namespace：`vp-network-probe-d1198f42f04d` 和 `vp-network-probe-d1198f42f04d-outside`，创建前拒绝已有名称，删除前重读两项归属标签。不修改 `meet` 或其他现有 namespace、工作负载、Secret、PVC 或节点策略。
- 使用离线生产镜像 `we-meet-voiceprint:feature-20261011` 的独立测试引用，仅执行 `/usr/local/bin/python` 标准库 TCP listener／连接探针，覆盖 Docker entrypoint。未上传模型包、创建 TLS／业务凭证或拉取 registry 镜像。
- 本地 image ID `sha256:c68c772feb1a9914bbe1b0f52f89e84051abec61e1a326b98e1782da0ef0063a`；传输归档 368,647,768 字节，SHA-256 `9fa6d974b4737f7a3030f03e508b63fa1ebe0c676afd6e7ae5a83852f8cbda52`；导入前核验。实际运行 image ID 为 `sha256:af73394bce7c35753529250904621abde59daa3b141721e3c94b9fd0c8eab67d`，与此前 encoder 资源走查一致。
- 三个 Pod 每个请求 20m CPU／32 MiB，上限 100m／96 MiB，总请求 60m／96 MiB；各 namespace 另有 ResourceQuota，Pod deadline 240 秒。此预算只供 TCP 探针，不是编码器资源建议。
- 独立只读快照确认三个 Pod 同在 `lavm-emzsrnxdeh`、Running／Ready、UID/GID 10001、RuntimeDefault seccomp、只读根、禁止提权、丢弃全部 capabilities、禁用 ServiceAccount token 自动挂载；实际资源字段与上述预算一致。
- 探针规范化源码 SHA-256：`ab02f5753d5c112de6082b078ad4d431317f57d303663fa2c74585710dcf8709`。渲染策略的规范 JSON SHA-256：`d3d2b3559367c1def8118620ebe810a96babcee322a7a421f72e88ebac78f28a`；安装后重新核验 spec，空 egress 的 API 省略形式规范化为 `[]`。

## 实际结果

每个场景建立三个新连接，使用数值 IP，连接超时 1.5 秒；不复用已有 TCP 会话。先做无策略基线，再安装策略；切换 caller 标签后等待 2 秒。最终恢复合法标签并再次验证允许访问，避免把 listener 停止当作隔离成功。

| 场景 | 路径与检查数 | 结果 |
|---|---|---|
| 无策略基线 | 同 namespace／其他 namespace 到 PodIP／ClusterIP，共 12 次；其他端口与 receiver 出口共 6 次 | 18 次均连通 |
| 同 release 的合法调用者 | `backend`、`backend-ai`、`celery-voiceprint` 到 PodIP／ClusterIP TCP 8093，共 18 次 | 均连通 |
| 其他 namespace | 相同 release／组件标签到 PodIP／ClusterIP，共 6 次 | 均阻断 |
| 错误组件 | 同 release、`frontend` 到 PodIP／ClusterIP，共 6 次 | 均阻断 |
| 错误 release | `backend`、其他 release 到 PodIP／ClusterIP，共 6 次 | 均阻断 |
| 其他端口 | 合法 caller 到 receiver TCP 8094，共 3 次 | 均阻断；无策略基线连通 |
| receiver 出口 | receiver 到独立 caller listener TCP 8093，共 3 次 | 均阻断；无策略基线连通 |
| 最终允许对照 | 恢复合法 caller 标签，到 PodIP／ClusterIP 共 6 次 | 均连通 |

22 个场景、66 次检查全部符合预期：42 次预期允许、24 次预期拒绝。默认策略在该节点的上述 TCP 路径实际生效，不能仅凭 YAML 渲染得出同样结论。策略中未配置 `additionalPeers`。

本轮只验证 TCP 建连，不验证 HTTP 正文、TLS／CA／token／nonce、Qwen RPC、UDP／DNS、IPv6、跨节点或其他策略叠加后的生产有效权限。没有对既有业务 namespace 安装 encoder 策略，不据此宣布完整生产部署已验收。

## 启动失败与清理

前两次使用既有后端的 tag／运行 digest，均在 listener 启动前收到 `ErrImageNeverPull`，没有执行连通检查。随后只读 CRI 清单能看到对应 tag／digest，故不将该现象归因为“制品不存在”或 CNI 失败；未进一步改变节点镜像访问策略或复制业务拉取凭证。Kubernetes 的[镜像文档](https://kubernetes.io/docs/concepts/containers/images/)说明本地镜像也可能受拉取凭据校验约束，但本次日志不足以确定具体原因。改为离线导入自建测试制品后，完整检查通过；两个失败尝试的 namespace 也已清理。

成功回执确认两个测试 namespace、唯一导入镜像引用及私有传输目录均已删除；没有全局 prune 或删除共享镜像层。私有产物：`work/voiceprint-ecs-cni-{initial,digest,result}-2026-10-11.json`、`voiceprint-cni-{task,owned-status,image-inventory}-2026-10-11.json`。密码及业务凭据不进入产物或 Git。

## 复验入口与代码边界

[voiceprint_network_policy_probe.py](../../deploy/aliyun/voiceprint_network_policy_probe.py)接受审核后的 JSON task 文件，字段为：12 位随机十六进制 `task_id`、对应 `release`、预装标准 Python 镜像 `image_reference`，以及从同 namespace／release 的 Chart 渲染结果筛出的 `policy` 和 `service`。仅使用这两份资源，不安装整份 Chart。镜像接受不可变 digest 或与本次 task ID 严格绑定的离线测试引用，不接受其他可变标签。

```text
python3 deploy/aliyun/voiceprint_network_policy_probe.py --task-file /private-probe/task.json
```

需具有创建和清理独立测试 namespace 的受控 kubeconfig／k3s 权限及足够的短期调度额度。探针创建自己的 Pod、配额和 Service／NetworkPolicy，输出聚合 JSON，并在失败路径核对归属后清理；不能把 CLI 运行权限授予普通业务用户。

5 项探针安全回归覆盖名称冲突、归属改变、部分创建后的失败清理、非法 task ID 和其他可变／外来 task 镜像拒绝，全部通过；10 项实际 Helm encoder 渲染回归通过。完整资源预算、实际 HTTPS 业务链路、Secret 轮换、持续并发、真人效果与真实终端验收继续保留。

后续[独立 HTTPS 编码器与 Secret 轮换走查](voiceprint-ecs-https-review-2026-10-11.md)已完成真实 transport、证书／主机名、权限和 A／B Recreate 验证；它补充上述 TCP 证据，完整业务授权／队列／RTC、HA、容量和真人准入仍待完成。
