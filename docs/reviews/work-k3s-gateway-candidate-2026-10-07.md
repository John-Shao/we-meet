# 独立 Gateway 发布候选

PID 前置变更已完成。以下是首次部署前的候选快照；用户随后明确“授权新增生产服务”，已按本范围发布独立 Pi/Qwen Gateway。实际部署、验收及首次标签不匹配见 [发布回执](work-k3s-gateway-release-2026-10-07.md)。业务 `WORK_AGENT_ENABLED`、`WORK_REVIEW_ENABLED` 继续保持关闭。

| 项目 | 候选 |
| --- | --- |
| Helm chart / release | `src/helm/work-agent-k8s` / `meet-work-review` |
| Gateway / task / business namespace | `meet-work-review` / `meet-work-review-tasks` / `meet` |
| API server egress | `172.16.0.4/32:6443` |
| 引擎 / 模型 | Pi 1.0.4 / `qwen3.8-flash` |
| 模型入口 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Gateway / Broker | ClusterIP TLS 8444 / 8445，无公网 Ingress |
| 状态 | 新建独立 `meet-work-review-state` PVC，2Gi，默认保留 |
| 资源 | Gateway requests 100m/128Mi；串行任务 requests 100m/128Mi；最多 2 个任务 Pod |
| 权限 | task namespace 的 Pod create/get/list/delete；无 ClusterRole |
| task 网络 | 默认拒绝，只放行 DNS 和 Gateway Broker；无 API token/hostPath/Docker socket |

已再次检查本机可用源镜像：Gateway `we-meet-work-agent-gateway@sha256:9d0ec059f8a5dd9e70935e5c0d40ba4b2605fce4e685c202ea21e216a7958adb`，Pi `we-meet-work-agent@sha256:5c460c1b1ef5e5d9ce0d70ba3c274bf05f08a5bbb730865c0b68d41662b9a033`。拟发布到 `jusi-cn-guangzhou.cr.volces.com/we-meet/work-agent-gateway` 和 `.../work-agent-pi`；发布后重新确认 registry digest，不把本机 digest 或离线渲染当作生产镜像已可拉取。

TLS SAN 为 `meet-work-review.meet-work-review.svc.cluster.local`。在 Gateway namespace 创建 `meet-work-review-tls`（tls.crt/tls.key/ca.crt）、随机 Gateway token Secret、`meet-work-review-provider`。Qwen 复用生产 `meet/meet-ai-credentials` 的 `DASHSCOPE_API_KEY`，只在内存复制这个字段，不复制整份业务 Secret、不导出 key、不改原 key。任务 namespace 仅放公共 CA 和必要的 registry 拉取 Secret；业务 namespace 仅准备 token/公共 CA 客户端 Secret，暂不更新业务 Deployment。

首次空状态需明确 `newStateAcknowledged:true`；现有状态不得覆盖。使用已提交的 disabled [候选模板](../../src/helm/env.d/aliyun-prod/values.work-review-k8s.yaml.dist)，补齐 registry 实际 digest、公共 CA 与镜像拉取 Secret 后再次渲染、检查和提交发布回执。TLS 和 registry 权限尚未验证，因此候选不是可直接生产 apply 的清单。

发布验收先不调用供应商：验证 Ready、TLS、PVC 恢复、RBAC 和实际 NetworkPolicy 的正负对照；再通过专用合成材料验收 Pi/Qwen，模型调用最多 5 次，每次最多 4096 输出 tokens，不读取真实用户材料。业务开关待独立验收结果另行确认。

CPU 是已观测到的限制：静态 requests 3550m，但定时任务期间曾为 3950m/4000m。发布前重新预检，Gateway 和真实任务正常经过 scheduler；不足容量时保持任务 Pending/失败回执，不降低真实执行器请求或绕过调度，不调整业务 Job/Deployment。节点恢复和容量不足不得通过反复重启 K3s 解决。

独立发布失败时先撤销任务凭据，按 UID 清理所属任务，再回退 Gateway 镜像/配置；保留 PVC、原业务 Deployment、原供应商 Secret、已验证 PID 配置和节点身份恢复配置。若缺少 registry 发布权限、TLS/持久卷/容量验收未通过，只报告具体阻塞，不尝试启用业务。
