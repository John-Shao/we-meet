# 在 Docker Desktop 部署 LaSuite Meet

本文档介绍如何在 Windows + Docker Desktop（配合 WSL2）上，使用项目自带的 kind + Tilt 工具链，跑起一份带 HTTPS、Ingress、Keycloak 的本地完整部署。

> 这是项目官方支持的本地 K8s 验证路径：[bin/start-kind.sh](../../bin/start-kind.sh) 起 kind 集群，[bin/Tiltfile](../../bin/Tiltfile) 编排镜像构建与 [src/helm](../../src/helm) 部署。Docker Desktop 仅提供 Docker 引擎，不使用其内置的 Kubernetes 功能。
>
> 仅供本机访问（`*.127.0.0.1.nip.io` 解析到 127.0.0.1），外部设备 / 手机连不进来。生产部署请参考 [kubernetes.md](kubernetes.md)。

---

## 一、前置要求

### Docker Desktop

- 启用 **WSL2 集成**（Settings → Resources → WSL Integration）。
- 资源建议 **≥ 6 CPU / 12 GiB**（Settings → Resources → Advanced）。底下要同时跑 backend、frontend、postgres、redis、keycloak、livekit、livekit-egress、minio、celery × 3、agents × 2 等十几个 pod，资源不足会出现 OOM 或调度排队。

### WSL2 中安装的工具

`start-kind.sh` 是 bash 脚本，下面的命令都建议在 **WSL2（Ubuntu）** 内执行。

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

下面所有工具都会从 GitHub / proxy.golang.org / sum.golang.org 拉东西，国内常被切。先把 Go 代理与校验源切到国内镜像：

```bash
go env -w GOPROXY=https://goproxy.cn,direct
go env -w GOSUMDB=sum.golang.google.cn   # 替代被墙的 sum.golang.org
# 如果 sum.golang.google.cn 也不稳，可改用：go env -w GOSUMDB=off
```

GitHub Releases / raw 文件统一加 `https://gh-proxy.com/` 前缀走镜像，备选 `ghproxy.net`、把主机改成 `kkgithub.com`。

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

`go install` 之后二进制在 `~/go/bin/mkcert`，PATH 没收录的话补一行：

```bash
go install filippo.io/mkcert@latest
export PATH=$PATH:$(go env GOPATH)/bin
echo 'export PATH=$PATH:$(go env GOPATH)/bin' >> ~/.bashrc

mkcert -install
```

把 mkcert 的根 CA 也导入 **Windows 的"受信任的根证书颁发机构"**——否则 Windows 浏览器仍会报证书不受信：

```bash
cp "$(mkcert -CAROOT)/rootCA.pem" /mnt/c/Users/<你>/Desktop/
```

PowerShell（管理员）：

```powershell
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
mv /tmp/helmfile /usr/local/bin/
helmfile -v
```

#### tilt 安装（手动方式）

官方 `install.sh` 是 `curl | tar` 管道，国内经常 curl 半路被切，tar 提取出来的 binary 是截断的，跑起来会 `Segmentation fault`。**先把 tar.gz 完整下载到本地再解压**：

```bash
curl -fL -o /tmp/tilt.tgz \
  https://gh-proxy.com/https://github.com/tilt-dev/tilt/releases/download/v0.37.3/tilt.0.37.3.linux.x86_64.tar.gz

ls -l /tmp/tilt.tgz                # 应该 ~39MB（41049623 字节）；明显偏小说明断了，重新下

tar -xzf /tmp/tilt.tgz -C /tmp tilt
mv /tmp/tilt /usr/local/bin/
chmod +x /usr/local/bin/tilt

file /usr/local/bin/tilt           # 应是 ELF 64-bit LSB executable
tilt version
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

WSL 内访问 Windows 项目目录（建议把项目克隆到 WSL 文件系统下，性能显著更好；不挪动也能跑）：

```bash
cd /mnt/d/workspace/Meeting/we-meet

# 创建本地 env 文件（从 .dist 拷贝）
make create-env-files
```

[Makefile](../../Makefile) 的 `create-env-files` 会生成 [env.d/development/](../../env.d/development) 下 7 个 env 文件，其中 `kube-secret` 会作为 `secret-dev` 注入到 K8s（[Tiltfile:99-103](../../bin/Tiltfile#L99-L103)）。**纯本地跑可直接用默认 dist**——总结/转写依赖外部 LLM/WhisperX 的部分不会工作，但会议主链路 OK。

---

## 三、起 kind 集群

```bash
./bin/start-kind.sh
```

> ⚠️ Makefile 里的 `make build-k8s-cluster` target 只声明了依赖文件、没写 recipe，跑出来会显示 `Nothing to be done`——直接调脚本即可。第一次跑前可能需要 `chmod +x ./bin/start-kind.sh`。

脚本内部做了：

1. mkcert 给 `*.127.0.0.1.nip.io` 签本地证书；
2. 起一个 `localhost:5001` 的本地 Docker registry 容器（kind 节点会信任它）；
3. `kind create cluster --name suite`——**单 control-plane 节点**，80/443 通过 `extraPortMappings` 映射到 host；
4. 改 CoreDNS，让 `*.127.0.0.1.nip.io` 在集群内部解析到 ingress-nginx service；
5. 装 ingress-nginx，把 mkcert 证书装成默认 TLS secret；
6. 创建 `meet` namespace 并切到该 context；
7. 注入 `certifi` configmap（包含 mkcert rootCA），供 backend / agents 容器挂载，避免对内部回调禁用 SSL 校验；
8. 等所有系统 pod ready。

验证：

```bash
kubectl cluster-info --context kind-suite
kubectl -n ingress-nginx get pods            # ingress-nginx-controller 应 Running
kind get clusters                             # 列出 suite
docker ps --filter name=kind-registry         # 本地 registry 容器
```

---

## 四、用 Tilt 拉起整套服务

二选一：

```bash
# A. 本地 Keycloak 做 OIDC（最快路径，推荐）
make start-tilt-keycloak

# B. dinum 风格前端 + Pro Connect 风格
make start-tilt-dinum
```

Tilt 会按 [Tiltfile](../../bin/Tiltfile) 的描述：

- 并行构建 5 个镜像并推到 `localhost:5001`：
  - `meet-backend`（Django + Celery）
  - `meet-frontend-generic` / `meet-frontend-dinum`
  - `meet-summary`（FastAPI 总结服务）
  - `meet-agents`（LiveKit 转写/元数据 agent）
  - `meet-livekit`（注入 mkcert rootCA 的自定义 LiveKit）
- 注入 `secret-dev`（来自 `env.d/development/kube-secret`）；
- 调用 `helmfile -e dev-keycloak template .` 渲染并部署 4 个 release：`extra`（namespace 资源 / Keycloak realm）、`meet`、`livekit`、`livekit-egress`；
- 按依赖拉起 pod：`postgresql → minio → redis → livekit → meet-backend → migrate → createsuperuser → frontend / celery / agents`；
- 启动 Tilt UI：默认 http://localhost:10350，实时看日志、健康状态，按按钮触发 makemigrations/migrate。

第一次构建拉镜像 10–20 分钟。

---

## 五、访问

等 Tilt UI 内所有资源变绿后，浏览器打开：

| 服务 | URL | 默认凭据 |
|---|---|---|
| Meet 应用 | https://meet.127.0.0.1.nip.io | Keycloak 用户 `meet/meet` |
| Keycloak 管理台 | https://keycloak.127.0.0.1.nip.io | `admin/admin` |
| MinIO 控制台 | https://minio.127.0.0.1.nip.io | `meet/password` |
| LiveKit | wss://livekit.127.0.0.1.nip.io | 后端自动使用 |
| Tilt UI | http://localhost:10350 | — |

---

## 六、常见问题

1. **浏览器报证书不受信**
   WSL 里执行过 `mkcert -install` 之后，还要把 `$(mkcert -CAROOT)/rootCA.pem` 导入到 Windows 的"受信任的根证书颁发机构"。Firefox 走自带证书库，需要单独导入。

2. **`*.127.0.0.1.nip.io` 解析不出来**
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

3. **80 / 443 端口被占**
   IIS、Skype、其他 nginx 都可能占用。`netstat -ano | findstr :443` 查 PID，再到任务管理器关掉。

4. **Pod OOMKilled / 调度不出来**
   Docker Desktop 资源拉到 6 CPU / 12 GiB 以上。先拉小镜像，避免一次性触发所有镜像并发构建。

5. **WSL 里访问 `/mnt/d` 巨慢**
   Tilt 打 docker 构建上下文需要遍历整个项目目录，跨文件系统会非常慢。把仓库克隆到 WSL 内（如 `~/we-meet`）能显著改善。

6. **Egress 录制不工作**
   livekit-egress 需要信任本地 mkcert CA 才能访问 `https://meet.127.0.0.1.nip.io` 的内部回调，[Tiltfile:82-96](../../bin/Tiltfile#L82-L96) 已经把 `rootCA.pem` 注入到自定义 livekit 镜像。如果仍失败，看 egress pod 日志确认证书路径。

7. **`helm plugin install` / `kind` / `tilt` 下载失败**
   GitHub Releases 在国内常被中断。参考第一节"helm-diff 离线安装"中的 `gh-proxy.com` 写法套用。或者给 WSL 配 Windows 代理：

   ```bash
   HOST_IP=$(ip route show | grep -i default | awk '{print $3}')
   export HTTPS_PROXY=http://$HOST_IP:7890
   export HTTP_PROXY=http://$HOST_IP:7890
   ```

   注意 Windows 代理软件需要打开"允许局域网连接"，否则 WSL 连不上。

8. **`auth.docker.io: i/o timeout` / 拉 Docker Hub 镜像超时**
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

9. **构建容器时 `apt-get` 拉 deb.debian.org 超时 / EOF**
   镜像加速器只解决 image pull，解决不了容器内 apt 流量。改 [src/agents/Dockerfile](../../src/agents/Dockerfile) 让 apt 走国内镜像（**当前已有补丁**）：

   ```dockerfile
   RUN sed -i 's|http://deb.debian.org|https://mirrors.aliyun.com|g; s|http://security.debian.org|https://mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources && \
       printf 'Acquire::Retries "5";\nAcquire::http::Timeout "120";\nAcquire::https::Timeout "120";\n' > /etc/apt/apt.conf.d/80-retries
   ENV PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
   ENV PIP_TRUSTED_HOST=mirrors.aliyun.com
   ```

   实测清华源（mirrors.tuna.tsinghua.edu.cn）在 trixie 仓库上极不稳定（500 EOF / 连接重置）；阿里云稳定得多。备选：`mirrors.ustc.edu.cn`、`mirrors.huaweicloud.com`、`mirrors.cloud.tencent.com`。

   > ⚠️ 这是本地开发的临时补丁，**提交前记得 revert**。

10. **改了 Dockerfile 但 Tilt 还在用旧版本（`/mnt/d/...` 项目特有）**
    `/mnt/d` 是 Windows 文件系统，inotify 事件不会从 Windows 侧传到 WSL2，Tilt 文件监听对这条路径下的项目不工作。改完 Dockerfile / Tiltfile 后必须**手动重启 Tilt**：

    ```bash
    # Ctrl+C 停 Tilt
    docker buildx prune -f       # 清掉旧 Dockerfile 对应的 BuildKit 层缓存
    make start-tilt-keycloak
    ```

    长远建议把项目克隆到 WSL 原生目录（如 `~/we-meet`），跨文件系统的 inotify 失灵 + Docker 构建上下文打包慢都会消失。

---

## 七、停止与清理

```bash
# 停 Tilt（也可在 Tilt UI 按 Ctrl+C）
tilt down -f ./bin/Tiltfile

# 销毁整个 kind 集群（最干净）
kind delete cluster --name suite
docker rm -f kind-registry        # 顺手清掉本地 registry 容器
```

---

## 何时不该走这条路径

如果只是想本地开发后端 / 前端代码、不关心 K8s 部署链路，[compose.md](compose.md) 里 `make bootstrap` 的 docker-compose 路径更轻量、不需要 kind / Tilt / mkcert，启动更快。

完整的 K8s 部署语义、HTTPS、Ingress、Keycloak、Egress 录制等只有 kind + Tilt 路径能验证完整。
