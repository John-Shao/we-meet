#!/usr/bin/env bash
# bootstrap-i18n.sh — 开启 meet realm 国际化（中/英），登录页按浏览器语言切换。
#
# 生效顺序（Keycloak）：OIDC ui_locales 参数 → 用户已存 locale → 浏览器
# Accept-Language → realm defaultLocale。故：中文浏览器/默认 → 中文；
# Accept-Language 命中 en → 英文。theme 的 UI 文案已抽成 ${msg(key)}，
# 由 messages_zh_CN.properties / messages_en.properties 提供两套翻译。
#
# ⚠️ 部署顺序：**先跑本脚本**（realm 配置，落 DB），**再上新 theme 镜像**，
#    避免"国际化未开 + 新 theme 已带 messages_en"时英文闪现的窗口。
#
# Run:  bash bootstrap-i18n.sh
set -euo pipefail

if [[ ! -f .env ]]; then echo ".env 不存在，先 cp .env.dist .env"; exit 1; fi
set -a; source .env; set +a

KC_URL="${KC_URL:-https://id.we-meet.online}"
REALM="${REALM:-meet}"
DEFAULT_LOCALE="${DEFAULT_LOCALE:-zh-CN}"
SUPPORTED_LOCALES="${SUPPORTED_LOCALES:-[\"zh-CN\",\"en\"]}"

echo "==> Admin login"
TOKEN=$(curl -sS --fail "$KC_URL/realms/master/protocol/openid-connect/token" \
  --data-urlencode "client_id=admin-cli" \
  --data-urlencode "username=$KC_ADMIN_USER" \
  --data-urlencode "password=$KC_ADMIN_PASSWORD" \
  --data-urlencode "grant_type=password" | jq -r .access_token)
[[ -n "$TOKEN" && "$TOKEN" != "null" ]] || { echo "ERROR: admin token 获取失败"; exit 1; }
AUTH=( -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" )

echo "==> Enabling i18n on realm '$REALM' (default=$DEFAULT_LOCALE, supported=$SUPPORTED_LOCALES)"
curl -sS "${AUTH[@]}" -X PUT "$KC_URL/admin/realms/$REALM" -d "{
  \"internationalizationEnabled\": true,
  \"defaultLocale\": \"$DEFAULT_LOCALE\",
  \"supportedLocales\": $SUPPORTED_LOCALES
}"

echo
echo "完成。验证："
echo "  - 中文浏览器无痕开登录页 → 中文；"
echo "  - 浏览器语言设 English（或 curl -H 'Accept-Language: en'）→ 英文；"
echo "  - 标签页标题也随语言（loginTitle 已本地化）。"
echo "回滚：PUT realm internationalizationEnabled=false。"
