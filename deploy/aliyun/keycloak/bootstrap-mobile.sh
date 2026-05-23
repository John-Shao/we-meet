#!/usr/bin/env bash
# bootstrap-mobile.sh - 为移动端 OTP 登录配置 Keycloak。
#
# 在 bootstrap-realm.sh 跑过 (meet realm 已存在) 之后执行。本脚本只新增、可重复跑:
#   1. 创建/修正机密客户端 `meet-service` (service accounts 开启)
#   2. 给其服务账户分配 realm-management 角色:
#      view-users / query-users / manage-users / impersonation
#   3. 开启 realm 的 unmanaged attributes (让 phoneNumber 属性可写)
#   4. 打印 client_secret，并冒烟测试 client_credentials
#
# 注意: token-exchange 特性需在 compose.yaml 给 keycloak 加
#       KC_FEATURES=token-exchange,admin-fine-grained-authz 后重建容器,
#       本脚本无法代劳。
#
# Run:
#   bash bootstrap-mobile.sh

set -euo pipefail

if [[ ! -f .env ]]; then echo ".env 不存在，先 cp .env.dist .env"; exit 1; fi
set -a; source .env; set +a

KC_URL="${KC_URL:-https://id.we-meet.online}"
REALM="${REALM:-meet}"
CLIENT_ID="${CLIENT_ID_MOBILE:-meet-service}"

# 允许复用已有 secret；否则生成一个新的 (仅在客户端首次创建时生效)
GEN_SECRET="${MEET_SERVICE_SECRET:-$(openssl rand -hex 24)}"

echo "==> Login as admin to Keycloak"
TOKEN=$(curl -sS --fail "$KC_URL/realms/master/protocol/openid-connect/token" \
  --data-urlencode "client_id=admin-cli" \
  --data-urlencode "username=$KC_ADMIN_USER" \
  --data-urlencode "password=$KC_ADMIN_PASSWORD" \
  --data-urlencode "grant_type=password" | jq -r .access_token)
if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
  echo "ERROR: failed to obtain admin token"; exit 1
fi
AUTH=( -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" )

echo "==> Setting realm token lifespans (access 30 min, SSO 14 days)"
# Short-lived access token + long-lived refresh = client-side silent refresh
# can keep users signed in for up to 14 days without ever showing the login
# screen again, while a leaked access token is invalid within half an hour.
# clientSession* timeouts default to follow ssoSession* when unset.
curl -sS -X PUT "$KC_URL/admin/realms/$REALM" "${AUTH[@]}" -d '{
  "accessTokenLifespan": 1800,
  "ssoSessionIdleTimeout": 1209600,
  "ssoSessionMaxLifespan": 1209600,
  "offlineSessionIdleTimeout": 1209600
}'

echo "==> Creating confidential client '$CLIENT_ID'"
curl -sS -X POST "$KC_URL/admin/realms/$REALM/clients" "${AUTH[@]}" -d '{
  "clientId": "'"$CLIENT_ID"'",
  "enabled": true,
  "protocol": "openid-connect",
  "publicClient": false,
  "standardFlowEnabled": false,
  "directAccessGrantsEnabled": false,
  "serviceAccountsEnabled": true,
  "secret": "'"$GEN_SECRET"'"
}' && echo || echo "(client may already exist — 继续修正配置)"

# 拿到客户端内部 UUID
CID=$(curl -sS "${AUTH[@]}" \
  "$KC_URL/admin/realms/$REALM/clients?clientId=$CLIENT_ID" | jq -r '.[0].id')
if [[ -z "$CID" || "$CID" == "null" ]]; then
  echo "ERROR: client '$CLIENT_ID' not found after create"; exit 1
fi

# 不论新建还是已存在，确保关键开关正确 (幂等)
echo "==> Ensuring serviceAccountsEnabled / confidential on '$CLIENT_ID'"
curl -sS -X PUT "$KC_URL/admin/realms/$REALM/clients/$CID" "${AUTH[@]}" -d '{
  "publicClient": false,
  "standardFlowEnabled": false,
  "directAccessGrantsEnabled": false,
  "serviceAccountsEnabled": true
}'

# 服务账户用户
SA_UID=$(curl -sS "${AUTH[@]}" \
  "$KC_URL/admin/realms/$REALM/clients/$CID/service-account-user" | jq -r '.id')

# realm-management 客户端 UUID
RM_ID=$(curl -sS "${AUTH[@]}" \
  "$KC_URL/admin/realms/$REALM/clients?clientId=realm-management" | jq -r '.[0].id')

echo "==> Assigning realm-management roles to service account"
ROLES_JSON=$(for r in view-users query-users manage-users impersonation; do
  curl -sS "${AUTH[@]}" "$KC_URL/admin/realms/$REALM/clients/$RM_ID/roles/$r"
done | jq -s '.')
curl -sS -X POST "${AUTH[@]}" \
  "$KC_URL/admin/realms/$REALM/users/$SA_UID/role-mappings/clients/$RM_ID" \
  -d "$ROLES_JSON"

echo "==> Enabling unmanaged user attributes (phoneNumber)"
curl -sS "${AUTH[@]}" "$KC_URL/admin/realms/$REALM/users/profile" \
  | jq '.unmanagedAttributePolicy = "ENABLED"' \
  | curl -sS -X PUT "${AUTH[@]}" "$KC_URL/admin/realms/$REALM/users/profile" -d @-

# 读取真实 secret (可能是本次生成的，也可能是客户端原有的)
SECRET=$(curl -sS "${AUTH[@]}" \
  "$KC_URL/admin/realms/$REALM/clients/$CID/client-secret" | jq -r '.value')

echo
echo "==> Smoke test: client_credentials"
SA_TOKEN=$(curl -sS "$KC_URL/realms/$REALM/protocol/openid-connect/token" \
  -d grant_type=client_credentials \
  -d "client_id=$CLIENT_ID" \
  -d "client_secret=$SECRET" | jq -r '.access_token')
if [[ -n "$SA_TOKEN" && "$SA_TOKEN" != "null" ]]; then
  echo "    OK — service account token obtained"
else
  echo "    FAILED — 检查 client secret / service accounts 配置"
fi

echo
echo "============================================================"
echo "  meet-service client_secret:"
echo "  $SECRET"
echo "============================================================"
echo "  填入 we-meet 仓库 src/helm/env.d/aliyun-prod/values.secrets.yaml"
echo "  的 backend.envVars.MOBILE_AUTH_SERVICE_CLIENT_SECRET"
echo
echo "  仍需手工: compose.yaml 给 keycloak 加"
echo "    KC_FEATURES: \"token-exchange,admin-fine-grained-authz\""
echo "  然后 docker compose up -d 重建容器。"
