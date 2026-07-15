#!/usr/bin/env bash
# retire-legacy-flows.sh — 安全退役阶段一/旧的独立 browser flow。
#
# 统一双栏登录 unified-browser 上线（realm 全局）后，phone-browser（原手机号 SSO）
# 与 scan-browser（阶段一独立扫码）功能已被 unified-login-authenticator 覆盖，可退役。
#
# 安全检查（任一命中即中止，不删）：
#   1. realm 当前 browserFlow 不能是待删 flow（否则删了没法登录）。
#   2. 没有任何 client 的 authenticationFlowBindingOverrides.browser 还指向它。
# Keycloak 本身也会拒绝删除仍被引用的 flow，这里提前查明并给出是谁在引用。
#
# 默认只退 scan-browser（零回滚价值）。phone-browser 建议 unified 稳定跑一阵、
# 确认无需回滚后再退：RETIRE_FLOWS="phone-browser scan-browser" bash retire-legacy-flows.sh
#
# Run:  bash retire-legacy-flows.sh
set -euo pipefail

if [[ ! -f .env ]]; then echo ".env 不存在，先 cp .env.dist .env"; exit 1; fi
set -a; source .env; set +a

KC_URL="${KC_URL:-https://id.we-meet.online}"
REALM="${REALM:-meet}"
RETIRE_FLOWS="${RETIRE_FLOWS:-scan-browser}"   # 空格分隔；默认只退 scan-browser

echo "==> Admin login"
TOKEN=$(curl -sS --fail "$KC_URL/realms/master/protocol/openid-connect/token" \
  --data-urlencode "client_id=admin-cli" \
  --data-urlencode "username=$KC_ADMIN_USER" \
  --data-urlencode "password=$KC_ADMIN_PASSWORD" \
  --data-urlencode "grant_type=password" | jq -r .access_token)
[[ -n "$TOKEN" && "$TOKEN" != "null" ]] || { echo "ERROR: admin token 获取失败"; exit 1; }
AUTH=( -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" )
api() { curl -sS "${AUTH[@]}" "$@"; }

FLOWS_URL="$KC_URL/admin/realms/$REALM/authentication/flows"

REALM_BROWSER_FLOW=$(api "$KC_URL/admin/realms/$REALM" | jq -r '.browserFlow')
echo "==> realm browserFlow = $REALM_BROWSER_FLOW"
CLIENTS=$(api "$KC_URL/admin/realms/$REALM/clients?max=1000")

for FLOW in $RETIRE_FLOWS; do
  echo "---- $FLOW ----"
  FLOW_ID=$(api "$FLOWS_URL" | jq -r --arg a "$FLOW" '.[]|select(.alias==$a)|.id')
  if [[ -z "$FLOW_ID" || "$FLOW_ID" == "null" ]]; then
    echo "    不存在，跳过"; continue
  fi

  if [[ "$REALM_BROWSER_FLOW" == "$FLOW" ]]; then
    echo "    ✋ 中止：realm browserFlow 仍是 '$FLOW'（当前登录用它）。先把 realm 换成 unified-browser。"
    continue
  fi

  BOUND=$(echo "$CLIENTS" | jq -r --arg f "$FLOW_ID" \
    '.[]|select(.authenticationFlowBindingOverrides.browser==$f)|.clientId')
  if [[ -n "$BOUND" ]]; then
    echo "    ✋ 中止：以下 client 的 browser override 还指向它，先清空它们的 override —"
    echo "$BOUND" | sed 's/^/       - /'
    continue
  fi

  echo "    无引用，删除 flow '$FLOW' (id $FLOW_ID)"
  api --fail -X DELETE "$FLOWS_URL/$FLOW_ID" && echo "    ✅ 已删除"
done

echo
echo "完成。注：flow 删除只移除执行项，phone-authenticator / scan-authenticator 的"
echo "provider（Java 类）仍在镜像里（未用、无害）。回滚需重跑 bootstrap-*.sh 重建 flow。"
