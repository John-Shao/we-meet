# deploy/aliyun/docs — La Suite Docs 独立机部署产物（P3 协作文档）

把我们 fork+定制的 [La Suite Docs](https://github.com/suitenumerique/docs) 部署到独立机
`aliyun-docs`（单节点 k3s + 官方 helm chart），实现「会议纪要自动落成协作文档（妙记）」+ 文档入口。

- 设计/决策：[../../../docs/phases/p3-collab-docs.md](../../../docs/phases/p3-collab-docs.md)
- 分步 runbook：[../../../docs/installation/docs-server.md](../../../docs/installation/docs-server.md)
- 定制 fork：分支 `docs-dev`（`github.com/John-Shao/we-meet-docs`，`upstream=suitenumerique/docs`）
  - 已做：简体中文优先（前端 `translations.json` zh + 后端 `zh_CN.po` 全 `tw2sp` 繁→简）
  - 品牌：本轮**暂不改**（保持 Docs 原样外观）

## 本目录文件

| 文件 | 作用 |
|---|---|
| `build-and-push.sh` | 从 `docs-dev` 构建三镜像（backend/frontend/y-provider）推火山 CR。前端 `API_ORIGIN` build 期烘焙、镜像自带简体中文 |
| `docs.values.yaml` | aliyun-docs 的 helm values：自有镜像 + OIDC(realm `meet`, client `docs`) + 阿里云 OSS 深圳(S3 兼容) + server token + 简体中文语言 + ingress。所有 `__占位__` 部署前替换 |
| `../keycloak/bootstrap-docs-client.sh` | 在 Keycloak realm `meet` 加 `docs` confidential client（照 meet client） |

## 部署顺序（详见 runbook）

1. **前置**：阿里云 OSS 深圳桶 `we-meet-docs`；`openssl rand -hex 32` 生成共享 `DOCS_S2S_TOKEN`；DNS `docs.<域名>` → 本机公网 IP。
2. **Keycloak**（aliyun-zlm）：`DOCS_HOST=docs.<域名> bash ../keycloak/bootstrap-docs-client.sh` → 记下 client secret。
3. **建镜像**：在 `docs-dev` 的 we-meet-docs 仓库跑 `build-and-push.sh`（推火山 CR）。
4. **装 k3s + cert-manager + ingress**（照 [../install-k3s.sh](../install-k3s.sh)）。
5. **helm 部署**：填好 `docs.values.yaml` 的占位（client secret / DOCS_S2S_TOKEN / OSS AK-SK / DB-Redis 密码 / 各随机 secret），
   `helm install impress <chart> -n docs --create-namespace -f docs.values.yaml --version <pin>`，再 `kubectl -n docs exec deploy/impress-backend -- python manage.py migrate`。
6. **接通 meet**（meet 那台）：`values.meet.yaml` 已含 `DOCS_API_URL`；把 `values.secrets.yaml` 的
   `DOCS_SERVER_TO_SERVER_TOKEN` 填成与 `docs.values.yaml` 同一个 `DOCS_S2S_TOKEN`，`helm upgrade meet`。

## 部署时须核对（占位 + ⚠️）

- 全部 `__占位__`：client secret、`DOCS_S2S_TOKEN`、OSS AK/SK、DB/Redis 密码、`DJANGO_SECRET_KEY`、`Y_PROVIDER_API_KEY`、`COLLABORATION_SERVER_SECRET`、SMTP。
- 域名：`docs.values.yaml` 默认 `we-meet.online`（与 `values.meet.yaml` 一致）；换 `jusiai.com` 全局替换。
- 镜像 `image.tag` 与 `build-and-push.sh` 的 `TAG` 对齐。
- ⚠️ **OSS media ingress**：`ingressMedia`/`serviceMedia` 的 vhost/path-style + TLS SNI 需实测（见 `docs.values.yaml` 注释）；`AWS_S3_REGION_NAME` 用 `oss-cn-shenzhen`，403 SignatureDoesNotMatch 时试 `cn-shenzhen`。
- `DJANGO_SERVER_TO_SERVER_API_TOKENS`（docs 侧）== `DOCS_SERVER_TO_SERVER_TOKEN`（meet 侧），逐字符一致。
