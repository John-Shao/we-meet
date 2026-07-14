#!/usr/bin/env bash
# bootstrap-logout-uris.sh — 给【已存在】的 client 补 post-logout redirect 白名单。
#
# 修 RP-initiated logout 的 "Invalid redirect uri" / 400：client 建于
# bootstrap-realm.sh 加上 post.logout.redirect.uris 之前时，Keycloak 里该 client 的
# 「Valid post logout redirect URIs」是空的，任何登出回跳都被拒。bootstrap-realm.sh
# 重跑不更新已存在 client，故用本脚本按 client 逐个 PUT 更新。幂等，可重复跑。
#
# 白名单同时放「带/不带尾斜杠」两条，规避 trailing-slash 不匹配。
#
# Run:  bash bootstrap-logout-uris.sh
set -euo pipefail

if [[ ! -f .env ]]; then echo ".env 不存在，先 cp .env.dist .env"; exit 1; fi
set -a; source .env; set +a

KC_URL="${KC_URL:-https://id.we-meet.online}"
REALM="${REALM:-meet}"
# client → 其对外域名（post-logout 回跳）。换域名时 export 覆盖即可。
MEET_URL="${MEET_URL:-https://meet.we-meet.online}"
DOCS_URL="${DOCS_URL:-https://docs.we-meet.online}"

echo "==> Admin login"
TOKEN=$(curl -sS --fail "$KC_URL/realms/master/protocol/openid-connect/token" \
  --data-urlencode "client_id=admin-cli" \
  --data-urlencode "username=$KC_ADMIN_USER" \
  --data-urlencode "password=$KC_ADMIN_PASSWORD" \
  --data-urlencode "grant_type=password" | jq -r .access_token)
[[ -n "$TOKEN" && "$TOKEN" != "null" ]] || { echo "ERROR: admin token 获取失败"; exit 1; }
AUTH=( -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" )

set_post_logout() {  # $1=clientId  $2=base url
  local name=$1 url=$2
  local uris="${url}##${url}/*"
  local cid
  cid=$(curl -sS "${AUTH[@]}" "$KC_URL/admin/realms/$REALM/clients?clientId=$name" | jq -r '.[0].id')
  if [[ -z "$cid" || "$cid" == "null" ]]; then
    echo "  ⚠️  client '$name' 不存在，跳过"
    return 0
  fi
  # GET → merge attributes（null 安全，不覆盖其他 attribute）→ PUT
  curl -sS "${AUTH[@]}" "$KC_URL/admin/realms/$REALM/clients/$cid" \
    | jq --arg u "$uris" '.attributes = ((.attributes // {}) + {"post.logout.redirect.uris": $u})' \
    | curl -sS -X PUT "${AUTH[@]}" "$KC_URL/admin/realms/$REALM/clients/$cid" -d @-
  echo "  ✓ $name  post-logout = $uris"
}

echo "==> Updating post-logout redirect URIs"
set_post_logout meet "$MEET_URL"
set_post_logout docs "$DOCS_URL"

echo
echo "完成。验证：无痕登录后点 Logout → 应正常登出、跳回首页（不再 Invalid redirect uri）。"
