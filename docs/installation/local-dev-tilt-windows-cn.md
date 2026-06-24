# 本地开发环境搭建指南（Windows + 国内网络，基于 Tilt/kind）

> 本文是 we-meet 在 **Windows + 国内网络** 下用 **Tilt + kind** 跑通整栈的实践手册，记录了完整步骤与踩过的坑。
> 上游英文版见 [`developping_locally.md`](../developping_locally.md)；`installation/compose.md` 标注为 **experimental**，**本项目不推荐 compose**，统一走 Tilt。

---

## 0. 为什么用 Tilt 而不是 Compose

- `docs/installation/compose.md` 自身标注 **experimental**，且 dev 镜像的 `/app/.venv` 有 magic/django-filter 等坑，不可靠。
- **Tilt 跑 `src/helm/meet` 的 helm chart，最接近生产**，构建正经镜像，热更新（live_update）。
- 代价：要装一套 K8s 工具链、首次较重，但一旦跑通后续很稳。

整栈组件：React 前端 + Django 后端 + LiveKit + Summary(FastAPI) + Celery，依赖 PostgreSQL / Redis / MinIO / Keycloak。全部由 Tilt 部署进一个 kind 单节点集群，经 ingress-nginx 暴露在 `https://*.127.0.0.1.nip.io`。

---

## 1. 前置工具（Windows）

| 工具 | 装法 | 备注 |
|---|---|---|
| Docker Desktop | 官网安装包 **单独装**（见下方警告） | WSL2 后端 |
| kind | `choco install kind -y` | |
| helm | `choco install kubernetes-helm -y` | helm v4 实测兼容 |
| mkcert | `choco install mkcert -y` + `mkcert -install` | 生成并信任本地 CA（TLS） |
| tilt | `choco install tilt -y` | |
| helmfile | **choco 没有** → [github releases](https://github.com/helmfile/helmfile/releases) 下 `helmfile_*_windows_amd64.tar.gz`，解压把 `helmfile.exe` 放进任意 PATH 目录（如 `%LOCALAPPDATA%\Microsoft\WindowsApps`） | |
| kubectl | 随 Docker Desktop | |

> ⚠️ **坑：别让 choco 管 Docker Desktop。** `choco install kind` 会把 `docker-desktop` 当依赖**顺手升级**，可能搞坏现有 DD（`docker pull` 报 `500 ... check if the server supports the requested API version`）。若已被它装/升：`choco install docker-desktop --force -y` 重装 + **重启 Windows**，之后 `choco pin add -n docker-desktop` 锁住。
>
> ⚠️ Docker Desktop 的「Kubernetes」开关（kind 类型）**不等于** kind CLI，也不提供 `kind` 命令、没有我们要的 80/443+registry+ingress 配置。**建议关掉 DD 自带 k8s**（省内存、避免 kubectl context 混乱）。

验证：`kind version && tilt version && helm version && helmfile --version && mkcert -CAROOT` 全有输出。

约定：下文 `$PROXY` = 你的本地代理 HTTP 地址（如 `http://127.0.0.1:7890`）。国内拉镜像/脚本强依赖它。

---

## 2. 建 kind 集群

`bin/start-kind.sh` = `curl raw.githubusercontent.com/numerique-gouv/tools/.../create_cluster.sh | bash -s -- meet`。
传 `meet` 是 **APPLICATION（namespace）**，集群名取默认 **`suite`**（脚本签名 `CLUSTERNAME=${2:-suite}`）。所以集群叫 `suite`、namespace 叫 `meet`，`kubectl` context 是 `kind-suite`。

该脚本干的事：建本地 registry(`kind-registry:5001`) → `kind create cluster`（含 80/443 端口映射、containerd registry 配置）→ 装 ingress-nginx → 建 namespace `meet` + mkcert/certifi secret。

### 国内必做的两点改造

1. **预抓 raw.githubusercontent 的 3 个 YAML**（国内常被墙），改成本地文件：
```bash
P=$PROXY
curl -x $P -sL -o /tmp/ingress-deploy.yaml          "https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml"
curl -x $P -sL -o /tmp/custom-default-backend.yaml  "https://raw.githubusercontent.com/kubernetes/ingress-nginx/refs/heads/main/docs/examples/customization/custom-errors/custom-default-backend.yaml"
curl -x $P -sL -o /tmp/cacert-base.pem              "https://raw.githubusercontent.com/certifi/python-certifi/refs/heads/master/certifi/cacert.pem"
curl -x $P -sL -o /tmp/create_cluster.sh            "https://raw.githubusercontent.com/numerique-gouv/tools/refs/heads/main/kind/create_cluster.sh"
sed -e 's|kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml|kubectl apply -f /tmp/ingress-deploy.yaml|' \
    -e 's|kubectl apply -n ingress-nginx -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/refs/heads/main/docs/examples/customization/custom-errors/custom-default-backend.yaml|kubectl apply -n ingress-nginx -f /tmp/custom-default-backend.yaml|' \
    -e 's|curl https://raw.githubusercontent.com/certifi/python-certifi/refs/heads/master/certifi/cacert.pem -o /tmp/cacert.pem|cp /tmp/cacert-base.pem /tmp/cacert.pem|' \
    /tmp/create_cluster.sh > /tmp/create_cluster.local.sh
```

2. **用 `host.docker.internal` 作代理跑脚本**，让 kind 把代理**注入节点的 containerd**（节点内 `127.0.0.1` 无效，必须用 `host.docker.internal`）。这样节点能经代理拉 registry.k8s.io / ghcr.io / docker.io：
```bash
cd /tmp
HTTP_PROXY="http://host.docker.internal:<代理端口>" \
HTTPS_PROXY="http://host.docker.internal:<代理端口>" \
NO_PROXY="localhost,127.0.0.1,::1,kind-registry,.svc,.cluster.local,10.96.0.0/12,10.244.0.0/16" \
bash /tmp/create_cluster.local.sh meet
```
跑完出现 `🎉 Cluster is fully ready!` 即成功（ingress-nginx 等 pod 全 Running）。

---

## 3. Tilt 部署整栈

前置：`env.d/development/` 里的 env 文件齐全（`kube-secret` 等；缺则从 `.dist` 复制）。

### 先解决国内镜像并发拉取超时

`tilt up` 会**同时构建 5 个镜像 + 部署一堆 pod**，并发拉国际 registry 容易 `TLS handshake timeout`。对策：**主机串行+重试预拉所有镜像**（主机经代理串行拉是稳的），构建基础镜像缓存给 buildkit、app 镜像让节点经注入代理拉：
```bash
export HTTP_PROXY=$PROXY HTTPS_PROXY=$PROXY NO_PROXY=localhost,127.0.0.1
pr(){ docker image inspect "$1" >/dev/null 2>&1 || for n in 1 2 3 4 5 6; do docker pull "$1" && break || sleep 6; done; }
# 构建基础镜像（供 buildkit，避免 tilt 构建时再拉）
for i in node:20 node:20-alpine python:3.13-alpine3.23 python:3.13.13-slim python:3.13.5-alpine3.21 \
         nginxinc/nginx-unprivileged:alpine3.23 livekit/livekit-server:v1.12.0 ghcr.io/astral-sh/uv:0.10.9; do pr "$i"; done
```

> ⚠️ **别用 `kind load docker-image`**。Docker Desktop 启用了 containerd 镜像存储，`kind load` 会报 `ctr: content digest ... not found`。让节点经注入代理自己拉即可（kubelet 默认串行拉镜像，预拉了构建基础镜像后代理不再被构建占用，节点拉取就顺了）。

### 启动 Tilt

```bash
cd <repo 根>
export HTTPS_PROXY=$PROXY HTTP_PROXY=$PROXY NO_PROXY=localhost,127.0.0.1,.svc,.cluster.local
DEV_ENV=dev-keycloak tilt up --namespace=meet -f ./bin/Tiltfile
```
- 监控：`http://localhost:10350/`
- 访问：`https://meet.127.0.0.1.nip.io/`
- 首次构建+部署约 5–15 分钟。

---

## 4. 已知坑与对策

| 现象 | 原因 | 对策 |
|---|---|---|
| Tiltfile 解析失败 `environment(${DEV_ENV:-dev-keycloak})` / copy-root-ca `missing destination` | Tilt 在 Windows 用 **cmd.exe** 跑 `local()`，不展开 bash 的 `${VAR:-default}`、`$(...)` | **已在 `bin/Tiltfile` 修复**（Starlark 层代入值，提交 `51cffe20`）。再遇类似 local() 命令同法处理。 |
| `meet-backend` 迟迟不部署 | 它 `resource_deps` 依赖 `livekit-livekit-server`，而 livekit 单节点 **hostPort + RollingUpdate 死锁**（镜像重建触发滚动更新，新 pod 抢不到旧 pod 占的端口） | `kubectl patch deploy livekit-livekit-server -n meet --type=json -p '[{"op":"replace","path":"/spec/strategy/type","value":"Recreate"},{"op":"remove","path":"/spec/strategy/rollingUpdate"}]'` |
| `curl https://meet.127.0.0.1.nip.io` 报 `schannel: failed to receive handshake` | Windows git-curl 用 schannel 与 ingress TLS 握手的客户端怪癖，**非应用问题** | 用**浏览器**验证；或集群内 `kubectl exec` 用 python urllib 带 Host 头测 |
| `docker pull` 报 500 API 版本错 | choco 升级 Docker Desktop 后引擎没重启 | `choco install docker-desktop --force -y` + 重启 Windows |
| livekit 第二副本一直 Pending `didn't have free ports` | 单节点 hostPort 冲突（滚动更新的 surge pod） | 同上 Recreate；或删掉占端口的旧 pod |

---

## 5. C 盘空间（Docker 数据迁到 D:）

Docker(WSL2) 全部数据在 `docker-desktop` 发行版的 vhdx（`%LOCALAPPDATA%\Docker\wsl\disk\docker_data.vhdx`，本项目实测 ~29G）。

- **删 Docker 内部镜像不会缩小 vhdx**（不自动回收到宿主），C 盘不释放。
- 真正腾 C 盘：**Docker Desktop → Settings → Resources → Advanced → Disk image location** 改到 `D:\ProgramData\DockerDesktop` → Apply & Restart。DD 安全迁移整盘，**kind 集群随 DD 重启自动恢复**（数据都在被搬走的 vhdx 里）。
- ⚠️ 别用 `wsl --manage --move` 或手改 DD 配置硬搬这个数据盘——容易丢集群和镜像；就用 DD 设置界面。

---

## 6. dev 登录（手机验证码 / 扫码）

we-meet 把登录改成了**手机 OTP / 扫码**（`core/api/mobile_auth.py`）。dev 默认**没配登录依赖**，点「发送验证码」会 **503**：
- 发码走火山引擎短信 → dev 无 `VOLC_SMS_*` 凭证 → 报错 503；
- 校验码还需 Keycloak **token-exchange**（`meet-service` 客户端）→ dev 也没配。

**dev 登录正路 = 内置 demo 账号**（`SendOtpView` 第 245-253 行：手机号在 `MOBILE_AUTH_DEMO_PHONES` 且设了 `MOBILE_AUTH_DEMO_OTP` 时跳过短信、用固定码）。本次实践已配通，两步：

> dev keycloak 启动参数含 `--features=preview`，**token-exchange 已自带开启**，无需再改容器。

**① dev Keycloak 建 `meet-service` 客户端**（用 pod 内 `kcadm.sh` 走 localhost:8080，避开 nip.io 的 schannel TLS）：
```bash
kubectl exec -n meet keycloak-0 -- bash -c '
KC=/opt/keycloak/bin/kcadm.sh; SECRET=dev-meet-service-secret-0123456789
$KC config credentials --server http://localhost:8080 --realm master --user admin --password admin
$KC create clients -r meet -s clientId=meet-service -s enabled=true -s publicClient=false \
  -s standardFlowEnabled=false -s directAccessGrantsEnabled=false -s serviceAccountsEnabled=true -s "secret=$SECRET" || true
CID=$($KC get clients -r meet -q clientId=meet-service | grep -o "[0-9a-f-]\{36\}" | head -1)
$KC update clients/$CID -r meet -s serviceAccountsEnabled=true -s "secret=$SECRET"
$KC add-roles -r meet --uusername service-account-meet-service --cclientid realm-management \
  --rolename view-users --rolename query-users --rolename manage-users --rolename impersonation
'
```

**② 后端配 demo OTP + service secret**（dev keycloak admin = `admin/admin`）：
```bash
kubectl set env deployment/meet-backend -n meet \
  MOBILE_AUTH_SERVICE_CLIENT_SECRET=dev-meet-service-secret-0123456789 \
  MOBILE_AUTH_DEMO_OTP=123456 \
  MOBILE_AUTH_DEMO_PHONES=13800000000,13800000006
kubectl rollout status deployment/meet-backend -n meet
```

**登录**：`https://meet.127.0.0.1.nip.io` → 验证码登录 → 手机号 `13800000000`（或 `13800000006`）→ 发送验证码 → 输 `123456` → 进。

> ⚠️ **持久化**：meet-service 客户端存在 keycloak DB（持久）；后端 `kubectl set env` 在 deployment spec 上（扛 pod/DD 重启），但 **tilt 重新 apply meet-backend 时会被还原** → 那就重跑第 ② 步，或把这三个变量写进 `env.d/development/kube-secret`（tilt 的 `secret-dev` 源）以永久生效。生产用真实火山引擎 SMS + `bootstrap-mobile.sh`，demo 账号仅限本地 dev。

---

## 7. 验证

```bash
kubectl get pods -n meet                 # 全部 Running/Completed
# 集群内测 ingress→应用（绕开 schannel）
kubectl exec -n meet <meet-backend-pod> -- python -c "
import urllib.request, ssl
ctx=ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE
def g(p):
    r=urllib.request.Request('https://ingress-nginx-controller.ingress-nginx.svc.cluster.local'+p, headers={'Host':'meet.127.0.0.1.nip.io'})
    return urllib.request.urlopen(r, context=ctx, timeout=12).status
print('frontend', g('/')); print('config', g('/api/v1.0/config/'))"
```
浏览器开 `https://meet.127.0.0.1.nip.io`（mkcert CA 已信任，无证书警告）。

---

## 8. 桌面 Electron 联调

桌面外壳（`src/desktop`）指向本地栈即可：
```powershell
cd src\desktop
$env:WEMEET_RENDERER_URL="https://meet.127.0.0.1.nip.io"; npm run dev
```

---

## 9. 常用命令速查

```bash
# Tilt
tilt up --namespace=meet -f ./bin/Tiltfile     # 启动（加 DEV_ENV=dev-keycloak）
tilt get uiresources                            # 资源状态
#   Web UI http://localhost:10350/ ：状态灯 / 日志 / 重建按钮 / "Run database migration" 按钮

# kubectl（namespace meet）
kubectl get pods -n meet [-w]
kubectl logs -n meet <pod> -f
kubectl exec -n meet <meet-backend-pod> -- python manage.py migrate --no-input

# 集群
kind get clusters                               # 应见 suite
kubectl config current-context                  # kind-suite
```

---

## 10. 关键事实速记

- 集群名 `suite`、namespace `meet`、context `kind-suite`、ingress `*.127.0.0.1.nip.io`、本地 registry `localhost:5001`。
- 节点拉镜像走 kind 在建集群时注入的代理（`host.docker.internal:<端口>`）。
- helm v4、livekit chart 均实测可用。
- 桌面/移动 OIDC 必须系统浏览器 + PKCE，禁内嵌 webview（生产）。
