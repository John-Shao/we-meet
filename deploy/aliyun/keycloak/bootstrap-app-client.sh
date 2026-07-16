#!/usr/bin/env bash
# bootstrap-app-client.sh - 在已存在的 meet realm 里追加一个 `app` OIDC public client。
#
# 用于 P3.5 云文档集成 App 客户端(docs/phases/p3-docs-app.md D2):Android App 登录
# 迁移到 WebView 内的 Keycloak 统一登录页(OIDC 授权码 + PKCE)。登录发生在 WebView 里,
# KC 会话 cookie 落进 App 的 CookieManager → 云文档 tab 的 WebView 静默 SSO 免登。
#
# public client(无 secret):App 直连 KC token endpoint 用 code+PKCE 换/刷 token,
# 不经后端。后端 DRF 走 userinfo 校验 Bearer(mozilla_django_oidc),同 realm 任意
# client 签发的 token 都接受 —— 后端零改动。
#
# 与 bootstrap-docs-client.sh 同款:登录 admin → 在 realm `meet` 下建 client。
# 第二次跑会被 Keycloak 拒掉 (client exists) —— 幂等需手工删/编辑。
#
# Run(在本目录,需先 cp .env.dist .env 填好 KC_ADMIN_*;或纯环境变量):
#   bash bootstrap-app-client.sh
#   # 换域名:KC_URL=https://id.jusiai.com bash bootstrap-app-client.sh

set -euo pipefail

# 凭据:当前目录有 .env 就 source,否则用环境变量
if [[ -f .env ]]; then set -a; source .env; set +a; fi
: "${KC_ADMIN_USER:?需设 KC_ADMIN_USER(或在当前目录放含该变量的 .env)}"
: "${KC_ADMIN_PASSWORD:?需设 KC_ADMIN_PASSWORD}"

KC_URL="${KC_URL:-https://id.we-meet.online}"
REALM="${REALM:-meet}"
APP_CLIENT_ID="${APP_CLIENT_ID:-app}"
# App 侧 BuildConfig 的 WE_MEET_OIDC_REDIRECT_URI 必须与此一致(custom scheme)。
APP_REDIRECT_URI="${APP_REDIRECT_URI:-com.we.meet://oidc/callback}"

echo "==> Login as admin to Keycloak"
# --data-urlencode:curl -d 不做 URL 编码,密码里的 '+' '/' '=' '&' 会被误解。
TOKEN=$(curl -sS --fail "$KC_URL/realms/master/protocol/openid-connect/token" \
  --data-urlencode "client_id=admin-cli" \
  --data-urlencode "username=$KC_ADMIN_USER" \
  --data-urlencode "password=$KC_ADMIN_PASSWORD" \
  --data-urlencode "grant_type=password" | jq -r .access_token)
if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
  echo "ERROR: failed to obtain admin token"; exit 1
fi
AUTH=( -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" )

echo "==> Checking realm '$REALM' exists"
if ! curl -sS --fail "${AUTH[@]}" "$KC_URL/admin/realms/$REALM" >/dev/null 2>&1; then
  echo "ERROR: realm '$REALM' 不存在。先跑 bootstrap-realm.sh 建 realm。"; exit 1
fi

echo "==> Creating OIDC public client '$APP_CLIENT_ID' in realm '$REALM'"
# public + PKCE S256 强制(authorization code 拦截攻击防护;App 无法保管 secret)。
# directAccessGrants 关(不允许密码流);serviceAccounts 关(public client 也不支持)。
# redirectUris 只允许 App 的 custom scheme —— WebView 拦截该跳转取 code。
curl -sS -X POST "$KC_URL/admin/realms/$REALM/clients" "${AUTH[@]}" -d '{
  "clientId": "'"$APP_CLIENT_ID"'",
  "enabled": true,
  "protocol": "openid-connect",
  "publicClient": true,
  "standardFlowEnabled": true,
  "directAccessGrantsEnabled": false,
  "serviceAccountsEnabled": false,
  "redirectUris": [
    "'"$APP_REDIRECT_URI"'"
  ],
  "attributes": {
    "pkce.code.challenge.method": "S256"
  }
}' || echo "(client may already exist)"

echo
echo "==> Done. App 用以下参数走授权码 + PKCE(scope 需带 offline_access 以获长效 refresh):"
echo "    authorize: $KC_URL/realms/$REALM/protocol/openid-connect/auth"
echo "    token:     $KC_URL/realms/$REALM/protocol/openid-connect/token"
echo "    client_id=$APP_CLIENT_ID  redirect_uri=$APP_REDIRECT_URI  scope=\"openid offline_access\""
