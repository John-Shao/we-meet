# 独立部署 La Suite Docs（协作文档，P3）

> we-meet P3 集成 [La Suite Docs](https://github.com/suitenumerique/docs)：会议纪要自动落成协作文档（妙记），并提供文档入口。本文是 **Docs 独立机** 的部署 runbook。
> 设计与纸面 spike 结论见 [../phases/p3-collab-docs.md](../phases/p3-collab-docs.md)。meet 迁到新机的步骤见 [aliyun.md §十四](aliyun.md#十四迁移--扩容把-meet-迁到更大的新机器4c16g)。
>
> ✅ **就绪产物**：部署套件已随 fork 独立到 `github.com/John-Shao/we-meet-docs`（分支 `docs-dev`，已简体中文化）的 `deploy/aliyun-docs/` —— `docs.values.yaml`（helm values）+ `build-and-push.sh`（自建三镜像）+ `bootstrap-docs-client.sh`（Keycloak `docs` client，独立版）+ `README.md`（部署顺序/占位清单）。本文为背景 runbook；**meet 侧接线**（`DOCS_API_URL` / `DOCS_SERVER_TO_SERVER_TOKEN`）仍在本仓库 `src/helm/env.d/aliyun-prod/`。

## 拓扑（三机落位）

| 机器 | 跑什么 |
|---|---|
| 新 4C16G | meet 整套（backend/frontend/summary/celery/agents/livekit/pg/redis）—— 见 aliyun.md §十四 |
| **旧 4C8G（本机）** | **Docs —— 单节点 K3s + Docs 官方 helm chart**（即 jusi-light-im 的独立机路子） |
| 2C2G aliyun-zlm | Keycloak（加一个 `docs` client；已为 SSO 装 phone-auth 插件、realm 全局手机号登录，见 [sso-integration-plan.md](sso-integration-plan.md)） |

正文存**阿里云 OSS 深圳**（S3 兼容，与本机同区；新桶 `we-meet-docs`），PG/Redis 为 Docs 专属、与 meet 完全隔离。

> ⚠️ **走 helm 不走 compose**：Docs 官方生产路径就是 k8s/helm；compose 他们明说自己生产不用、仅社区支持。**chart + 镜像版本务必 pin**，别用浮动 latest。

---

## 一、前置

1. 旧机已退役 meet（[aliyun.md §14.5](aliyun.md#145-退役旧机-meet确认新机稳定后)），整机可用。
2. 阿里云 OSS 控制台（**华南1·深圳** `cn-shenzhen`，与本机同区）新建桶 `we-meet-docs`（权限私有 / CORS 来源填 `https://docs.<域名>`，允许 GET/PUT/POST/DELETE + `*` 头）。
3. 生成**共享 server-to-server token**（妙记落 Doc 用，两边同值）：
   ```bash
   openssl rand -hex 32      # 记为 DOCS_S2S_TOKEN
   ```
4. DNS：`docs` A 记录 → 本机公网 IP（先建着给 LE 用）。安全组：`22`(你的IP) / `80` / `443` / `6443`(你的IP)。

## 二、Keycloak 加 `docs` client（在 aliyun-zlm）

照 [deploy/aliyun/keycloak/bootstrap-realm.sh](../../deploy/aliyun/keycloak/bootstrap-realm.sh) 里 meet client（`:59`）的模式，在 realm **`meet`** 下新增：

- `clientId: docs`，confidential（`publicClient: false`），`standardFlowEnabled: true`
- `redirectUris: ["https://docs.<域名>/*"]`
- `webOrigins: ["https://docs.<域名>"]`
- `post.logout.redirect.uris: "https://docs.<域名>##https://docs.<域名>/*"`（带/不带尾斜杠两条，否则 logout 报 `Invalid redirect uri`；`bootstrap-docs-client.sh` 已按此建，现有 client 用 `bootstrap-logout-uris.sh` 补）

记下生成的 **client secret**（下一步 `OIDC_RP_CLIENT_SECRET` 用）。脚本 `bootstrap-docs-client.sh` 已随 fork 到 we-meet-docs 的 `deploy/aliyun-docs/`（独立版，凭据走 env，照 we-meet `bootstrap-realm.sh` 的 meet client 建 `docs` client）——跑 `KC_URL=https://id.<域名> KC_ADMIN_USER=... KC_ADMIN_PASSWORD=... DOCS_HOST=docs.<域名> bash deploy/aliyun-docs/bootstrap-docs-client.sh`，脚本末尾会打印要填进 `docs.values.yaml` 的 `OIDC_RP_CLIENT_ID/SECRET/REDIRECT_ALLOWED_HOSTS`。

> Docs 与 meet 在**同一个 realm `meet`** → 用户登录 meet 后访问 docs 走同一 Keycloak SSO 会话，新标签**免登**。docs **直接入口**（未登录）则走 Keycloak 手机验证码登录页（realm 全局 `phone-browser` flow）→ 登录后同样建立 SSO 会话。整套见 [sso-integration-plan.md](sso-integration-plan.md)。

## 三、装单节点 K3s（本机）

参照 [deploy/aliyun/install-k3s.sh](../../deploy/aliyun/install-k3s.sh) 的同款装法。Docs 只需 **ingress + cert-manager**（不需要 livekit/hostPort 那些）：

- 装 k3s（国内镜像加速同 meet）
- 装 cert-manager + 一个 Let's Encrypt `ClusterIssuer`（同 [cluster-issuer.yaml](../../src/helm/env.d/aliyun-prod/cluster-issuer.yaml)）
- ingress：用 k3s 自带 traefik（单 Docs 够用）或装 ingress-nginx，二选一

## 四、helm 部署 Docs

**不走 `helm repo add`**——`https://github.com/John-Shao/we-meet-docs` 是仓库主页，不是 GitHub Pages（该 fork 未开 Pages，也没有 `gh-pages` 分支），直接拿来 `helm repo add` 会报 "not a valid chart repository"。fork 里已经带了 chart 本体（`src/helm/impress`，chart 名 `docs`，当前 `version: 5.4.1`），克隆下来本地装即可——天然是简体中文化后的版本，也不会跟自建的三个镜像默认值对不上（用官方 chart 装出来默认拉 `lasuite/impress-*` 官方镜像）：

```bash
git clone -b docs-dev https://github.com/John-Shao/we-meet-docs.git
cd we-meet-docs
git rev-parse HEAD   # 记下当前 commit，作为这次部署的版本锚点

# 参考 src/helm/impress/values.yaml（默认值全集）+ README.md（generate-readme.sh 生成），改成下面的接入项：
helm install impress ./src/helm/impress -n docs --create-namespace \
  -f docs.values.yaml
```

> 本地路径安装没有 `--version` 语义——版本就是当前 checkout 的那个 commit。升级前 `git fetch && git log HEAD..origin/docs-dev --oneline` 看 diff 再 `git pull`，别无脑 pull。若要跟上游 `suitenumerique/docs` 同步：`git remote add upstream https://github.com/suitenumerique/docs.git && git fetch upstream && git merge upstream/main`（merge 前排查 i18n 改动冲突）。

`docs.values.yaml` 的关键覆盖项（接我们的 Keycloak / OSS / token；落到 chart 的 yaml 结构以 fork 当前 checkout 的 `src/helm/impress/values.yaml` 为准——下面列的是「要设哪些值」）：

**OIDC → 指我们的 Keycloak realm `meet`**（注意 realm 是 `meet` 不是示例里的 `impress`）：
```yaml
OIDC_OP_JWKS_ENDPOINT:          https://id.<域名>/realms/meet/protocol/openid-connect/certs
OIDC_OP_AUTHORIZATION_ENDPOINT: https://id.<域名>/realms/meet/protocol/openid-connect/auth
OIDC_OP_TOKEN_ENDPOINT:         https://id.<域名>/realms/meet/protocol/openid-connect/token
OIDC_OP_USER_ENDPOINT:          https://id.<域名>/realms/meet/protocol/openid-connect/userinfo
OIDC_OP_LOGOUT_ENDPOINT:        https://id.<域名>/realms/meet/protocol/openid-connect/logout
OIDC_RP_CLIENT_ID:              docs
OIDC_RP_CLIENT_SECRET:          <二步的 client secret>
OIDC_RP_SIGN_ALGO:              RS256
OIDC_RP_SCOPES:                 "openid email"
OIDC_REDIRECT_ALLOWED_HOSTS:    ["https://docs.<域名>"]
```

**对象存储 → 阿里云 OSS 深圳**（S3 兼容外部 S3，跳过 minio）：
```yaml
AWS_S3_ENDPOINT_URL:      https://oss-cn-shenzhen.aliyuncs.com
AWS_S3_ACCESS_KEY_ID:     <OSS AK>
AWS_S3_SECRET_ACCESS_KEY: <OSS SK>
AWS_STORAGE_BUCKET_NAME:  we-meet-docs
AWS_S3_REGION_NAME:       oss-cn-shenzhen   # ⚠️ SigV4 签名区需实测，403 时试纯 cn-shenzhen
AWS_S3_ADDRESSING_STYLE:  virtual           # OSS 走 vhost 风格
```

**妙记落 Doc 的服务端 token（与 we-meet 同值，这是关键对接点）**：
```yaml
SERVER_TO_SERVER_API_TOKENS: ["<DOCS_S2S_TOKEN>"]
```

**协同 ws（y-provider）**：
```yaml
Y_PROVIDER_API_KEY:          <openssl rand -hex 32>
COLLABORATION_SERVER_SECRET: <openssl rand -hex 32>
# y-provider ↔ backend 的对接 URL 用 chart 默认（同集群 service 名）
```

**PG / Redis**：用 chart 示例的 in-cluster 方式起，或自己起 bitnami pg/redis（同 meet 那套），`DB_HOST`/`DB_*` / `REDIS_URL` / `DJANGO_CELERY_BROKER_URL` 指过去。
**Django**：`DJANGO_SECRET_KEY`（随机）、`DJANGO_ALLOWED_HOSTS=docs.<域名>`。
**ingress**：host=`docs.<域名>`，TLS 用 cert-manager letsencrypt。

跑迁移 + 建超管：
```bash
kubectl -n docs exec deploy/impress-backend -- python manage.py migrate
```

> 镜像不用再临时镜像官方 `lasuite/impress-*`——fork 的 `deploy/aliyun-docs/build-and-push.sh` 已经是自建三镜像（backend/frontend/y-provider）+ 推火山 CR `we-meet` 命名空间的固定流程，`docs.values.yaml` 的 image repo 直接指过去即可。

## 五、DNS / TLS / 验证 Docs

```bash
kubectl -n docs get certificate    # 等变 True（DNS 指本机 + 80 通后 LE 签）
```
新标签打开 `https://docs.<域名>`：已登录 meet 的话应**免登**（同 Keycloak SSO）；未登录则跳 Keycloak **手机验证码页**（realm 全局）→ 登录后能建 / 编辑文档。

## 六、接通「妙记落 Doc」（在 meet 那台）

we-meet 后端已就绪（[core/services/docs_client.py](../../src/backend/core/services/docs_client.py) + `meeting_summary._push_summary_to_doc`），**只差两个 env**。在 meet 机的 values 里加（注入到 backend env）：

```yaml
# values.meet.yaml 的 backend.envVars（非密）
DOCS_API_URL: https://docs.<域名>
# values.secrets.yaml 的 backend.envVars（密 —— 与 Docs 的 SERVER_TO_SERVER_API_TOKENS 同值）
DOCS_SERVER_TO_SERVER_TOKEN: <DOCS_S2S_TOKEN>
```
然后 meet 机 `helm upgrade meet ...`（带 [§十一](aliyun.md) 的 3 个 `-f`）。

**验证 E2E**：开一场会 → 结束出纪要 → Docs 自动建出一篇「`「<房间名>」会议纪要`」文档（owner=组织者），房间 IM 群收到 `📄 会议纪要文档已生成: <链接>`，点开免登可编辑。
> `DOCS_API_URL` 留空时，妙记落 Doc 静默跳过（no-op），meet 其余功能照常——即 Docs 没起来也不影响 meet。

## 七、风险 / 注意

- **compose 是社区支持、helm 才是官方生产路径** → 用 helm；**pin chart + 镜像版本**，别浮动 latest。
- `SERVER_TO_SERVER_API_TOKENS` 是**高权限**（能代任意用户建文档）→ 只配在 Docs + meet 后端 secret，绝不外泄/进前端。
- chart 的 values 结构会随版本变 → 上面列的是「要设哪些值」，落 yaml 时对着所 pin 版本的 `docs/examples/helm/impress.values.yaml` 填。
- 资源：本机 4C8G/40G，正文走 OSS、本地盘只存元数据 + 镜像，够用；并发协同编辑暴涨时盯 y-provider 内存。
