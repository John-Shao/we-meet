# 声纹身份识别独立监控告警接入方案

日期：2026-10-11（Asia/Shanghai）。状态：**方案已交付，待评审；部署延期至监控 ECS 到位，未部署**。关联[声纹身份识别实施方案](speaker-identity-voiceprint-plan-2026-10-09.md)第 18 节。

用户已明确目标环境尚未部署监控，先提供独立接入方案。本次只交付设计、配置示例、告警定义及验收安排；没有安装平台、修改 ECS、开通通知或打开声纹开关。模型路线继续为 Qwen 优先，只有效果评测不满足要求时才考虑 CAM++；监控异常不触发自动换模型。

用户后续确认暂时没有监控节点，**监控 ECS 到位后再部署监控系统**。当前保留方案与现有代码指标，不在现有业务 ECS 安装平台，不开通通知，也不自动购买节点。ECS 到位后核验资源、网络、存储和接收渠道，再按第 8 节分阶段实施；资源到位不替代方案评审或声纹发布准入。

## 1. 建议与边界

建议采用 **Prometheus + Alertmanager，Grafana 按需加入**，放在新增的独立监控节点，使用专用 `monitoring` namespace，与现有 k3s 集群通过私网连接。首期直接管理配置文件，不要求 Prometheus Operator 或整套 kube-prometheus-stack。先接入现有 encoder／sampler 指标，再补业务、清理和独立撤销日志指标。

2026-10-11 15:52 的只读核验中，现有节点 allocatable 为 4 CPU，已分配 requests 3,650m，剩余约 **350m**；内存 requests 7,334 MiB，根盘可用约 28 GB。encoder 本身默认 requests 为 1 CPU／1 GiB，尚不能按默认值调度。因此，当前节点不能同时承接完整声纹部署和本方案的监控预算。短期探针曾使用的 250m 请求不作为生产降配依据，详见[ECS 资源走查](../research/voiceprint-ecs-resource-review-2026-10-11.md)。

这里的“独立”指独立配置、凭据、持久卷和计算预算。新增同集群节点仍依赖现有控制平面、网络与电源；单实例 Prometheus／Alertmanager 不提供 HA。生产若要求覆盖整个集群故障，需要集群外的存活检查和接收渠道；若要求持续采集与通知，再评审跨故障域冗余。

| 部署方式 | 适用情况 | 本方案结论 |
|---|---|---|
| 新增同集群专用节点，监控 Pod 固定调度 | 私网 DNS／ClusterIP 可用，容易按 namespace + Pod 限制采集 | 首期推荐；需单独批准节点资源，并验收跨节点 CNI |
| 独立 VM 上的平台 + 集群内采集器，经私网 remote write | 要求监控存储与业务集群分离 | 后备方案；额外评审采集器预算、remote write TLS／鉴权／缓冲，以及远端告警计算。采集器不能替代告警服务器 |
| 全部装在现有 ECS | 当前仅余 350m requests，声纹资源也未落实 | 当前不建议 |
| 后续统一 Operator 平台 | 公司建立统一 Kubernetes 监控后 | 可迁移规则／面板；先核验选定版本与 k3s 的兼容性，CRD／RBAC 纳入单独变更 |

Operator 的 ServiceMonitor／PodMonitor 用于生成采集配置，PrometheusRule 用于规则管理；本仓库当前没有这些 CRD 的接入配置，本次不增加其依赖。[Prometheus Operator 官方说明](https://prometheus-operator.dev/docs/getting-started/introduction/)

## 2. 首期资源与存储预算

以下是**小规模声纹专项试点的起始预算**，不是厂商最低配置或实测容量保证。预算假设：一个环境，encoder／sampler 各一个副本，初期不采集全公司所有工作负载；后续活跃时间序列控制在 10,000 条以内，采集间隔 30 秒，保留 15 天。

建议监控节点起步 **4 vCPU／8 GiB RAM／100 GiB SSD**，无 GPU；系统与监控数据分区／卷分开。这个节点仅预算监控，**不包含 Qwen、消费者、采样服务、主库及独立撤销日志的资源**。

| 组件 | 起始 requests | 起始 limits | 持久化 |
|---|---|---|---|
| Prometheus | 500m CPU／1 GiB | 2 CPU／3 GiB | 独立 50 GiB PVC，15 天及 35 GiB block 上限同时约束 |
| Alertmanager | 100m CPU／128 MiB | 500m CPU／512 MiB | 2 GiB PVC，保留通知去重及 silence 状态 |
| Grafana（可延后） | 100m CPU／256 MiB | 500m CPU／1 GiB | 5 GiB PVC；数据源／面板存 Git，账号凭据独立 |
| 后续业务 exporter（未实现） | 暂预留 100m CPU／128 MiB | 暂预留 500m CPU／512 MiB | 无生物信息持久化；限额以查询成本实测修订 |

前三项合计 requests 700m CPU／1,408 MiB，已超过现有 350m CPU 调度余量；加入 exporter 后为 800m。还需扣除新节点系统／k3s／网络插件开销，不按整机标称资源排满。

以 10,000 条序列、30 秒间隔估算，15 天为 `10,000 × 86,400 / 30 × 15 = 432,000,000` 个样本。实际磁盘还包含索引、WAL、head、压缩临时文件等；不能只按编码后的样本字节预算。35 GiB block 上限留出约 30% 卷空间，仍需监测文件系统余量；容量触顶可能使实际保留期短于 15 天。Prometheus 官方建议为压缩留出空间，local TSDB 也不提供分布式持久性。[存储与保留说明](https://prometheus.io/docs/prometheus/latest/storage/)

试点先做 24 小时稳定性及故障恢复验证，再在确定预算内观察至少 7 天的峰值、series churn、WAL／磁盘增长、查询峰值与告警噪声，修订资源。此观察只验证监控容量，不替代声纹真人效果或业务吞吐验收。新节点使用标签／taint 与指定 toleration，避免监控迁回紧张的业务节点；local-path 卷与节点绑定的恢复边界必须记录。

## 3. 指标清单与实际能力

以下现有指标来自当前功能分支，**不代表目标 ECS 已运行该制品**。encoder 新镜像的结果指标已通过合成验证，尚未上传／安装；部署时必须验证 registry digest 与对应源码。参考[encoder 指标走查](../research/voiceprint-encoder-result-metrics-review-2026-10-11.md)、[sampler 运行走查](../research/voiceprint-sampler-runtime-review-2026-10-11.md)。

| 现有入口／指标 | 类型及含义 | 使用约束 |
|---|---|---|
| encoder：HTTPS `8093/metrics` | 私网聚合文本指标；与 embeddings 共用监听器 | 当前 metrics 无独立鉴权；靠网络隔离及服务器 TLS。采集器不持有 embeddings token／permit key |
| `voiceprint_encoder_ready` | gauge：模型服务是否就绪 | 不证明业务开关、授权或识别准确率 |
| `voiceprint_encoder_active`／`uploads` | gauge：当前提取、上传处理数 | 单进程状态，不是业务待处理队列长度 |
| `voiceprint_encoder_permit_entries` | gauge：缓存条目数，含尚未清理的过期条目 | 面板诊断使用；不能直接据此判断有效许可容量已满 |
| `voiceprint_encoder_permits_active`／`permit_capacity` | gauge：未过期使用记录数／容量 | 容量压力使用 active / capacity，分母须大于零 |
| `voiceprint_encoder_requests_total{outcome}` | counter：`2xx/4xx/5xx/canceled` | 只计 POST embeddings；busy 也属 5xx，不能把所有 5xx 当模型故障 |
| `voiceprint_encoder_results_total{result}` | counter：`success/busy/permit_capacity/unavailable/timeout/rejected/canceled` 七类 | 过载与模型故障分别告警；重启清零，使用 rate／increase |
| `voiceprint_encoder_request_seconds_total` | counter：所有 embeddings 请求累计服务耗时 | 可算平均 HTTP 处理耗时，**不能算 P95**；包含失败／busy 请求，不含业务排队 |
| sampler：HTTP `8094/metrics` | 私网四项无标签 gauge | 当前未提供 metrics TLS；首期限受控集群网络，不对公网开放 |
| `voiceprint_sampler_ready`／`enabled` | 就绪／采样配置开关状态 | ready 只证明 SDK 注册连接；不证明某参与者允许采样 |
| `voiceprint_sampler_active_rooms`／`room_capacity` | 活跃房间数／实例房间上限 | 容量观察；不输出房间或人员 ID，不证明每轨采样成功 |
| 组织 operations 管理 API | 当前保留数据的 gauge／窗口汇总、请求至完成 P95 | 是真人组织管理员接口，不是 Prometheus endpoint，不借用管理员 Cookie／会话来采集 |

当前任务 P95 为 `finished_at - created_at`，含排队和重试；第 15 节要求的“ASR 完成至身份建议可见 P95 ≤ 60 秒”仍需补齐事件时点和真实终端验证。要计算可聚合的请求分位数，需要新增 histogram 或其他有明确误差语义的分布数据，不能对累计秒数 counter 使用 `histogram_quantile`。[Prometheus 分位数说明](https://prometheus.io/docs/practices/histograms/)

## 4. 网络、凭据与采集方式

### 4.1 首期单副本采集

监控和业务 Service 都保持 ClusterIP。Prometheus 使用明确配置的 Service DNS，关闭 ServiceAccount token 自动挂载，不申请 Kubernetes API／Secret 读取权限。CA 公证书独立挂载，只读；不挂载 encoder 私钥、API token、permit key、声纹密钥、音频或模型卷。

以下仅为**单副本配置示例**。`meet` release、namespace 及默认 fullname 是示例假设；实施时以 Helm 渲染的真实 Service 名称、集群域名和证书 SAN 替换。sampler 只有部署并预期运行时才添加目标；没有部署时不生成对应告警。

```yaml
global:
  scrape_interval: 30s
  scrape_timeout: 5s
  evaluation_interval: 30s
  external_labels:
    cluster: meet-isolated
    environment: staging
rule_files:
  - /etc/prometheus/rules/voiceprint.yml
scrape_configs:
  - job_name: voiceprint-encoder
    scheme: https
    metrics_path: /metrics
    honor_labels: false
    fallback_scrape_protocol: PrometheusText0.0.4
    sample_limit: 100
    label_limit: 12
    tls_config:
      ca_file: /etc/prometheus/voiceprint-ca/ca.crt
      server_name: meet-voiceprint-encoder.meet.svc.cluster.local
      insecure_skip_verify: false
      min_version: TLS12
    static_configs:
      - targets: [meet-voiceprint-encoder.meet.svc.cluster.local:8093]
        labels: {namespace: meet, component: voiceprint-encoder}
  - job_name: voiceprint-sampler
    scheme: http
    metrics_path: /metrics
    honor_labels: false
    fallback_scrape_protocol: PrometheusText0.0.4
    sample_limit: 100
    label_limit: 12
    static_configs:
      - targets: [meet-voiceprint-sampler.meet.svc.cluster.local:8094]
        labels: {namespace: meet, component: voiceprint-sampler}
```

该示例只覆盖声纹 scrape；实施制品还必须包含 Prometheus／Alertmanager 自监控、向 Alertmanager 发送告警的 TLS／鉴权配置及所需网络规则。采集频率、TLS CA／server name、sample 限额按选定版本的官方格式检查；示例不采用跳过证书验证来解决失败。[Prometheus 配置说明](https://prometheus.io/docs/prometheus/latest/configuration/configuration/)

**多副本时不能继续通过负载均衡 Service 采集进程 counter**，否则相邻采集可能来自不同 Pod，导致错误重置和比率。扩容前改为每 Pod EndpointSlice 发现，保留实例身份，再 `sum(rate(...))` 聚合；证书仍校验 Service SAN。仅为指定业务 namespace 的 pods、services、endpointslices 设置 get/list/watch，另核验所选 discovery 实际需要的资源；不授予 Secrets 或集群写权限。不实现发现时，限制该采集配置为单副本，不把错误统计带入生产。

### 4.2 Chart 已有附加 peer 的用法

encoder 可通过 `voiceprintEncoder.networkPolicy.additionalPeers` 接入，下例同时约束 namespace 和 Pod；sampler 可在 `voiceprintSampler.networkPolicy.additionalPeers` 使用相同 peer，分别只允许 TCP 8093／8094。实际 sampler values 键及标签由渲染确认。

```yaml
voiceprintEncoder:
  networkPolicy:
    enabled: true
    additionalPeers:
      - namespaceSelector:
          matchLabels:
            kubernetes.io/metadata.name: monitoring
        podSelector:
          matchLabels:
            app.kubernetes.io/name: voiceprint-prometheus
```

两个 selector 必须在**同一个列表项**，表示交集；分成两个项会扩大放行范围。NetworkPolicy 的多个允许规则是叠加关系，需检查目标环境其他策略没有更宽放行。Pod 标签本身不是不可伪造的身份，monitoring namespace 的部署／标签修改权限必须仅给运维账号；不用 hostNetwork。[Kubernetes 网络策略语义](https://kubernetes.io/docs/concepts/services-networking/network-policies/)

Prometheus namespace 设置默认拒绝入／出站，再仅放行：到实际 DNS 目标的 UDP／TCP 53、到 `meet` 中 encoder／sampler 精确 Pod selector 的 TCP 8093／8094、到 Alertmanager 的 TCP 9093；后续 API discovery 增加精确 API server 通路。Grafana 仅允许到 Prometheus 的查询通路；后台管理从受控网关／VPN 进入。NodeLocal DNS、Service DNAT、跨节点、IPv4／IPv6 按实际 CNI 验收，不能照抄 CIDR。

上述出站规则按 Prometheus Pod 应用；Alertmanager 单独允许 DNS 和选定接收端的确切协议／端口，入站仅允许 Prometheus 与受控管理通路。标准 NetworkPolicy 不按域名直接筛选：外部接收端地址变化时采用固定私网通知网关，或另行核验 CNI 的域名策略能力及更新流程，不放开所有公网地址来解决投递失败。

encoder 的离线 `egress: []` 保持原约束。采集器能够到达 8093 不代表允许 embeddings：测试无 token／无 permit 请求仍被拒绝。若以后将 metrics 移到独立监听器或加采集专用鉴权，作为单独实现，不声称现有代码具备该能力。

独立 VM 不能直接套用上例 Pod peer，也不能假设能解析集群 DNS／访问 ClusterIP。选择 VM 路线时，优先由集群内采集器 remote write 至私网认证端点；不把 encoder 8093 暴露公网，不为便利开放整个 VPC 网段。

## 5. 首期告警定义与 PromQL

以下阈值为**试点初值**，需用目标环境负载和故障注入修订；尚未取得业务 SLO 证据。critical 表示值班处置，warning 表示容量／配置排查。只为明确预期部署的目标加载规则；业务功能关闭时，清理、撤销日志及监控自身告警仍应保留。

| 告警 | 条件／持续时间初值 | 处置要点 |
|---|---|---|
| EncoderScrapeDown | `up{job="voiceprint-encoder"} == 0`，2 分钟 | 区分进程、网络、CA／SAN／证书轮换、指标解析失败；不直接认定模型损坏 |
| EncoderTargetMissing | `absent(up{job="voiceprint-encoder"})`，2 分钟 | 仅在预期部署时加载；发现目标消失也要告警，不能用“无序列”表示健康 |
| EncoderNotReady | scrape 成功但 ready=0，2 分钟 | 模型加载、子进程恢复／退出；Recreate 维护用有到期时间的 silence |
| EncoderMetricMissing | scrape 成功但缺任一约定指标／固定 outcome、result 序列，2 分钟 | 制品落后或格式变化；低流量的零值与缺指标分开，实施时按完整清单校验 |
| EncoderModelFailures | 5 分钟 unavailable+timeout ≥3 次；或 ≥20 次总请求且故障率 ≥5%，持续 2 分钟 | 七类结果分别统计；busy 不计入模型故障 |
| EncoderBusyPressure | ≥20 次请求且 busy 比率 >20%，持续 10 分钟 | 看业务队列及资源；先限制流入，不能据此降低身份门限 |
| EncoderPermitPressure | active/capacity >80%，持续 5 分钟，或 5 分钟 permit_capacity ≥3 次 | 看正常过期周期、请求预算和容量；不清空防重放缓存来恢复服务 |
| EncoderRejectedIncrease | ≥20 次请求且 rejected 比率 >10%，持续 10 分钟 | 查调用者配置及音频／许可契约；固定 rejected 类别不当安全入侵结论 |
| SamplerScrapeDown／TargetMissing | 目标预期部署，2 分钟 | 网络／进程／指标；可与 encoder 共用规则生成方式 |
| SamplerNotReady | scrape 成功、enabled=1 且 ready=0，2 分钟 | LiveKit 注册／连接；enabled=0 为预期停用状态 |
| SamplerCapacityPressure | enabled=1 且活跃房间/容量 >80%，10 分钟 | 仅容量预警，不声称丢弃片段率或采样授权异常 |

所有 rate／increase 对**每条原始 counter 先计算，再按 job／instance 聚合**，避免重启造成误算。无请求时比率显示“无请求”，不填假零；现有 counter 只能观察跨采集点的增量，采集间隔内退出的请求计数可能丢失，不用于审计／计费。[PromQL counter 函数](https://prometheus.io/docs/prometheus/latest/querying/functions/)

规则核心示例（另需按上表补齐目标缺失、指标缺失、sampler 及平台自监控规则）：

```yaml
groups:
  - name: voiceprint-encoder
    rules:
      - record: voiceprint:encoder_requests_5m
        expr: sum by (job, instance) (increase(voiceprint_encoder_results_total{job="voiceprint-encoder"}[5m]))
      - record: voiceprint:encoder_faults_5m
        expr: sum by (job, instance) (increase(voiceprint_encoder_results_total{job="voiceprint-encoder",result=~"unavailable|timeout"}[5m]))
      - alert: EncoderScrapeDown
        expr: up{job="voiceprint-encoder"} == 0
        for: 2m
        labels: {severity: critical, service: voiceprint}
        annotations:
          summary: 声纹编码器指标采集失败
      - alert: EncoderNotReady
        expr: (voiceprint_encoder_ready{job="voiceprint-encoder"} == 0) and on (job, instance) (up{job="voiceprint-encoder"} == 1)
        for: 2m
        labels: {severity: critical, service: voiceprint}
        annotations:
          summary: 声纹编码器未就绪
      - alert: EncoderModelFailures
        expr: >-
          ((voiceprint:encoder_faults_5m >= 3)
          or ((voiceprint:encoder_faults_5m / voiceprint:encoder_requests_5m >= 0.05)
          and on (job, instance) (voiceprint:encoder_requests_5m >= 20)))
          and on (job, instance) (up{job="voiceprint-encoder"} == 1)
        for: 2m
        labels: {severity: critical, service: voiceprint}
        annotations:
          summary: 声纹编码器不可用或超时增加
      - alert: EncoderBusyPressure
        expr: >-
          (sum by (job, instance) (increase(voiceprint_encoder_results_total{job="voiceprint-encoder",result="busy"}[5m]))
          / voiceprint:encoder_requests_5m > 0.20)
          and on (job, instance) (voiceprint:encoder_requests_5m >= 20)
          and on (job, instance) (up{job="voiceprint-encoder"} == 1)
        for: 10m
        labels: {severity: warning, service: voiceprint}
        annotations:
          summary: 声纹编码器持续过载拒绝
```

counter 平均 HTTP 处理耗时面板使用：

```promql
(sum by (job, instance) (rate(voiceprint_encoder_request_seconds_total{job="voiceprint-encoder"}[5m]))
 / sum by (job, instance) (rate(voiceprint_encoder_requests_total{job="voiceprint-encoder"}[5m])))
and on (job, instance)
(sum by (job, instance) (rate(voiceprint_encoder_requests_total{job="voiceprint-encoder"}[5m])) > 0)
```

此面板标题注明“所有 embeddings 请求平均服务耗时”，不标成“成功提取耗时”或 P95。大量快速 busy 可能压低均值，必须和结果分布同屏显示。

平台自监控至少覆盖：规则计算失败／超时、配置 reload 失败、通知发送失败、监控实例内存／重启、TSDB／PVC 可用空间 <20%（warning）／<10%（critical）、指标新鲜度、私网 TLS 证书剩余 <14 天／<7 天。磁盘、证书及容器资源需要相应 exporter／探针或平台采集，**目前不由上述声纹指标提供**。实现时核验选定版本的真实指标名，避免凭空生成不会触发的规则。

## 6. 第二阶段：业务与独立日志监控

现有[组织 operations 接口](../research/voiceprint-operations-review-2026-10-11.md)保留真人管理员按组织查看。机器采集新增独立 exporter／受控汇总任务，不能给 Prometheus 普通管理员权限、遍历组织会话，或让每次 scrape 执行无界 SQL。

建议汇总任务每 60 秒更新内存快照，初值为查询超时 2 秒、单任务互斥和 5 分钟新鲜度上限；生产规模验证后修订。业务库角色仅能执行审定的聚合视图／查询，不能读取音频、向量、密钥、文本、人员姓名。若只有只读副本，必须量化复制延迟；删除与撤销关键状态不以滞后副本作为健康依据。失败时保留“失败／陈旧”标记，不能发布零积压。

| 拟新增观测项（均未实现 Prometheus 接入） | 类型／边界 | 初期规则建议 |
|---|---|---|
| 队列任务数、最老 queued／running 年龄、租约异常 | gauge，queue/state 为固定枚举 | 最老任务 >5 分钟 warning；超过任务既定超时 critical，实际值按任务预算绑定 |
| 删除／贡献清理数量、最老待清理年龄 | gauge，包含已删除 profile 的独立清理意图 | >1 小时 warning；接近 24 小时要求时于 20 小时 critical，24 小时仍未完成升级；功能关闭仍告警 |
| 模板／候选暂停、到期和固定拒绝原因 | 当前保留行的 gauge | 只做容量／异常趋势，不将保留行变化记为单调累计量 |
| 人工接受／拒绝窗口量 | 窗口 gauge；有明确分母与最低样本量 | 初期面板观察；不能当识别 precision／污染率 |
| 请求至任务完成分布 | histogram 或有窗口说明的 P95 gauge | 和 ASR 完成至建议可见独立命名；在真实负载后定阈值 |
| ASR 完成至建议可见分布 | 新增事件时点、失败／未完成分母及客户端观测 | 第 15 节 60 秒 SLA 作为验收目标；缺客户端时点不发布“达标” |
| 汇总成功／失败、最后成功时间／数据年龄 | gauge／固定失败类别 | 5 分钟未成功 critical；exporter 活着但 SQL 失败也告警 |
| 独立撤销日志 ready、写入失败／超时、最新头校验结果 | 聚合 gauge／固定原因 counter | ready／可信头失败立即 critical；停新增登记／更新并按既定日志门禁处置 |
| 日志状态字节数／容量、增长、备份／恢复验证时间 | gauge／时间戳；不暴露日志内容 | 70% warning、85% critical 初值；趋势需保证撤销写入余量，不能等超限拒绝后再告警 |

清理时限从原始撤销／删除意图成立时计算，重试、任务重建或 profile 删除不能重置该时钟；恢复流程也必须保留原始时间。暂时无法取得可信起点时标记观测不完整，不发布“24 小时达标”。

Prometheus 默认采集全局聚合，labels 仅包含 cluster/environment/job/instance、有限 queue/state/reason/device_group；**不含组织名／ID、用户、联系人、会议、音轨、样本、对象路径、相似度、音频、向量、许可、摘要或密钥**。组织级明细留在现有受权限保护的管理界面。若以后确需按组织告警，另评审限定规模及授权方案，不直接把所有 organization_id 变成 labels。

独立日志的健康／最新头检查使用专门只读探针和受限凭据，不能把签名完整状态或可信最新头写入 Prometheus。探针失败与主库恢复门禁保持一致，但告警不是恢复授权或数据完整性证明。容量规则还需基于[当前 full-state 日志增长测量](../research/voiceprint-journal-capacity-review-2026-10-11.md)制定修复与保留方案，不能单纯扩大上限来宣布“立即撤销”已保障。

## 7. 通知、面板与处置

告警归属建议：模型／采样／业务队列归应用值班，TLS／网络／平台／存储归基础设施值班，撤销／清理时限同时通知数据责任人。具体负责人及接收渠道留作实施前配置，不在文档填个人地址、机器人 URL 或 token。没有已验证 receiver 时只做隔离告警记录，不能声称生产通知已就绪。

Alertmanager 按 `cluster/environment/service/alertname` 分组，初值 `group_wait: 30s`、`group_interval: 5m`；critical 重复 30 分钟、warning 重复 4 小时，发送恢复通知。critical 未确认 10 分钟时由已选值班平台／流程升级，**Alertmanager 的重复通知不等于已实现确认及自动升级**。配置实际 receiver 时使用专用 Secret 和私网 TLS／严格证书校验。[Alertmanager 路由配置](https://prometheus.io/docs/alerting/latest/configuration/)

相同 cluster/environment/job/instance 的 ScrapeDown 可以抑制其派生 NotReady／比率通知；不能跨实例抑制，不能抑制独立日志和清理超时。维护 silence 写明工单、负责人和到期时间；不永久屏蔽 Recreate 停机。规则 `for` 与采集、计算、分组延迟共同影响通知时间，例如 2 分钟 for 不等于故障发生后 2 分钟必达；孤立故障计数的短窗口跨越 for 也须规则测试。[告警规则状态说明](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/)

Grafana 面板建议三页：① encoder／sampler 可用性、七类结果、许可压力、平均处理耗时；② 队列、清理、拒绝原因、业务延迟及数据新鲜度；③ 日志门禁、容量、备份及平台自身。未接入指标显示“未接入”，无样本显示“无数据”，不画健康零值。数据源与面板文件版本化，运维只读账号默认不能编辑数据源／通知配置。[Grafana 文件配置说明](https://grafana.com/docs/grafana/latest/administration/provisioning/)

Prometheus／Alertmanager 管理 API 和 Grafana 不开放公网匿名访问；按受控网关／VPN、身份认证及私网网络规则限制。Prometheus 不开启非必要 admin API／HTTP lifecycle，reload 通过受控运维流程。访问配置／管理端点的权限不能视为普通业务只读权限。[Prometheus 安全模型](https://prometheus.io/docs/operating/security/)

监控告警不自动写最终姓名、接受样本、清空许可记录、降低匹配门限或开启 CAM++。模型故障处置先停止新增采样／识别流入，按原方案保留普通转写、通讯录选择与自定义标签；污染调查按 profile／贡献撤销流程，由授权操作人执行，不从告警直接批量改历史姓名。

外部存活检查与 Watchdog 接收端必须位于不同故障域，检查监控心跳和通知通路。全平台断电时自身 Prometheus 无法发送告警；未配置外部检查前，应明确单点盲区。

## 8. 实施交付、验证与回退

### 8.1 评审后分阶段交付

1. 确认节点／卷预算、namespace／DNS／CA、值班负责人和接收渠道、保留期。固定 Prometheus／Alertmanager／Grafana 版本及 registry digest；核验其 Kubernetes／CNI／TLS 兼容性，不用浮动 latest。
2. 在独立测试 namespace 交付 manifests／Helm values、采集配置、完整规则与 promtool 规则测试、面板、网络策略、受限 RBAC（仅采用发现时）、Secret 创建说明及处置手册。候选位置 `deploy/monitoring/voiceprint/`，本次尚未创建运行配置。
3. 接入当前 Qwen encoder／sampler 制品；只用合成信号验证采集、过载／超时／重启与分类。通过后才实现业务 exporter／日志探针，并验证有界查询和隐私边界。
4. 在选定隔离通知渠道验证触发、去重、恢复、维护 silence 和外部心跳；发送消息须在该验收任务明确授权范围内进行，不因方案评审自动向真实人员发消息。
5. 达成资源、恢复、通知和告警质量要求后才接入目标试点。声纹功能仍遵循真人数据、门限校准、真实 Web／Android 与完整业务链路准入，不因监控接入而打开开关。

### 8.2 验收矩阵

| 验证项 | 必须看到的结果 |
|---|---|
| 静态配置／规则 | 固定版本 `promtool check config`／`check rules`／`test rules` 通过，Alertmanager 配置检查通过；包括低流量、无数据、counter reset、缺类别、阈值边界及恢复 |
| TLS／网络 | 正确 CA／SAN 可采集；错误 CA／主机名拒绝。合法 monitoring Pod 允许；其他 Pod、跨 namespace 仿造标签、其他端口拒绝；检查叠加策略。encoder 出站仍拒绝 |
| 权限／隐私 | scraper 不持有 embeddings 凭据或业务会话，未授权 embeddings 拒绝；指标、日志、通知不含上述身份／声音／密钥字段，管理 UI 仍按组织隔离 |
| 结果分类 | 已知合成计数与七类结果一致；纯 busy 触发容量预警而不触发模型故障；unavailable／timeout 可独立触发 |
| 目标完整性 | 停进程、移除发现目标、缺必需指标分别告警；部署关闭时不加载预期运行告警，仍保留清理／日志监控 |
| 单／多副本与轮换 | 单副本 counter reset 正确；多副本先逐 Pod 采集再聚合；Recreate／CA 轮换后重新恢复，旧证书拒绝行为记录 |
| exporter 异常 | SQL 超时／主库不可用／副本滞后不显示零积压；陈旧快照告警；无全量载荷查询、无无界 scrape 计算 |
| 删除／撤销 | 关闭采集、profile 删除后仍能监控清理意图；模拟过期 backlog 与日志容量／可信头失败触发，告警不修改状态 |
| 平台容量／恢复 | 24 小时稳定性、7 天预算观察及磁盘／WAL增长可控；重启／卷恢复保持规则和 silence；node 本地卷失效恢复边界记录 |
| 通知链路 | 隔离 receiver 收到初始／恢复，去重／抑制只按同实例生效；人为停止通知服务或全监控平台可被独立外部检查发现 |

promtool 提供规则测试，不能只确认 YAML 能解析就认为阈值、缺数据和 for 行为正确。[官方规则测试方法](https://prometheus.io/docs/prometheus/latest/configuration/unit_testing_rules/)

回退先停止新增采集器／通知配置并恢复上个已检查版本，不删除 TSDB／Alertmanager 状态卷。若撤销日志或删除保障不可用，按声纹故障关闭流程停新增采样／登记／识别，清理及撤销处理继续按既定门禁运行；监控故障不得绕过门禁。网络回退只撤销本次专用 peer／规则，不扩大原有访问范围。

## 9. 评审待定项与完成判据

| 待定项 | 建议默认值／实施前需要确定的内容 |
|---|---|
| 平台位置与费用 | 暂无监控节点，部署延期至监控 ECS 到位；4 vCPU／8 GiB／100 GiB 为起始预算，具体云规格、费用及建设授权待定，不自动购买 |
| 首期范围 | 一个隔离环境，encoder／sampler 单副本；Grafana 可延后，业务 exporter 第二阶段 |
| 保留与权限 | 15 天／35 GiB block 预算；运维专用身份，默认全局聚合；若延长保留则重新测算 |
| 通知与责任人 | 测试接收渠道、应用／基础设施／数据负责人、确认升级流程及外部 Watchdog；未确定前不发送真实通知 |
| 故障目标 | 单实例试点；正式 HA／跨故障域的 RTO／RPO 与冗余另行评审 |
| 阈值修订 | 本文初值不改变第 15 节真人效果门限；监控阈值根据试点观测形成有版本的修订记录 |

本次方案交付完成的判据是：架构、预算、指标能力、配置示例、告警及验收路径可评审，并已关联主方案。**平台部署完成**还必须取得实际采集／通知／资源／恢复证据；**声纹首期发布完成**仍必须取得[交付走查](../research/voiceprint-delivery-audit-2026-10-11.md)列出的真人效果、真实终端、完整隔离部署和独立日志等证据。这三个阶段分别记录。
