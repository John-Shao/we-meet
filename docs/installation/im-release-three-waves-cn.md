# IM 跨仓发布「三波曲」运行手册

> 适用场景:一次改动**同时涉及** jusi-light-im(IM 后端,腾讯云)、`@jusi/light-im-sdk`(npm 包)、we-meet(产品端,阿里云)三方时的协调发布流程。
> 典型例子:P7(会话生命周期)、P8(会话事件)、P9(群管理)——凡是 jusi 改了能力、SDK 暴露了新 API、we-meet 前端要用上,都走这套。
> 单端改动(只动 we-meet 前端、或只修 jusi 一个 bug)不需要整套,挑对应那一波即可。

---

## 为什么是「三波」+ 为什么有顺序

三者是**单向依赖链**:we-meet 前端 → SDK → jusi 后端。

```
① jusi 后端   先上(新端点/字段/事件就绪)
②  ↓ SDK      再发(把新能力暴露成 TS API)
③  ↓ we-meet  最后消费(前端 import 新 SDK + 调新端点)
```

**顺序不能乱**:
- ② 必须在 ③ 之前——we-meet 的 `npm install` 要能从 registry 拉到新版 SDK。
- ① 最好在 ③ 之前——否则前端调新端点会 404 / 调新字段拿到 undefined(灰度期可接受,但验收会失败)。

---

## ① jusi 后端(腾讯云 ECS,K3s 单节点)

本地 `docker build` → 导入 k3s containerd(无 registry)→ helm upgrade。

```bash
cd ~/projects/jusi-light-im && git pull

# 构建并导入镜像(脚本会打出 build tag = 短 commit)
sudo bash scripts/deploy/06a-build-local.sh
# → 末尾提示形如:LOCAL_IMAGE=true IMAGE_TAG=<tag> sudo -E bash scripts/deploy/06-deploy-jusi.sh

LOCAL_IMAGE=true IMAGE_TAG=<tag> sudo -E bash scripts/deploy/06-deploy-jusi.sh
sudo kubectl -n jusi rollout status deployment/jusi-jusi-light-im
```

- **有 schema 变更**(新增 `schema/NNN_*.sql`):`MIGRATE_ON_START=true` 启动时自动应用,无需手动 migrate。P9 无 schema 变更。
- 验证:`sudo kubectl -n jusi get pods`(Running)。

---

## ② SDK 发布(Windows PowerShell)

⚠️ **必须在 Windows PowerShell 跑,不要在 WSL** —— WSL 的 `node_modules` 装的是 win32 原生包(rollup/lightningcss),跨 OS 会报 `Cannot find module @rollup/rollup-linux-x64-gnu`。

```powershell
cd d:\workspace\jusi-light-im\sdk\web
# 先在 package.json 把 version 升一档(如 0.1.0-alpha.3 → 0.1.0-alpha.4),已随代码提交
npm publish   # prepublishOnly 自动 clean + build
```

发布成功后,**记下 notice 里的 `integrity: sha512-...`** —— ③ 要用。

---

## ③ we-meet 消费(阿里云 ECS)

### 3.1 刷新 lockfile 的 SDK integrity(最容易踩的坑)

we-meet 前端镜像用 `npm ci`,它**严格校验** lockfile 里的 `integrity` 哈希。发布新 SDK 后,lockfile 里的哈希要么是旧版、要么是占位符,**必须刷新**,否则 Docker 构建 `npm ci` 报 `EINTEGRITY`。

两种刷新方式,任选其一(都在 `src/frontend` 下):

```bash
# 方式 A:让 npm 自己拉新版写回(需能访问 registry)
cd src/frontend && npm install
git add package-lock.json && git commit -m "🔒 锁定 light-im-sdk <版本> integrity"
```

或者**手写**(当 `npm install` 受本地代理影响失败时,最稳):把 ② 发布 notice 里的 `integrity` 值,直接填进 `src/frontend/package-lock.json` 的 `node_modules/@jusi/light-im-sdk` 条目(同时确认 `version`/`resolved` 也指向新版),再提交。

> 经验:`npm ci` 报错信息里 `but got sha512-...` 那串,就是 registry 上的真实哈希,可直接拿来填。

### 3.2 构建 + 推送镜像

```bash
cd /mnt/d/workspace/we-meet/we-meet
# 改了哪端就 build 哪端;群管理这种 bridge + 前端都改 → 两个都要
bash deploy/aliyun/build-and-push.sh backend frontend
```

- **backend**:bridge 新端点(如 P9 的 add-members/remove-member/rename)在 `src/backend` 里,改了就必须重建。
  - ⚠️ 若日志显示 `COPY src/backend /app` 等层 **CACHED** 但你确实改了后端代码,核对镜像 digest 是否变化;必要时给那一步加 `--no-cache` 强制重建,避免部署到旧镜像。
- **frontend**:`npm run build` 走 `panda codegen && tsc -b && vite build`。

### 3.3 rollout(latest tag 不会自动滚动,必须手动 restart)

```bash
# 在生产 ECS aliyun-sjy 上
kubectl -n meet rollout restart deploy/meet-backend deploy/meet-frontend
kubectl -n meet rollout status  deploy/meet-backend  --timeout=120s
kubectl -n meet rollout status  deploy/meet-frontend --timeout=120s

# 有 Django 迁移才执行(无迁移跳过):
kubectl -n meet exec deploy/meet-backend -- python manage.py migrate --no-input
```

---

## 踩过的坑(务必牢记)

| 坑 | 现象 | 解法 |
|---|---|---|
| **lockfile integrity 不刷新** | Docker `npm ci` 报 `EINTEGRITY ... seems to be corrupted` | 发布 SDK 后必做 3.1;报错里 `but got sha512-...` 就是真值 |
| **`tsc -b` 比 `tsc --noEmit` 严** | 本地 `tsc --noEmit` 过,prod `npm run build` 的 `tsc -b` 报 TS 错 | 提交前用 `npx tsc -b --force` 当门禁;别只信 `tsc --noEmit` |
| **本地 vite 构建失败** | `Cannot find module ...lightningcss.win32-x64-msvc.node` 或 rollup 同类 | 跨 OS 原生包问题,**仅本地 Windows**;prod linux 不受影响,用 `tsc -b` 验类型即可 |
| **SDK 在 WSL publish 失败** | `Cannot find module @rollup/rollup-linux-x64-gnu` | 改用 Windows PowerShell 发布(见 ②) |
| **backend 镜像 CACHED 旧码** | bridge 端点 404 | 核对 digest;`--no-cache` 重建 backend |
| **latest tag 不自动滚动** | 推了新镜像但 pod 还是旧的 | 必须 `kubectl rollout restart` |
| **CORS 漏放方法** | 浏览器跨域调 DELETE/PATCH 被 preflight 拦 | jusi `internal/api/cors/cors.go` 的 `Access-Control-Allow-Methods` 要含该方法 |

---

## 验收(每波各自先自验,再整体 E2E)

- **① jusi**:`rollout status` 成功 + `get pods` Running;必要时 `GET /v1/conversations/{cid}/members` 等新端点可达。
- **② SDK**:`npm view @jusi/light-im-sdk version` 是新版;notice 的 integrity 已记录。
- **③ we-meet**:两个镜像 push 成功 + rollout 成功;前端打开 `/im` 验本次新功能。

> 整体 E2E 以"本次改了什么"为准列清单(如 P9:消息显示名 / 群头部 / 建群锁自己 / 群信息页花名册+群主+改名+踢人+转让+退群 / 拉人 / @提及 / 各类系统消息)。
