#!/usr/bin/env bash
# bootstrap-scan-auth.sh — 为 meet realm 配置「扫码登录」浏览器认证器（阶段一 MVP）。
#
# 依赖 keycloak-phone-auth 插件（provider id: scan-authenticator，已打进 keycloak
# 镜像 we-meet/keycloak:*-phone）+ backend /api/qr-login/* 端点（含
# authenticator-status，QR_AUTHENTICATOR_GATEWAY_TOKEN 鉴权）。可重复执行（幂等）。
# 设计见 we-meet docs/features/qr_login_sso.md。
#
# 做三件事：
#   1. 建顶层 browser flow `scan-browser`：Cookie(ALTERNATIVE) + 子流 scan-forms
#      (ALTERNATIVE) → scan-authenticator(REQUIRED)。Cookie 保 SSO 免登；
#      scan-authenticator 只支持 REQUIRED/DISABLED，故必须放进 ALTERNATIVE 子流。
#   2. 配 scan-authenticator 的 backend_base_url / gateway_token。
#   3. 绑定该 flow。默认 SCAN_FLOW_BINDING=none：只建 flow 不绑，安全。
#      =client 只给 meet client 做 browser override（该 client 登录变【纯扫码】、
#      手机号页消失）；=realm 换整个 realm 的 browserFlow（全 web 登录变纯扫码）。
#
# ⚠️ 阶段一验证建议：先设 =none 建 flow，再去 Admin Console 临时把某个【测试
#    client】的 browser override 指向 scan-browser 单独验扫码 E2E，别直接动生产的
#    phone-browser。验证通过后，阶段一终态是把 scan-forms 作为又一个 ALTERNATIVE
#    子流【并入 phone-browser】，让 Keycloak「换一种登录方式」在手机号页 ↔ 扫码页
#    之间切换（该整合较敏感、单独做，本脚本不自动改 phone-browser）。
#
# Run:  bash bootstrap-scan-auth.sh
set -euo pipefail

if [[ ! -f .env ]]; then echo ".env 不存在，先 cp .env.dist .env"; exit 1; fi
set -a; source .env; set +a

KC_URL="${KC_URL:-https://id.we-meet.online}"
REALM="${REALM:-meet}"
MEET_CLIENT="${CLIENT_ID:-meet}"
FLOW="${SCAN_FLOW_ALIAS:-scan-browser}"
SUBFLOW="${SCAN_SUBFLOW_ALIAS:-scan-forms}"
BACKEND_BASE_URL="${BACKEND_BASE_URL:-https://meet.we-meet.online}"
GATEWAY_TOKEN="${QR_AUTHENTICATOR_GATEWAY_TOKEN:-}"
THEME="${SCAN_LOGIN_THEME:-phone}"
BINDING="${SCAN_FLOW_BINDING:-none}"   # client | realm | none

if [[ -z "$GATEWAY_TOKEN" ]]; then
  echo "⚠️  QR_AUTHENTICATOR_GATEWAY_TOKEN 未设 —— authenticator-status 是 fail-closed，"
  echo "    未配 token 时 backend 直接拒绝、扫码认证器拿不到状态、登录卡住。"
  echo "    请在 .env 填与 backend values.secrets.yaml 的 QR_AUTHENTICATOR_GATEWAY_TOKEN 同值。"
fi

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

# ---- 1. flow 结构 ----
echo "==> Ensuring top-level flow '$FLOW'"
HAVE_FLOW=$(api "$FLOWS_URL" | jq -r --arg a "$FLOW" '.[]|select(.alias==$a)|.alias')
if [[ "$HAVE_FLOW" != "$FLOW" ]]; then
  api --fail -X POST "$FLOWS_URL" -d '{
    "alias":"'"$FLOW"'","providerId":"basic-flow","topLevel":true,"builtIn":false,
    "description":"Scan (QR) passwordless browser login"
  }'
  echo "    created"
else
  echo "    exists — 跳过结构创建（重建请先删 flow，见末尾回滚）"
fi

# 若 flow 内还没有 scan-authenticator，则搭结构
HAVE_SCAN=$(api "$FLOWS_URL/$FLOW/executions" \
  | jq -r '.[]|select(.providerId=="scan-authenticator")|.id' | head -1)
if [[ -z "$HAVE_SCAN" ]]; then
  echo "==> Adding Cookie (ALTERNATIVE)"
  api --fail -X POST "$FLOWS_URL/$FLOW/executions/execution" -d '{"provider":"auth-cookie"}'
  echo "==> Adding subflow '$SUBFLOW' (ALTERNATIVE)"
  api --fail -X POST "$FLOWS_URL/$FLOW/executions/flow" \
    -d '{"alias":"'"$SUBFLOW"'","type":"basic-flow","description":"scan qr form"}'
  echo "==> Adding scan-authenticator (REQUIRED) into '$SUBFLOW'"
  api --fail -X POST "$FLOWS_URL/$SUBFLOW/executions/execution" -d '{"provider":"scan-authenticator"}'

  echo "==> Setting requirements"
  EXECS=$(api "$FLOWS_URL/$FLOW/executions")
  set_req() {  # $1=jq select filter  $2=requirement
    echo "$EXECS" | jq -c "$1" | while read -r row; do
      echo "$row" | jq '.requirement="'"$2"'"' \
        | api -X PUT "$FLOWS_URL/$FLOW/executions" -d @-
    done
  }
  set_req '.[]|select(.providerId=="auth-cookie")'          "ALTERNATIVE"
  set_req '.[]|select(.displayName=="'"$SUBFLOW"'")'        "ALTERNATIVE"
  set_req '.[]|select(.providerId=="scan-authenticator")'   "REQUIRED"
fi

# ---- 2. authenticator config ----
echo "==> Configuring backend gateway"
EXEC=$(api "$FLOWS_URL/$FLOW/executions" | jq '.[]|select(.providerId=="scan-authenticator")')
EXEC_ID=$(echo "$EXEC" | jq -r '.id')
CFG_ID=$(echo "$EXEC" | jq -r '.authenticationConfig // empty')
CFG=$(jq -n --arg b "$BACKEND_BASE_URL" --arg t "$GATEWAY_TOKEN" \
  '{alias:"scan-config",config:{backend_base_url:$b,gateway_token:$t}}')
if [[ -n "$CFG_ID" ]]; then
  echo "$CFG" | jq '.id="'"$CFG_ID"'"' \
    | api -X PUT "$KC_URL/admin/realms/$REALM/authentication/config/$CFG_ID" -d @-
  echo "    updated config $CFG_ID"
else
  api --fail -X POST "$KC_URL/admin/realms/$REALM/authentication/executions/$EXEC_ID/config" -d "$CFG"
  echo "    created config"
fi

# ---- 3. theme + binding ----
case "$BINDING" in
  realm)
    echo "==> [realm] browserFlow=$FLOW + loginTheme=$THEME（⚠️ 全 realm web 登录变纯扫码）"
    api -X PUT "$KC_URL/admin/realms/$REALM" -d '{"browserFlow":"'"$FLOW"'","loginTheme":"'"$THEME"'"}'
    ;;
  client)
    echo "==> [client] '$MEET_CLIENT' browser override + loginTheme=$THEME（该 client 变纯扫码）"
    CID=$(api "$KC_URL/admin/realms/$REALM/clients?clientId=$MEET_CLIENT" | jq -r '.[0].id')
    [[ -n "$CID" && "$CID" != "null" ]] || { echo "ERROR: client '$MEET_CLIENT' 不存在"; exit 1; }
    FLOW_ID=$(api "$FLOWS_URL" | jq -r --arg a "$FLOW" '.[]|select(.alias==$a)|.id')
    api "$KC_URL/admin/realms/$REALM/clients/$CID" \
      | jq --arg f "$FLOW_ID" --arg th "$THEME" \
          '.authenticationFlowBindingOverrides.browser=$f | .attributes["login_theme"]=$th' \
      | api -X PUT "$KC_URL/admin/realms/$REALM/clients/$CID" -d @-
    echo "    bound (flow id $FLOW_ID)"
    ;;
  none)
    echo "==> [none] 只建好 flow，未绑定。阶段一验证请临时给测试 client 绑 scan-browser。"
    ;;
esac

echo
echo "============================================================"
echo "  完成。验证（阶段一 · 隔离）："
echo "   1) Admin Console → $REALM → Authentication → Flows → '$FLOW'"
echo "      应见 Cookie(Alternative) + $SUBFLOW(Alternative) → Scan (QR) Login(Required)"
echo "   2) 临时把测试 client 的 browser override 指向 '$FLOW'（或本脚本 =client）"
echo "   3) 无痕打开该 client 登录 → 出现二维码页"
echo "   4) 已登录的 we-meet App 扫码 + 确认 → web 建 KC 会话、跳回应用"
echo "   5) 再开 docs.we-meet.online → 应免登（silent SSO）"
echo "  回滚："
echo "   - client 绑定: 删该 client 的 authenticationFlowBindingOverrides.browser"
echo "   - realm 绑定 : PUT realm，browserFlow 改回 'browser' 或 'phone-browser'"
echo "   - 删 flow    : Admin Console 删 '$FLOW'（须先解绑）"
echo "  前置：backend 已配 QR_AUTHENTICATOR_GATEWAY_TOKEN（与本 .env 同值），且"
echo "        keycloak 镜像已含 scan-authenticator（build-and-push.sh keycloak + compose up）。"
echo "============================================================"
