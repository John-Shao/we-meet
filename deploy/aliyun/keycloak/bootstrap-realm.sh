#!/usr/bin/env bash
# bootstrap-realm.sh - 在 Keycloak 启动后自动创建 meet realm + meet client + 一个测试用户。
#
# 必须在 compose up -d 之后、Keycloak 已就绪 (~30s) 时跑。
# 第二次跑会被 Keycloak 拒掉 (resource exists) — 这是预期行为，幂等需要手工删/编辑。
#
# Run:
#   bash bootstrap-realm.sh
# 然后到 https://id.we-meet.online/admin/master/console/#/meet/clients 查看。

set -euo pipefail

# 加载 .env 拿 admin 凭据
if [[ ! -f .env ]]; then echo ".env 不存在，先 cp .env.dist .env"; exit 1; fi
set -a; source .env; set +a

KC_URL="${KC_URL:-https://id.we-meet.online}"
REALM="${REALM:-meet}"
CLIENT_ID="${CLIENT_ID:-meet}"

# 让用户传入或交互式生成 client secret
if [[ -z "${MEET_CLIENT_SECRET:-}" ]]; then
  MEET_CLIENT_SECRET="$(openssl rand -hex 24)"
  echo "Generated MEET_CLIENT_SECRET=$MEET_CLIENT_SECRET"
  echo "把这个值填到 we-meet 仓库的 src/helm/env.d/aliyun-prod/values.secrets.yaml 的"
  echo "  backend.envVars.OIDC_RP_CLIENT_SECRET 字段下"
fi

echo "==> Login as admin to Keycloak"
TOKEN=$(curl -sS --fail "$KC_URL/realms/master/protocol/openid-connect/token" \
  -d "client_id=admin-cli" \
  -d "username=$KC_ADMIN_USER" \
  -d "password=$KC_ADMIN_PASSWORD" \
  -d "grant_type=password" | jq -r .access_token)
if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
  echo "ERROR: failed to obtain admin token"; exit 1
fi
AUTH=( -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" )

echo "==> Creating realm '$REALM'"
curl -sS -X POST "$KC_URL/admin/realms" "${AUTH[@]}" -d '{
  "realm": "'"$REALM"'",
  "enabled": true,
  "registrationAllowed": false,
  "loginWithEmailAllowed": true,
  "duplicateEmailsAllowed": false,
  "rememberMe": true,
  "verifyEmail": false,
  "sslRequired": "external",
  "accessTokenLifespan": 300,
  "ssoSessionIdleTimeout": 1800,
  "ssoSessionMaxLifespan": 36000
}' || echo "(realm may already exist)"

echo "==> Creating OIDC client '$CLIENT_ID'"
curl -sS -X POST "$KC_URL/admin/realms/$REALM/clients" "${AUTH[@]}" -d '{
  "clientId": "'"$CLIENT_ID"'",
  "enabled": true,
  "protocol": "openid-connect",
  "publicClient": false,
  "standardFlowEnabled": true,
  "directAccessGrantsEnabled": false,
  "serviceAccountsEnabled": false,
  "secret": "'"$MEET_CLIENT_SECRET"'",
  "redirectUris": [
    "https://meet.we-meet.online/api/v1.0/callback/",
    "https://meet.we-meet.online/*"
  ],
  "webOrigins": [
    "https://meet.we-meet.online"
  ],
  "attributes": {
    "post.logout.redirect.uris": "https://meet.we-meet.online"
  }
}' || echo "(client may already exist)"

echo "==> Creating a smoke-test user 'meet@we-meet.online' (password: meet — change later!)"
curl -sS -X POST "$KC_URL/admin/realms/$REALM/users" "${AUTH[@]}" -d '{
  "username": "meet",
  "email": "meet@we-meet.online",
  "firstName": "Smoke",
  "lastName": "Test",
  "enabled": true,
  "emailVerified": true,
  "credentials": [{
    "type": "password",
    "value": "meet",
    "temporary": false
  }]
}' || echo "(user may already exist)"

echo
echo "==> Done. Realm exposed at:"
echo "    $KC_URL/realms/$REALM/.well-known/openid-configuration"
echo
echo "把以下信息填回 we-meet 项目的 values.secrets.yaml:"
echo "    OIDC_RP_CLIENT_ID=$CLIENT_ID"
echo "    OIDC_RP_CLIENT_SECRET=$MEET_CLIENT_SECRET"
