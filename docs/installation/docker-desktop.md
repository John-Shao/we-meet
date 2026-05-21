# 在 Docker Desktop 部署 LaSuite Meet

本文档介绍如何在 Windows + Docker Desktop（配合 WSL2）上，使用项目自带的 kind + Tilt 工具链，跑起一份带 HTTPS、Ingress、Keycloak 的本地完整部署。

> 这是项目官方支持的本地 K8s 验证路径：[bin/start-kind.sh](../../bin/start-kind.sh) 起 kind 集群，[bin/Tiltfile](../../bin/Tiltfile) 编排镜像构建与 [src/helm](../../src/helm) 部署。Docker Desktop 仅提供 Docker 引擎，不使用其内置的 Kubernetes 功能。
>
> 仅供本机访问（`*.127.0.0.1.nip.io` 解析到 127.0.0.1），外部设备 / 手机连不进来。生产部署请参考 [kubernetes.md](kubernetes.md)。

---

## 一、前置要求

### 1. Docker Desktop 配置

在 Windows 上打开 Docker Desktop：
- **Settings → Resources → WSL Integration**：启用 Ubuntu 集成
- **Settings → Resources → Advanced**：分配 **≥ 6 CPU / 12 GiB 内存**

底下要同时跑 backend、frontend、postgres、redis、keycloak、livekit、livekit-egress、minio、celery × 3、agents × 2 等十几个 pod，资源不足会出现 OOM 或调度排队。

### 2. 进入 WSL Ubuntu 环境

`start-kind.sh` 是 bash 脚本，下面的命令都需要在 **WSL2（Ubuntu）** 内执行。

在 Windows 终端或 PowerShell 中执行：
```bash
wsl -d Ubuntu
```

### 3. WSL2 中安装的工具

| 工具 | 作用 | 安装方式 |
|---|---|---|
| kind | 在 Docker 里跑 K8s 集群 | https://kind.sigs.k8s.io/docs/user/quick-start/#installation |
| kubectl | K8s CLI | https://kubernetes.io/docs/tasks/tools/ |
| helm | K8s 包管理 | `curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 \| bash` |
| helmfile | 多 release 编排，[Tiltfile](../../bin/Tiltfile) 第 105 行依赖 | https://github.com/helmfile/helmfile/releases |
| helm-diff 插件 | helmfile 依赖 | 见下方"helm-diff 离线安装" |
| mkcert | 本地 CA 与证书 | `apt install libnss3-tools && go install filippo.io/mkcert@latest`，并 **执行 `mkcert -install`** |
| tilt | 镜像构建 + 部署 + 热同步 | 国内推荐手动下载 tar.gz，见下文 |

#### 国内网络通用准备

下面所有工具都会从 GitHub / proxy.golang.org / sum.golang.org 拉东西，国内常被切。

**第一步：安装基础工具**

```bash
sudo apt update
sudo apt install -y make curl wget git
```

**第二步：安装 Go（如果未安装）**

```bash
sudo apt install -y golang-go
```

**第三步：配置 Go 代理与校验源**

```bash
go env -w GOPROXY=https://goproxy.cn,direct
go env -w GOSUMDB=sum.golang.google.cn   # 替代被墙的 sum.golang.org
# 如果 sum.golang.google.cn 也不稳，可改用：go env -w GOSUMDB=off

# 添加 Go bin 到 PATH
export PATH=$PATH:$(go env GOPATH)/bin
echo 'export PATH=$PATH:$(go env GOPATH)/bin' >> ~/.bashrc
```

GitHub Releases / raw 文件统一加 `https://gh-proxy.com/` 前缀走镜像，备选 `ghproxy.net`、把主机改成 `kkgithub.com`。

#### Helm 安装

**方式 A：官方脚本（推荐）**

```bash
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
helm version
```

**方式 B：snap 安装**

```bash
sudo snap install helm --classic
helm version
```

> **注意**：snap 方式必须加 `--classic` 选项，否则 Helm 无法访问 `~/.kube/config` 等系统资源。官方脚本方式更稳定，版本更新更及时。

#### helm-diff 离线安装

`helm plugin install` 内部仍走 `github.com`，国内常断。手动放进插件目录：

```bash
mkdir -p /tmp/helm-diff && cd /tmp/helm-diff
curl -fL -o diff.tgz https://gh-proxy.com/https://github.com/databus23/helm-diff/releases/latest/download/helm-diff-linux-amd64.tgz

HELM_PLUGINS=$(helm env HELM_PLUGINS)
mkdir -p "$HELM_PLUGINS/helm-diff"
tar -xzf diff.tgz -C "$HELM_PLUGINS/helm-diff" --strip-components=1

helm plugin list   # 应看到 diff
helm diff version
```

#### mkcert 安装

```bash
sudo apt install -y libnss3-tools
go install filippo.io/mkcert@latest
mkcert -install
```

**重要**：把 mkcert 的根 CA 也导入 **Windows 的"受信任的根证书颁发机构"**——否则 Windows 浏览器仍会报证书不受信。

在 WSL 中复制证书到 Windows 桌面：

```bash
cp "$(mkcert -CAROOT)/rootCA.pem" /mnt/c/Users/$(cmd.exe /c "echo %USERNAME%" 2>/dev/null | tr -d '\r')/Desktop/
```

然后在 Windows PowerShell（管理员）中执行：

```powershell
cd $HOME\Desktop
certutil -f -addstore "Root" .\rootCA.pem
certutil -f -addstore -user "Root" .\rootCA.pem
```

#### kind 安装

```bash
go install sigs.k8s.io/kind@v0.23.0
kind version
```

#### helmfile 安装

```bash
curl -fL -o /tmp/helmfile.tgz \
  https://gh-proxy.com/https://github.com/helmfile/helmfile/releases/download/v0.169.2/helmfile_0.169.2_linux_amd64.tar.gz
tar -xzf /tmp/helmfile.tgz -C /tmp helmfile
sudo mv /tmp/helmfile /usr/local/bin/
helmfile -v
```

#### tilt 安装（手动方式）

官方 `install.sh` 是 `curl | tar` 管道，国内经常 curl 半路被切，tar 提取出来的 binary 是截断的，跑起来会 `Segmentation fault`。**先把 tar.gz 完整下载到本地再解压**：

```bash
curl -fL -o /tmp/tilt.tgz \
  https://gh-proxy.com/https://github.com/tilt-dev/tilt/releases/download/v0.37.3/tilt.0.37.3.linux.x86_64.tar.gz

ls -lh /tmp/tilt.tgz                # 应该 ~39MB（41049623 字节）；明显偏小说明断了，重新下

tar -xzf /tmp/tilt.tgz -C /tmp tilt
sudo mv /tmp/tilt /usr/local/bin/
sudo chmod +x /usr/local/bin/tilt

file /usr/local/bin/tilt           # 应是 ELF 64-bit LSB executable
tilt version
```

#### kubectl 安装

```bash
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl
kubectl version --client
```

#### 验证

```bash
docker version
kind version
kubectl version --client
helm version
helmfile -v
tilt version
mkcert -CAROOT
```

---

## 二、准备项目

### 进入项目目录

```bash
# 如果项目在 Windows 分区（性能较差但可用）
cd /mnt/d/workspace/we-meet

# 推荐：克隆到 WSL 原生文件系统（性能更好，inotify 文件监听正常工作）
# cd ~
# git clone <your-repo-url> we-meet
# cd we-meet
```

> **性能提示**：项目在 `/mnt/` 路径下时，Docker 构建上下文打包慢，且 Tilt 的 inotify 文件监听不工作（修改代码后需手动重启 Tilt）。建议克隆到 WSL 原生目录如 `~/we-meet`。

### 创建环境文件

```bash
make create-env-files
```

[Makefile](../../Makefile) 的 `create-env-files` 会生成 [env.d/development/](../../env.d/development) 下 7 个 env 文件，其中 `kube-secret` 会作为 `secret-dev` 注入到 K8s（[Tiltfile:99-103](../../bin/Tiltfile#L99-L103)）。**纯本地跑可直接用默认 dist**——总结/转写依赖外部 LLM/WhisperX 的部分不会工作，但会议主链路 OK。

---

## 三、启动 kind 集群

```bash
./bin/start-kind.sh
```

> ⚠️ Makefile 里的 `make build-k8s-cluster` target 只声明了依赖文件、没写 recipe，跑出来会显示 `Nothing to be done`——直接调脚本即可。第一次跑前可能需要 `chmod +x ./bin/start-kind.sh`。

**脚本执行内容**：

1. mkcert 给 `*.127.0.0.1.nip.io` 签本地证书
2. 启动 `localhost:5001` 的本地 Docker registry 容器（kind 节点会信任它）
3. `kind create cluster --name suite`——**单 control-plane 节点**，80/443 通过 `extraPortMappings` 映射到 host
4. 修改 CoreDNS，让 `*.127.0.0.1.nip.io` 在集群内部解析到 ingress-nginx service
5. 安装 ingress-nginx，把 mkcert 证书装成默认 TLS secret
6. 创建 `meet` namespace 并切到该 context
7. 注入 `certifi` configmap（包含 mkcert rootCA），供 backend / agents 容器挂载，避免对内部回调禁用 SSL 校验
8. 等待所有系统 pod ready

**验证集群**：

```bash
kind get clusters                             # 应显示 suite
kubectl cluster-info --context kind-suite
kubectl get nodes                             # 应显示 1 个 control-plane 节点
kubectl -n ingress-nginx get pods            # ingress-nginx-controller 应 Running
docker ps --filter name=kind-registry         # 本地 registry 容器
```

---

## 四、使用 Tilt 部署应用

二选一：

```bash
# A. 本地 Keycloak 做 OIDC（最快路径，推荐）
make start-tilt-keycloak

# B. dinum 风格前端 + Pro Connect 风格
make start-tilt-dinum
```

**Tilt 会自动执行**：
1. 构建 backend、frontend、agents 镜像
2. 推送到本地 registry (`localhost:5001`)
3. 部署 PostgreSQL、Redis、Keycloak、LiveKit、MinIO 等依赖
4. 部署 we-meet 应用（backend、frontend、celery workers、agents）
5. 配置 Ingress 路由

**监控部署进度**：

Tilt 会自动打开浏览器显示 UI（通常是 `http://localhost:10350`），可实时查看：
- 镜像构建进度
- Pod 状态
- 日志输出

或在终端查看：
```bash
kubectl get pods -n meet
```

等待所有 Pod 变为 `Running` 状态（**首次部署约需 10-15 分钟**，需下载基础镜像并构建）。

**Tilt 执行细节**：

- 并行构建 5 个镜像并推到 `localhost:5001`：
  - `meet-backend`（Django + Celery）
  - `meet-frontend-generic` / `meet-frontend-dinum`
  - `meet-summary`（FastAPI 总结服务）
  - `meet-agents`（LiveKit 转写/元数据 agent）
  - `meet-livekit`（注入 mkcert rootCA 的自定义 LiveKit）
- 注入 `secret-dev`（来自 `env.d/development/kube-secret`）
- 调用 `helmfile -e dev-keycloak template .` 渲染并部署 4 个 release：`extra`（namespace 资源 / Keycloak realm）、`meet`、`livekit`、`livekit-egress`
- 按依赖拉起 pod：`postgresql → minio → redis → livekit → meet-backend → migrate → createsuperuser → frontend / celery / agents`

---

## 五、访问服务

等 Tilt UI 内所有资源变绿后，浏览器打开：

| 服务 | URL | 默认凭据 |
|---|---|---|
| **Meet 应用** | https://meet.127.0.0.1.nip.io | Keycloak 用户 `meet/meet` |
| **Keycloak 管理台** | https://keycloak.127.0.0.1.nip.io | `admin/admin` |
| MinIO 控制台 | https://minio.127.0.0.1.nip.io | `meet/password` |
| LiveKit | wss://livekit.127.0.0.1.nip.io | 后端自动使用 |
| Tilt UI | http://localhost:10350 | — |

**首次登录**：
1. 访问 https://meet.127.0.0.1.nip.io
2. 点击登录，跳转到 Keycloak
3. 使用测试账号 `meet/meet` 或注册新用户

---

## 六、常见问题

### 1. Ubuntu apt 源连接超时

**现象**：执行 `sudo apt install` 时报错 `Cannot initiate the connection to archive.ubuntu.com:80` 或 `connection timed out`。

**解决方案**：替换为国内镜像源

```bash
# 备份原始源
sudo cp /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list.d/ubuntu.sources.bak

# 替换为阿里云镜像源
sudo sed -i 's|http://archive.ubuntu.com|https://mirrors.aliyun.com|g' /etc/apt/sources.list.d/ubuntu.sources
sudo sed -i 's|http://security.ubuntu.com|https://mirrors.aliyun.com|g' /etc/apt/sources.list.d/ubuntu.sources

# 更新索引
sudo apt update
```

**其他可选镜像源**（如果阿里云也慢）：

```bash
# 清华源
sudo sed -i 's|https://mirrors.aliyun.com|https://mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/ubuntu.sources

# 中科大源
sudo sed -i 's|https://mirrors.aliyun.com|https://mirrors.ustc.edu.cn|g' /etc/apt/sources.list.d/ubuntu.sources

# 华为云源
sudo sed -i 's|https://mirrors.aliyun.com|https://mirrors.huaweicloud.com|g' /etc/apt/sources.list.d/ubuntu.sources
```

换源后重新执行：`sudo apt update && sudo apt install -y <package>`

### 2. 浏览器报证书不受信

WSL 里执行过 `mkcert -install` 之后，还要把 `$(mkcert -CAROOT)/rootCA.pem` 导入到 Windows 的"受信任的根证书颁发机构"。Firefox 走自带证书库，需要单独导入。

### 2. `*.127.0.0.1.nip.io` 解析不出来

公司 DNS 拦截 nip.io 时，给 Windows hosts 文件 `C:\Windows\System32\drivers\etc\hosts` 加：

```
127.0.0.1 meet.127.0.0.1.nip.io keycloak.127.0.0.1.nip.io livekit.127.0.0.1.nip.io minio.127.0.0.1.nip.io
```

另一个变体：浏览器报 `ERR_CONNECTION_CLOSED`，但 WSL 里 `curl -k https://meet.127.0.0.1.nip.io` 能拿到 200。这是 **VPN/代理软件**（Clash、V2Ray、Veee 等）把 `*.nip.io` 当远程域名转发到代理服务器，代理无法访问本机 kind。在代理的 rules 顶部加直连规则：

```yaml
# Clash / Mihomo 风格
rules:
  - DOMAIN-SUFFIX,nip.io,DIRECT
  - DOMAIN-SUFFIX,127.0.0.1.nip.io,DIRECT
  # ... 原有规则
```

或在系统代理"对以下条目不使用代理"框里加 `*.nip.io;127.0.0.1.nip.io;localhost;127.0.0.1`，然后 reload 配置 / 强刷浏览器。

### 3. 80 / 443 端口被占用

IIS、Skype、其他 nginx 都可能占用。`netstat -ano | findstr :443` 查 PID，再到任务管理器关掉。

### 4. Pod OOMKilled / 调度不出来

Docker Desktop 资源拉到 6 CPU / 12 GiB 以上。检查资源：
```bash
kubectl top nodes
kubectl describe pod <pod-name> -n meet
```

### 5. 镜像拉取失败

检查本地 registry：
```bash
docker ps | grep registry
curl http://localhost:5001/v2/_catalog
```

### 6. Tilt 文件监听不工作（/mnt/d 路径）

项目在 Windows 分区时，inotify 不工作。修改代码后需手动重启：
```bash
# Ctrl+C 停止 Tilt
docker buildx prune -f
make start-tilt-keycloak
```

长远建议把项目克隆到 WSL 原生目录（如 `~/we-meet`），跨文件系统的 inotify 失灵 + Docker 构建上下文打包慢都会消失。

### 7. Egress 录制不工作

livekit-egress 需要信任本地 mkcert CA 才能访问 `https://meet.127.0.0.1.nip.io` 的内部回调，[Tiltfile:82-96](../../bin/Tiltfile#L82-L96) 已经把 `rootCA.pem` 注入到自定义 livekit 镜像。如果仍失败，看 egress pod 日志确认证书路径。

### 8. `helm plugin install` / `kind` / `tilt` 下载失败

GitHub Releases 在国内常被中断。参考第一节"helm-diff 离线安装"中的 `gh-proxy.com` 写法套用。或者给 WSL 配 Windows 代理：

```bash
HOST_IP=$(ip route show | grep -i default | awk '{print $3}')
export HTTPS_PROXY=http://$HOST_IP:7890
export HTTP_PROXY=http://$HOST_IP:7890
```

注意 Windows 代理软件需要打开"允许局域网连接"，否则 WSL 连不上。

### 9. `auth.docker.io: i/o timeout` / 拉 Docker Hub 镜像超时

Docker Desktop → Settings → Docker Engine 加镜像加速器：

```json
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://docker.1ms.run",
    "https://hub.rat.dev",
    "https://docker.1panel.live"
  ]
}
```

Apply & Restart 之后，kind 节点容器会跟着重启；如果集群状态异常，`kind delete cluster --name suite && ./bin/start-kind.sh` 重建。

### 10. 构建容器时 `apt-get` 拉 deb.debian.org 超时 / EOF

只有 [src/agents/Dockerfile](../../src/agents/Dockerfile) 用 apt（基于 `python:3.13-slim` / Debian trixie），构建时容器里要从 `deb.debian.org` 拉包。Docker 镜像加速器只代理 image pull，**不代理容器内的 apt 流量**，所以这一步会单独卡住。后端 / summary 用 Alpine `apk`、前端用 npm，遇到类似问题时各自换源思路相同。

实测清华源（mirrors.tuna.tsinghua.edu.cn）在 trixie 上极不稳定（`500 unexpected EOF` / 连接重置 / 1.7 KB/s）；**阿里云稳得多**。备选：`mirrors.ustc.edu.cn`、`mirrors.huaweicloud.com`、`mirrors.cloud.tencent.com`。

下面给出完整的临时补丁方案（不入库，仅本地用）。

#### 方式 A：手动编辑 Dockerfile

找到 [src/agents/Dockerfile](../../src/agents/Dockerfile) 顶部：

```dockerfile
FROM python:3.13.13-slim AS base

# Install system dependencies required by LiveKit
RUN apt-get update && apt-get install -y \
    libglib2.0-0 \
    libgobject-2.0-0 \
    && rm -rf /var/lib/apt/lists/*
```

在 `FROM` 行下面、`RUN apt-get update` 之前，**插入** 4 行：

```dockerfile
FROM python:3.13.13-slim AS base

# ---- LOCAL-DEV ONLY (China network workaround) — REVERT BEFORE COMMIT ----
RUN sed -i 's|http://deb.debian.org|https://mirrors.aliyun.com|g; s|http://security.debian.org|https://mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources && \
    printf 'Acquire::Retries "5";\nAcquire::http::Timeout "120";\nAcquire::https::Timeout "120";\n' > /etc/apt/apt.conf.d/80-retries
ENV PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
ENV PIP_TRUSTED_HOST=mirrors.aliyun.com
# ---- END LOCAL-DEV PATCH ----

# Install system dependencies required by LiveKit
RUN apt-get update && apt-get install -y \
    libglib2.0-0 \
    libgobject-2.0-0 \
    && rm -rf /var/lib/apt/lists/*
```

每行作用：
- **第 1 行 sed**：替换 `/etc/apt/sources.list.d/debian.sources` 里的 Debian 主源 + 安全更新源到阿里云 HTTPS
- **第 2 行 printf**：apt 网络重试 5 次、读写超时 120 秒，对偶发抖动有韧性
- **`PIP_INDEX_URL`**：pip 也走阿里云镜像，否则装 `livekit-agents` 等大依赖会再卡一次
- **`PIP_TRUSTED_HOST`**：阿里云 pypi 镜像走 HTTPS，理论不需要这条；写上是为了应付偶发的 SSL 异常

#### 方式 B：一行 sed 自动注入（推荐）

每次重新克隆仓库 / 切换分支后都要重新打这个补丁，命令化更省事：

```bash
# 在仓库根目录执行
sed -i '/^FROM python:3.13.13-slim AS base$/a\
\
# ---- LOCAL-DEV ONLY (China network workaround) — REVERT BEFORE COMMIT ----\
RUN sed -i '\''s|http://deb.debian.org|https://mirrors.aliyun.com|g; s|http://security.debian.org|https://mirrors.aliyun.com|g'\'' /etc/apt/sources.list.d/debian.sources \&\& \\\
    printf '\''Acquire::Retries "5";\\nAcquire::http::Timeout "120";\\nAcquire::https::Timeout "120";\\n'\'' > /etc/apt/apt.conf.d/80-retries\
ENV PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/\
ENV PIP_TRUSTED_HOST=mirrors.aliyun.com\
# ---- END LOCAL-DEV PATCH ----' src/agents/Dockerfile
```

#### 应用补丁后

1. 改完后 Tilt 不会自动检测到（参见第 6 条 inotify 问题），**需要重启 Tilt**：

   ```bash
   # 在跑 Tilt 的终端 Ctrl+C
   docker buildx prune -f          # 清掉旧 Dockerfile 对应的 BuildKit 层缓存
   make start-tilt-keycloak
   ```

2. Tilt UI 里看 `meet-agent-metadata` build log 顶部，确认 Dockerfile 内容里包含 `mirrors.aliyun.com`，并且 `apt-get update` 这一步秒过到 `Reading package lists... Done`，就稳了。

#### 回退（提交前必做）

```bash
git restore src/agents/Dockerfile
```

如果你已经把改动 stage / commit 了，分别用 `git restore --staged src/agents/Dockerfile` 取消暂存，或 `git reset HEAD~1` 撤销最近一次 commit。

#### 为什么不入库？

- 把镜像源固化到 Dockerfile 让海外贡献者 / CI 拉不到阿里云（CI 没有镜像源访问限制时很慢）
- 上游 LaSuite Meet 是法国政府开源项目，镜像源的中国本地化属于环境配置，不应混入业务代码
- 真要长期共存，正确做法是改成 `ARG APT_MIRROR=` 默认空、Tiltfile 里通过 `build_args` 注入——但这个改动较大，本地开发临时补丁性价比低

---

## 七、停止与清理

```bash
# 停止 Tilt
tilt down -f ./bin/Tiltfile

# 销毁整个 kind 集群（最干净）
kind delete cluster --name suite
docker rm -f kind-registry        # 顺手清掉本地 registry 容器
```

---

## 八、何时不该走这条路径

如果只是想本地开发后端 / 前端代码、不关心 K8s 部署链路，[compose.md](compose.md) 里 `make bootstrap` 的 docker-compose 路径更轻量、不需要 kind / Tilt / mkcert，启动更快。

完整的 K8s 部署语义、HTTPS、Ingress、Keycloak、Egress 录制等只有 kind + Tilt 路径能验证完整。

---

## 九、下一步

- 修改 `env.d/development/` 下的环境变量启用 AI 功能（总结、转写）
- 阅读 [kubernetes.md](kubernetes.md) 了解生产环境部署
- 查看 [compose.md](compose.md) 了解轻量级开发环境
