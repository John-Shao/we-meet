#!/usr/bin/env bash
# bootstrap-phone-auth.sh — 为 meet realm 配置「手机号 + 短信 OTP」浏览器登录。
#
# 依赖 keycloak-phone-auth 插件（provider id: phone-authenticator，来自
# github.com/John-Shao/keycloak-phone-auth，已打进 keycloak 镜像 we-meet/keycloak:*-phone）。
# 在 bootstrap-realm.sh（realm + meet client 已建）之后跑，可重复执行（幂等）。
#
# 做四件事：
#   1. 建顶层 browser flow `phone-browser`：Cookie(ALTERNATIVE) + 子流 phone-forms
#      (ALTERNATIVE) → phone-authenticator(REQUIRED)。Cookie 分支保留 SSO 免登，
#      否则已登录用户每次都被要求重发 OTP（且会拖累 docs 的 SSO 免登）。
#      注意：phone-authenticator 只支持 REQUIRED/DISABLED，故必须放进 ALTERNATIVE 子流。
#   2. 配 phone-authenticator 的 sms_gateway_url / sms_gateway_token / otp_*。
#   3. 设登录主题 `phone`。
#   4. 绑定该 flow。默认 PHONE_FLOW_BINDING=client：只给 meet client 做 browser
#      override，不动 realm 全局（docs 等其他 client 不受影响，SSO 仍免登，易回滚）。
#      设 =realm 则把整个 realm 的 browserFlow 换成它 —— 该 realm 所有 web 登录都
#      变手机 OTP、密码登录消失，影响面大，慎用。=none 只建 flow 不绑定。
#
# ⚠️ 直接影响用户能否登录。作者未在生产实测本脚本 —— 请先在测试 realm 跑通、
#    且确认 backend 短信网关可达（curl 一下 $SMS_GATEWAY_URL）后再用。末尾附验证 + 回滚。
#
# Run:  bash bootstrap-phone-auth.sh
set -euo pipefail

if [[ ! -f .env ]]; then echo ".env 不存在，先 cp .env.dist .env"; exit 1; fi
set -a; source .env; set +a

KC_URL="${KC_URL:-https://id.we-meet.online}"
REALM="${REALM:-meet}"
MEET_CLIENT="${CLIENT_ID:-meet}"
FLOW="${PHONE_FLOW_ALIAS:-phone-browser}"
SUBFLOW="${PHONE_SUBFLOW_ALIAS:-phone-forms}"
GATEWAY_URL="${SMS_GATEWAY_URL:-https://meet.we-meet.online/keycloak-sms/send/}"
GATEWAY_TOKEN="${KEYCLOAK_SMS_GATEWAY_TOKEN:-}"
OTP_LENGTH="${OTP_LENGTH:-6}"
OTP_EXPIRY="${OTP_EXPIRY_SECONDS:-300}"
OTP_MAX="${OTP_MAX_ATTEMPTS:-3}"
THEME="${PHONE_LOGIN_THEME:-phone}"
BINDING="${PHONE_FLOW_BINDING:-client}"   # client | realm | none

if [[ -z "$GATEWAY_TOKEN" ]]; then
  echo "⚠️  KEYCLOAK_SMS_GATEWAY_TOKEN 未设 —— 网关将【不鉴权】(AllowAny)，仅限测试。"
  echo "    生产请在 .env 填与 backend values.secrets.yaml 的 KEYCLOAK_SMS_GATEWAY_TOKEN 同值。"
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
    "description":"Phone number + SMS OTP passwordless browser login"
  }'
  echo "    created"
else
  echo "    exists — 跳过结构创建（重建请先删 flow，见末尾回滚）"
fi

# 若 flow 内还没有 phone-authenticator，则搭结构
HAVE_PHONE=$(api "$FLOWS_URL/$FLOW/executions" \
  | jq -r '.[]|select(.providerId=="phone-authenticator")|.id' | head -1)
if [[ -z "$HAVE_PHONE" ]]; then
  echo "==> Adding Cookie (ALTERNATIVE)"
  api --fail -X POST "$FLOWS_URL/$FLOW/executions/execution" -d '{"provider":"auth-cookie"}'
  echo "==> Adding subflow '$SUBFLOW' (ALTERNATIVE)"
  api --fail -X POST "$FLOWS_URL/$FLOW/executions/flow" \
    -d '{"alias":"'"$SUBFLOW"'","type":"basic-flow","description":"phone otp forms"}'
  echo "==> Adding phone-authenticator (REQUIRED) into '$SUBFLOW'"
  api --fail -X POST "$FLOWS_URL/$SUBFLOW/executions/execution" -d '{"provider":"phone-authenticator"}'

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
  set_req '.[]|select(.providerId=="phone-authenticator")'  "REQUIRED"
fi

# ---- 2. authenticator config ----
echo "==> Configuring gateway + OTP params"
EXEC=$(api "$FLOWS_URL/$FLOW/executions" | jq '.[]|select(.providerId=="phone-authenticator")')
EXEC_ID=$(echo "$EXEC" | jq -r '.id')
CFG_ID=$(echo "$EXEC" | jq -r '.authenticationConfig // empty')
CFG=$(jq -n --arg u "$GATEWAY_URL" --arg t "$GATEWAY_TOKEN" \
  --arg l "$OTP_LENGTH" --arg e "$OTP_EXPIRY" --arg m "$OTP_MAX" \
  '{alias:"phone-otp-config",config:{sms_gateway_url:$u,sms_gateway_token:$t,otp_length:$l,otp_expiry_seconds:$e,otp_max_attempts:$m}}')
if [[ -n "$CFG_ID" ]]; then
  echo "$CFG" | jq '.id="'"$CFG_ID"'"' \
    | api -X PUT "$KC_URL/admin/realms/$REALM/authentication/config/$CFG_ID" -d @-
  echo "    updated config $CFG_ID"
else
  api --fail -X POST "$KC_URL/admin/realms/$REALM/authentication/executions/$EXEC_ID/config" -d "$CFG"
  echo "    created config"
fi

# ---- 3 & 4. theme + binding ----
case "$BINDING" in
  realm)
    echo "==> [realm] browserFlow=$FLOW + loginTheme=$THEME（⚠️ 全 realm web 登录变手机 OTP）"
    api -X PUT "$KC_URL/admin/realms/$REALM" -d '{"browserFlow":"'"$FLOW"'","loginTheme":"'"$THEME"'"}'
    ;;
  client)
    echo "==> [client] '$MEET_CLIENT' browser override + loginTheme=$THEME（只影响该 client）"
    CID=$(api "$KC_URL/admin/realms/$REALM/clients?clientId=$MEET_CLIENT" | jq -r '.[0].id')
    [[ -n "$CID" && "$CID" != "null" ]] || { echo "ERROR: client '$MEET_CLIENT' 不存在"; exit 1; }
    FLOW_ID=$(api "$FLOWS_URL" | jq -r --arg a "$FLOW" '.[]|select(.alias==$a)|.id')
    # GET→merge→PUT，避免覆盖 client 已有 attributes(post.logout.redirect.uris 等)
    api "$KC_URL/admin/realms/$REALM/clients/$CID" \
      | jq --arg f "$FLOW_ID" --arg th "$THEME" \
          '.authenticationFlowBindingOverrides.browser=$f | .attributes["login_theme"]=$th' \
      | api -X PUT "$KC_URL/admin/realms/$REALM/clients/$CID" -d @-
    echo "    bound (flow id $FLOW_ID)"
    ;;
  none)
    echo "==> [none] 只建好 flow，未绑定。去 Admin Console 手动绑，或设 PHONE_FLOW_BINDING 重跑。"
    ;;
esac

echo
echo "============================================================"
echo "  完成。验证："
echo "   1) Admin Console → $REALM → Authentication → Flows → '$FLOW'"
echo "      应见 Cookie(Alternative) + $SUBFLOW(Alternative) → Phone OTP(Required)"
echo "   2) 无痕窗口打开 https://meet.we-meet.online/ 登录 → 应出现手机号输入页"
echo "   3) 输入手机号 → 收到短信验证码 → 登录成功"
echo "  回滚："
echo "   - client 绑定: 删 client '$MEET_CLIENT' 的 authenticationFlowBindingOverrides.browser"
echo "   - realm 绑定 : PUT realm，browserFlow 改回 'browser'"
echo "   - 删 flow    : Admin Console 删 '$FLOW'（须先解绑）"
echo "============================================================"
