#!/usr/bin/env bash
# bootstrap-docs-client.sh - 在已存在的 meet realm 里追加一个 `docs` OIDC client。
#
# 用于 P3 协作文档（集成 La Suite Docs）：Docs 部署在独立机 docs.<域名>，与 meet
# 复用同一个 Keycloak realm `meet` 做 SSO —— 用户登录 meet 后新标签打开 docs 免登。
# 设计见 docs/phases/p3-collab-docs.md（D3/D5），部署见 docs/installation/docs-server.md（§二）。
#
# 与 bootstrap-realm.sh 同款：登录 admin → 在 realm `meet` 下建一个 confidential client。
# realm 与 meet client 由 bootstrap-realm.sh 先建好，本脚本只加 docs client，不动 realm。
# 第二次跑会被 Keycloak 拒掉 (client exists) — 幂等需手工删/编辑（同 bootstrap-realm.sh）。
#
# Run（在本目录，需先 cp .env.dist .env 填好 KC_ADMIN_*）:
#   bash bootstrap-docs-client.sh
#   # 换域名：DOCS_HOST=docs.jusiai.com KC_URL=https://id.jusiai.com bash bootstrap-docs-client.sh
# 然后到 https://id.<域名>/admin/master/console/#/meet/clients 查看。

set -euo pipefail

# 加载 .env 拿 admin 凭据（同 bootstrap-realm.sh）
if [[ ! -f .env ]]; then echo ".env 不存在，先 cp .env.dist .env"; exit 1; fi
set -a; source .env; set +a

KC_URL="${KC_URL:-https://id.we-meet.online}"
REALM="${REALM:-meet}"
DOCS_CLIENT_ID="${DOCS_CLIENT_ID:-docs}"
# Docs 独立机的公开域名（redirectUris / webOrigins 用它）。换域名从 env 传入。
DOCS_HOST="${DOCS_HOST:-docs.we-meet.online}"

# 让用户传入或交互式生成 docs client secret（去 Docs 那台的 OIDC_RP_CLIENT_SECRET 用）
if [[ -z "${DOCS_CLIENT_SECRET:-}" ]]; then
  DOCS_CLIENT_SECRET="$(openssl rand -hex 24)"
  echo "Generated DOCS_CLIENT_SECRET=$DOCS_CLIENT_SECRET"
  echo "把这个值填到 Docs 独立机（aliyun-docs）的 docs.values.yaml 的"
  echo "  OIDC_RP_CLIENT_SECRET 字段下（见 docs/installation/docs-server.md §四）"
fi

echo "==> Login as admin to Keycloak"
# Use --data-urlencode for password and username（同 bootstrap-realm.sh：curl -d 不做
# URL 编码，密码里的 '+' '/' '=' '&' 会被服务端表单解析器误解，'+' 尤其会变空格）。
TOKEN=$(curl -sS --fail "$KC_URL/realms/master/protocol/openid-connect/token" \
  --data-urlencode "client_id=admin-cli" \
  --data-urlencode "username=$KC_ADMIN_USER" \
  --data-urlencode "password=$KC_ADMIN_PASSWORD" \
  --data-urlencode "grant_type=password" | jq -r .access_token)
if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
  echo "ERROR: failed to obtain admin token"; exit 1
fi
AUTH=( -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" )

# realm `meet` 应已由 bootstrap-realm.sh 建好；这里只做存在性提示，不重建。
echo "==> Checking realm '$REALM' exists"
if ! curl -sS --fail "${AUTH[@]}" "$KC_URL/admin/realms/$REALM" >/dev/null 2>&1; then
  echo "ERROR: realm '$REALM' 不存在。先跑 bootstrap-realm.sh 建 realm + meet client。"; exit 1
fi

echo "==> Creating OIDC client '$DOCS_CLIENT_ID' in realm '$REALM'"
# confidential + standardFlow（授权码流），照 bootstrap-realm.sh 的 meet client (:59)。
# redirectUris / webOrigins 指向 Docs 独立机域名，与 meet client 指向 meet 域名对称。
curl -sS -X POST "$KC_URL/admin/realms/$REALM/clients" "${AUTH[@]}" -d '{
  "clientId": "'"$DOCS_CLIENT_ID"'",
  "enabled": true,
  "protocol": "openid-connect",
  "publicClient": false,
  "standardFlowEnabled": true,
  "directAccessGrantsEnabled": false,
  "serviceAccountsEnabled": false,
  "secret": "'"$DOCS_CLIENT_SECRET"'",
  "redirectUris": [
    "https://'"$DOCS_HOST"'/api/v1.0/callback/",
    "https://'"$DOCS_HOST"'/*"
  ],
  "webOrigins": [
    "https://'"$DOCS_HOST"'"
  ],
  "attributes": {
    "post.logout.redirect.uris": "https://'"$DOCS_HOST"'"
  }
}' || echo "(client may already exist)"

echo
echo "==> Done. Docs 复用同一 realm 的 SSO 会话："
echo "    $KC_URL/realms/$REALM/.well-known/openid-configuration"
echo
echo "把以下信息填到 Docs 独立机的 docs.values.yaml（docs/installation/docs-server.md §四）:"
echo "    OIDC_RP_CLIENT_ID=$DOCS_CLIENT_ID"
echo "    OIDC_RP_CLIENT_SECRET=$DOCS_CLIENT_SECRET"
echo "    OIDC_REDIRECT_ALLOWED_HOSTS=[\"https://$DOCS_HOST\"]"
