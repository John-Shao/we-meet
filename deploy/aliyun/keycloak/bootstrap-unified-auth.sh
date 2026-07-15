#!/usr/bin/env bash
# bootstrap-unified-auth.sh — 配置阶段二「双栏统一登录」（扫码 + 手机号一页）。
#
# 依赖 keycloak-phone-auth 插件 provider id: unified-login-authenticator（已打进
# keycloak 镜像）+ backend /api/qr-login/*（含 ready / authenticator-status）+
# /keycloak-sms/send/。可重复执行（幂等）。设计见 docs/features/qr_login_sso.md。
#
# 做三件事：
#   1. 建顶层 flow `unified-browser`：Cookie(ALTERNATIVE) + 子流 unified-forms
#      (ALTERNATIVE) → unified-login-authenticator(REQUIRED)。
#   2. 配 authenticator：手机侧(sms_gateway_* / otp_* / demo_* / email_domain) +
#      扫码侧(backend_base_url / gateway_token)。
#   3. 绑定。默认 UNIFIED_FLOW_BINDING=none 只建不绑。=client 只给 meet client；
#      =realm 换整个 realm browserFlow（全 web 登录变双栏统一页）。
#
# 前置：token 三处同值 —— sms_gateway_token=KEYCLOAK_SMS_GATEWAY_TOKEN、
#      gateway_token=QR_AUTHENTICATOR_GATEWAY_TOKEN，均与 backend 一致。
#
# Run:  bash bootstrap-unified-auth.sh
set -euo pipefail

if [[ ! -f .env ]]; then echo ".env 不存在，先 cp .env.dist .env"; exit 1; fi
set -a; source .env; set +a

KC_URL="${KC_URL:-https://id.we-meet.online}"
REALM="${REALM:-meet}"
MEET_CLIENT="${CLIENT_ID:-meet}"
FLOW="${UNIFIED_FLOW_ALIAS:-unified-browser}"
SUBFLOW="${UNIFIED_SUBFLOW_ALIAS:-unified-forms}"
# 手机侧
GATEWAY_URL="${SMS_GATEWAY_URL:-https://meet.we-meet.online/keycloak-sms/send/}"
GATEWAY_TOKEN="${KEYCLOAK_SMS_GATEWAY_TOKEN:-}"
OTP_LENGTH="${OTP_LENGTH:-6}"
OTP_EXPIRY="${OTP_EXPIRY_SECONDS:-300}"
OTP_MAX="${OTP_MAX_ATTEMPTS:-3}"
DEMO_PHONES="${DEMO_PHONES:-13800000000,13800000001,13800000002,13800000003,13800000004,13800000005,13800000006,13800000007,13800000008,13800000009}"
DEMO_OTP="${DEMO_OTP:-123456}"
EMAIL_DOMAIN="${EMAIL_DOMAIN:-phone.we-meet.online}"
# 扫码侧
BACKEND_BASE_URL="${BACKEND_BASE_URL:-https://meet.we-meet.online}"
QR_GATEWAY_TOKEN="${QR_AUTHENTICATOR_GATEWAY_TOKEN:-}"
THEME="${UNIFIED_LOGIN_THEME:-phone}"
BINDING="${UNIFIED_FLOW_BINDING:-none}"   # client | realm | none

[[ -n "$GATEWAY_TOKEN" ]] || echo "⚠️  KEYCLOAK_SMS_GATEWAY_TOKEN 未设 —— 手机侧短信网关将不鉴权。"
[[ -n "$QR_GATEWAY_TOKEN" ]] || echo "⚠️  QR_AUTHENTICATOR_GATEWAY_TOKEN 未设 —— 扫码侧 fail-closed、会卡住。"

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
    "description":"Unified (scan + phone OTP) browser login"
  }'
  echo "    created"
else
  echo "    exists — 跳过结构创建"
fi

HAVE_U=$(api "$FLOWS_URL/$FLOW/executions" \
  | jq -r '.[]|select(.providerId=="unified-login-authenticator")|.id' | head -1)
if [[ -z "$HAVE_U" ]]; then
  echo "==> Adding Cookie (ALTERNATIVE)"
  api --fail -X POST "$FLOWS_URL/$FLOW/executions/execution" -d '{"provider":"auth-cookie"}'
  echo "==> Adding subflow '$SUBFLOW' (ALTERNATIVE)"
  api --fail -X POST "$FLOWS_URL/$FLOW/executions/flow" \
    -d '{"alias":"'"$SUBFLOW"'","type":"basic-flow","description":"unified login form"}'
  echo "==> Adding unified-login-authenticator (REQUIRED) into '$SUBFLOW'"
  api --fail -X POST "$FLOWS_URL/$SUBFLOW/executions/execution" -d '{"provider":"unified-login-authenticator"}'

  echo "==> Setting requirements"
  EXECS=$(api "$FLOWS_URL/$FLOW/executions")
  set_req() {
    echo "$EXECS" | jq -c "$1" | while read -r row; do
      echo "$row" | jq '.requirement="'"$2"'"' | api -X PUT "$FLOWS_URL/$FLOW/executions" -d @-
    done
  }
  set_req '.[]|select(.providerId=="auth-cookie")'                     "ALTERNATIVE"
  set_req '.[]|select(.displayName=="'"$SUBFLOW"'")'                   "ALTERNATIVE"
  set_req '.[]|select(.providerId=="unified-login-authenticator")'    "REQUIRED"
fi

# ---- 2. authenticator config ----
echo "==> Configuring unified authenticator (phone + scan)"
EXEC=$(api "$FLOWS_URL/$FLOW/executions" | jq '.[]|select(.providerId=="unified-login-authenticator")')
EXEC_ID=$(echo "$EXEC" | jq -r '.id')
CFG_ID=$(echo "$EXEC" | jq -r '.authenticationConfig // empty')
CFG=$(jq -n --arg u "$GATEWAY_URL" --arg t "$GATEWAY_TOKEN" \
  --arg l "$OTP_LENGTH" --arg e "$OTP_EXPIRY" --arg m "$OTP_MAX" \
  --arg dp "$DEMO_PHONES" --arg dotp "$DEMO_OTP" --arg edom "$EMAIL_DOMAIN" \
  --arg b "$BACKEND_BASE_URL" --arg gt "$QR_GATEWAY_TOKEN" \
  '{alias:"unified-config",config:{sms_gateway_url:$u,sms_gateway_token:$t,otp_length:$l,otp_expiry_seconds:$e,otp_max_attempts:$m,demo_phones:$dp,demo_otp:$dotp,email_domain:$edom,backend_base_url:$b,gateway_token:$gt}}')
if [[ -n "$CFG_ID" ]]; then
  echo "$CFG" | jq '.id="'"$CFG_ID"'"' | api -X PUT "$KC_URL/admin/realms/$REALM/authentication/config/$CFG_ID" -d @-
  echo "    updated config $CFG_ID"
else
  api --fail -X POST "$KC_URL/admin/realms/$REALM/authentication/executions/$EXEC_ID/config" -d "$CFG"
  echo "    created config"
fi

# ---- 3. theme + binding ----
case "$BINDING" in
  realm)
    echo "==> [realm] browserFlow=$FLOW + loginTheme=$THEME（⚠️ 全 realm 变双栏统一页）"
    api -X PUT "$KC_URL/admin/realms/$REALM" -d '{"browserFlow":"'"$FLOW"'","loginTheme":"'"$THEME"'"}'
    ;;
  client)
    echo "==> [client] '$MEET_CLIENT' browser override + loginTheme=$THEME"
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
    echo "==> [none] 只建好 flow，未绑定。验证请临时给测试 client 绑 unified-browser。"
    ;;
esac

echo
echo "============================================================"
echo "  完成。验证（阶段二）："
echo "   1) Flows → '$FLOW'：Cookie(Alt) + $SUBFLOW(Alt) → Unified Login(Required)"
echo "   2) 临时把测试 client browser override 指向 '$FLOW'（或 =client）"
echo "   3) 无痕打开 → 双栏页：左二维码 + 右手机号"
echo "   4a) 右列手机号 → 获取验证码 → 输码 → 登录"
echo "   4b) 或左列 App 扫码 + 确认（AJAX 轮询不刷新页面）→ 建 KC 会话"
echo "   5) 开 docs.we-meet.online → 免登（silent SSO）"
echo "  回滚：删 client override / realm browserFlow 改回 / 删 flow '$FLOW'"
echo "  注意：unified 上线并验证后，可退役阶段一独立 phone-browser / scan-browser。"
echo "============================================================"
