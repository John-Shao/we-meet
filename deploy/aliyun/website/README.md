# we-meet.online 官网部署

把 React + Vite 静态站部到 aliyun-sjy K3s 集群, 复用 meet 已经在用的 ingress-nginx + cert-manager.

## 拓扑

```
PC (D:\workspace\we-meet\we-meet.online)
  ├─ npm run build  →  dist/  (~345 KB)
  └─ rsync dist/    →  aliyun-sjy:/opt/we-meet-online/
                            │
                            ↓ hostPath mount (read-only)
                       caddy:2-alpine pod (ns: website)
                            ↓
                       Service website:80 (ClusterIP)
                            ↓
                       Ingress (ingress-nginx, 与 meet 共用)
                            │  TLS via cert-manager letsencrypt-prod
                            │  www → apex 301 (from-to-www-redirect)
                            ↓
                       https://we-meet.online
                       https://www.we-meet.online → 301 跳 apex
```

## 前置条件

- aliyun-sjy 已按 [docs/installation/aliyun.md](../../../docs/installation/aliyun.md) 装完 K3s + ingress-nginx + cert-manager
- DNS 加 2 条 A 记录指向 aliyun-sjy 公网 IP:

  | 记录 | 主机 | 解析 |
  |---|---|---|
  | A | `@` (apex) | aliyun-sjy 公网 IP |
  | A | `www` | aliyun-sjy 公网 IP |

  www 是为了 TLS 证书的 SAN + 自动 301 跳 apex.
- 主域 `we-meet.online` ICP 备案已通过 (跟 meet 子域用同一备案号)

## 一次性安装

```bash
# 1) PC 上: build 静态站 + rsync 到 ECS (在 we-meet 主仓库根目录跑)
bash deploy/aliyun/website/sync.sh root@<aliyun-sjy-IP>

# 2) ECS 上: apply manifest (创建 ns website + Deployment + Service + Ingress)
ssh root@<aliyun-sjy-IP>
cd /root/we-meet
sudo -E env KUBECONFIG=/etc/rancher/k3s/k3s.yaml \
  kubectl apply -f deploy/aliyun/website/manifests.yaml

# 3) 等证书 ready (1-2 分钟)
sudo -E env KUBECONFIG=/etc/rancher/k3s/k3s.yaml \
  kubectl -n website get certificate -w

# 4) 验证
curl -I https://we-meet.online           # 200
curl -I https://www.we-meet.online       # 301 → https://we-meet.online
```

> ⚠️ **顺序**: 必须先 sync.sh 后 apply manifests. manifest 里 hostPath `type: Directory`
> 要求 `/opt/we-meet-online` 已存在, 反过来 pod 会卡在 ContainerCreating
> (event: `MountVolume.SetUp failed: hostPath type check failed`).

## 日常发版 (每周改文案)

```bash
bash deploy/aliyun/website/sync.sh root@<aliyun-sjy-IP>
```

完事. rsync `--delete` 默认开启 (清掉老 hash 文件), Caddy hostPath 读盘立即生效, 无需 rollout restart.

### 老 hash 文件清理的边界情况

`--delete` 把 dist 里没了的 hash chunk 立刻清掉. 但浏览器对老 index.html 有几秒缓存, 老
client 还会请求老 hash chunk → 拿到 404. 几秒后浏览器拿到新 index.html 就自愈.

如果发版赶上高峰流量介意这几秒, 用 `--no-delete` 留老文件几天再清:

```bash
bash deploy/aliyun/website/sync.sh root@<sjy> --no-delete
# 几天后人工清:
ssh root@<sjy> 'find /opt/we-meet-online/assets -mtime +7 -delete'
```

## 隔离设计

跟 meet/livekit 共享 aliyun-sjy 这台 ECS, 但从数据面已做到完整隔离:

- 独立 ns `website` + 独立 Deployment/Service/Ingress/Certificate (helm upgrade meet 不会动)
- 独立 hostPath `/opt/we-meet-online` (跟 K3s 状态盘 `/var/lib/rancher/k3s` 完全不同位置)
- Resource limits 32Mi/96Mi (官网 OOM 不传染 meet)
- **NetworkPolicy `website-isolation`**: 出站只允许 DNS, 入站只允许 80. Caddy 被攻破也访问不到 meet 的 postgres/redis/backend.
- 发版日常只跑 `bash sync.sh` (PC 上), 不 ssh ECS, 不碰 kubectl. kubectl 只在首次 apply 一次.

详细约束链与方案对比 (为什么不用独立 docker compose / 为什么不放 aliyun-zlm) 见 [aliyun.md §13.1](../../../docs/installation/aliyun.md#131-拓扑).

### 验证 NetworkPolicy 真的在 enforce (首次部署后做一次)

K3s 自带 kube-router NetworkPolicy 控制器, 装完默认 enforce. 但首次部署完最好确认一次:

```bash
# 在 aliyun-sjy 上
sudo k3s kubectl -n website run test-egress \
  --image=busybox --restart=Never --command -- sleep 600
sudo k3s kubectl -n website wait --for=condition=Ready pod/test-egress --timeout=30s
sleep 10   # 给 kube-router 把 pod IP 同步进 KUBE-SRC-* ipset

# 期望: timeout, exit code 非 0 (被 NetworkPolicy 阻断, 不应该能连)
sudo k3s kubectl -n website exec test-egress -- nc -zv -w5 postgresql.meet.svc.cluster.local 5432

sudo k3s kubectl -n website delete pod test-egress
```

> ⚠️ **不要用 `kubectl run ... --rm -it ... -- command` 一行式短命 pod 测**:
> `--rm -it` pod 秒级生命周期, 在 kube-router 把它的 IP 加进 KUBE-SRC-* ipset
> **之前**就跑完测试退出了. 此时 ipset 不包含该 pod IP, NetworkPolicy 规则匹配
> 不到, traffic 被默认 ACCEPT 直通 — **测试假阳性**, 看起来像 policy 没 enforce
> 但实际上 enforce 是正常的. 所以必须 `sleep 600` 常驻 pod + wait Ready + sleep
> 给同步时间 + exec 测试.
>
> 如果坚持要"一条命令测完"的工效, 改用 ephemeral debug container 也能避坑
> (`kubectl debug -n website <长期跑的 caddy pod> --image=busybox -it -- nc ...`),
> 但本机已有 sleep pod 方式可用, 没必要折腾.

## 排查

| 症状 | 检查 |
|---|---|
| pod 卡 ContainerCreating | hostPath `/opt/we-meet-online` 不存在. 先跑 sync.sh 创建并填充. |
| certificate `READY=False` | `kubectl -n website describe certificate website-tls` → events. 常见原因: `www` DNS A 记录没加 (TLS SAN 含 www, LE 给两个 host 都做 challenge, www 解析失败整张证书 fail). |
| 浏览器 404 但 dist/ 里有文件 | 看 pod 是不是真的 mount 到对的目录: `kubectl -n website exec deploy/website -- ls /srv`. |
| 路由 (`/about`) 404 | SPA fallback 失效, 确认 ConfigMap mount 上了: `kubectl -n website exec deploy/website -- cat /etc/caddy/Caddyfile`. |
| Caddy 启动后崩溃 (CrashLoopBackOff) | `kubectl -n website logs deploy/website` 看 Caddyfile parse error. 多数是改 ConfigMap 后语法笔误, edit ConfigMap 修正后 `kubectl -n website rollout restart deploy/website`. |
| 想暂时让 website pod 调用 meet (调试 / 临时打通) | 删 NetworkPolicy: `kubectl -n website delete networkpolicy website-isolation`. 完事后 `kubectl apply -f deploy/aliyun/website/manifests.yaml` 复原. |
| www 不自动跳 apex | `from-to-www-redirect` annotation 在 ingress-nginx < 1.x 不工作. 查版本: `kubectl -n ingress-nginx get pods -o jsonpath='{.items[0].spec.containers[0].image}'`. 1.10+ 应该 OK; aliyun-prod 装的就是 1.x. |
| 浏览器看到老内容 | index.html 已经 no-cache, 但 CDN/前置代理可能缓存. 无 CDN 场景直接 hard refresh; 有 CDN 把 we-meet.online 加到清洗白名单. |

## 卸载

```bash
sudo -E env KUBECONFIG=/etc/rancher/k3s/k3s.yaml \
  kubectl delete -f deploy/aliyun/website/manifests.yaml
ssh root@<sjy> "rm -rf /opt/we-meet-online"
```

阿里云控制台手动删 2 条 DNS A 记录 (`@`, `www`).
