#!/usr/bin/env bash
# check-config.sh — 部署前配置自检.
#
# 在 setup-customer.sh 之后, install-k3s.sh / install-meet.sh 之前跑.
# 校验客制化配置是否完整 + 内部一致, 让 helm install 之前就抓出大部分配错.
#
# 用法:
#   bash deploy/aliyun/check-config.sh                # 完整校验
#   bash deploy/aliyun/check-config.sh --strict       # warn 也算 fail (CI 友好)
#   bash deploy/aliyun/check-config.sh --skip-dns     # 不做 DNS 解析检查 (离线)
#
# 输出:
#   ✅ 通过
#   ⚠️  应修但能跑
#   ❌ 必修 (脚本 exit 1)
#
# 不依赖 yq/yaml 解析器, 全 grep + sed 实现, 不需额外安装.

set -uo pipefail   # 不用 -e — 我们要继续累计错误, 不要一遇 grep miss 就退出

STRICT=0
SKIP_DNS=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)   sed -n '2,17p' "$0"; exit 0 ;;
    --strict)    STRICT=1; shift ;;
    --skip-dns)  SKIP_DNS=1; shift ;;
    *) echo "ERROR: unknown option $1" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

SECRETS=src/helm/env.d/aliyun-prod/values.secrets.yaml
MEET_VALUES=src/helm/env.d/aliyun-prod/values.meet.yaml
LIVEKIT_VALUES=src/helm/env.d/aliyun-prod/values.livekit.yaml
CLUSTER_ISSUER=src/helm/env.d/aliyun-prod/cluster-issuer.yaml
KC_ENV=deploy/aliyun/keycloak/.env
KC_CADDYFILE=deploy/aliyun/keycloak/Caddyfile
KC_COMPOSE=deploy/aliyun/keycloak/compose.yaml
KC_BOOTSTRAP=deploy/aliyun/keycloak/bootstrap-realm.sh

FAIL_COUNT=0
WARN_COUNT=0
PASS_COUNT=0

ok()   { echo "  ✅ $*"; PASS_COUNT=$((PASS_COUNT+1)); }
warn() { echo "  ⚠️  $*"; WARN_COUNT=$((WARN_COUNT+1)); }
fail() { echo "  ❌ $*"; FAIL_COUNT=$((FAIL_COUNT+1)); }

section() {
  echo
  echo "── $* ──"
}

# ── Section 1: 文件存在 ──
section "[1/5] 必需文件存在"

for f in "$SECRETS" "$KC_ENV" "$MEET_VALUES" "$LIVEKIT_VALUES" "$CLUSTER_ISSUER" "$KC_CADDYFILE" "$KC_COMPOSE" "$KC_BOOTSTRAP"; do
  if [[ -f "$f" ]]; then
    ok "$f 存在"
  else
    case "$f" in
      "$SECRETS"|"$KC_ENV") fail "$f 缺失 — 跑 deploy/aliyun/setup-customer.sh 生成" ;;
      *) fail "$f 缺失 — git checkout 还原" ;;
    esac
  fi
done

# 后续 section 不依赖缺失文件
if [[ ! -f "$SECRETS" || ! -f "$KC_ENV" ]]; then
  echo
  echo "❌ values.secrets.yaml 或 keycloak/.env 缺失, 跳过后续检查."
  echo "   先跑: bash deploy/aliyun/setup-customer.sh <DOMAIN> <OPS_EMAIL>"
  exit 1
fi

# ── Section 2: 占位符未替换 ──
section "[2/5] 模板占位符已替换 (setup-customer.sh 跑过)"

# 模板占位 example.com / your-cr.cr-domain.com / REPLACE_OWNER_EMAIL 不应该在任何被 deploy 的文件里
TEMPLATE_PLACEHOLDERS=(
  "example.com"
  "your-cr.cr-domain.com"
  "REPLACE_OWNER_EMAIL"
  "admin@example.com"
)
TEMPLATE_FILES=(
  "$MEET_VALUES" "$LIVEKIT_VALUES" "$CLUSTER_ISSUER"
  "$KC_CADDYFILE" "$KC_COMPOSE" "$KC_BOOTSTRAP" "$KC_ENV"
)
PLACEHOLDER_HIT=0
for ph in "${TEMPLATE_PLACEHOLDERS[@]}"; do
  for f in "${TEMPLATE_FILES[@]}"; do
    [[ -f "$f" ]] || continue
    if grep -qF "$ph" "$f"; then
      fail "$f 仍含模板占位 '$ph' — 跑 setup-customer.sh"
      PLACEHOLDER_HIT=1
    fi
  done
done
[[ $PLACEHOLDER_HIT -eq 0 ]] && ok "无 example.com / your-cr / REPLACE_OWNER_EMAIL 残留"

# bare 'your-cr' 单独检查 (可能被 setup-customer.sh 替换成 instance 名了)
if grep -qE "\byour-cr\b" "$MEET_VALUES" "$LIVEKIT_VALUES" 2>/dev/null; then
  fail "values.*.yaml 里还有 bare 'your-cr' 引用 — setup-customer.sh 第 4/5 步漏跑?"
fi

# ── Section 3: secrets 完整性 (无 REPLACE_*) ──
section "[3/5] values.secrets.yaml 所有必填项已填"

# 必填的 REPLACE_* (没填部署起不来)
REQUIRED_REPLACES=(
  REPLACE_DJANGO_SECRET_KEY
  REPLACE_ADMIN_PASSWORD
  REPLACE_POSTGRES_APP_PASSWORD
  REPLACE_REDIS_PASSWORD
  REPLACE_LIVEKIT_API_SECRET
  REPLACE_SUMMARY_API_TOKEN
  REPLACE_SUMMARY_WEBHOOK_TOKEN
  REPLACE_KEYCLOAK_CLIENT_SECRET
  REPLACE_OSS_ACCESS_KEY_ID
  REPLACE_OSS_ACCESS_KEY_SECRET
  REPLACE_VOLCENGINE_ARK_API_KEY
  REPLACE_VOLC_CR_USERNAME
  REPLACE_VOLC_CR_PASSWORD
)
REQ_MISS=0
for k in "${REQUIRED_REPLACES[@]}"; do
  if grep -qF "$k" "$SECRETS"; then
    case "$k" in
      REPLACE_KEYCLOAK_CLIENT_SECRET)
        warn "$k 未填 — 跑 keycloak/bootstrap-realm.sh 后会输出, 填到 OIDC_RP_CLIENT_SECRET" ;;
      *)
        fail "$k 未填 — 见 setup-customer.sh 末尾 checklist" ;;
    esac
    REQ_MISS=1
  fi
done
[[ $REQ_MISS -eq 0 ]] && ok "13 项必填 REPLACE_* 全部已填"

# 可选: SMTP
for k in REPLACE_SMTP_USER REPLACE_SMTP_PASSWORD; do
  if grep -qF "$k" "$SECRETS"; then
    warn "$k 未填 — 邮件功能不可用 (v1 不发邮件 OK)"
  fi
done

# 可选: LLM endpoint
if grep -qF "REPLACE_LLM_ENDPOINT_ID" "$MEET_VALUES"; then
  warn "values.meet.yaml LLM_MODEL 仍是 REPLACE_LLM_ENDPOINT_ID — 客户需在火山方舟控制台创建接入点 (ep-XXXXX) 后填"
fi

# Keycloak .env
if grep -qE "^KC_(ADMIN|DB)_PASSWORD=REPLACE_" "$KC_ENV"; then
  fail "keycloak/.env 里 KC_ADMIN_PASSWORD 或 KC_DB_PASSWORD 还是 REPLACE_* 占位"
else
  ok "keycloak/.env KC_ADMIN_PASSWORD + KC_DB_PASSWORD 已填"
fi

# ── Section 4: 跨文件一致性 ──
section "[4/5] 跨文件密钥一致性"

# 提取一个 yaml key value (简单 grep -oP 风格)
# Usage: yget <file> <key>  → 返回 first match value (粗略, 不解析嵌套)
yget() {
  local file=$1 key=$2
  # 匹配 "  key: value" 形式 (允许 0-N 个前导空格)
  grep -E "^[[:space:]]*$key:[[:space:]]+" "$file" 2>/dev/null \
    | head -1 \
    | sed -E "s|^[[:space:]]*$key:[[:space:]]+||; s|[[:space:]]+#.*$||; s|^[\"']||; s|[\"']$||"
}

# 用 awk state-machine 提取嵌套 yaml key. 不依赖 yq.
# Usage: yget_nested <file> <top_key> <sub_path...>
#   yget_nested f livekit keys meet     → livekit.keys.meet 的值
#   yget_nested f livekit redis password → livekit.redis.password 的值
yget_nested() {
  local file=$1 top=$2; shift 2
  local path=("$@")
  awk -v top="$top" -v path_csv="$(IFS=,; echo "${path[*]}")" '
    BEGIN { split(path_csv, sub_keys, ","); depth=0; target=length(sub_keys); }
    # 进入 top-level section
    $0 ~ ("^"top":") { in_top=1; depth=1; next }
    # 退出 top section (下一个 top-level key, 即首字符非空格非 #)
    in_top && /^[a-zA-Z]/ { exit }
    # 在 top 内匹配嵌套 key
    in_top {
      # 计算当前缩进 (空格数)
      match($0, /^[[:space:]]+/);
      cur_indent = RLENGTH;
      # 找 path[depth-1] 的 key
      if (depth <= target) {
        wanted = sub_keys[depth];
        # YAML key: "<spaces><wanted>:" optionally followed by value
        re = "^[[:space:]]+" wanted ":";
        if ($0 ~ re) {
          if (depth == target) {
            # 最深层, 提取值
            sub(re "[[:space:]]*", "");
            sub(/[[:space:]]+#.*$/, "");
            print;
            exit;
          } else {
            depth++;
          }
        }
      }
    }
  ' "$file"
}

# 4.1 LIVEKIT_API_SECRET 一致性
# values.secrets.yaml 里 livekit.keys.meet 应该跟 backend/celery/agentMetadata 三个
# envVars.LIVEKIT_API_SECRET 一致
LK_KEY_MEET=$(yget_nested "$SECRETS" livekit keys meet)
LK_BACKEND=$(awk '/^backend:/,/^celery:/' "$SECRETS" | grep "LIVEKIT_API_SECRET:" | head -1 | sed -E "s|.*LIVEKIT_API_SECRET:[[:space:]]+||")
LK_CELERY=$(awk '/^celery:/,/^summary:/' "$SECRETS" | grep "LIVEKIT_API_SECRET:" | head -1 | sed -E "s|.*LIVEKIT_API_SECRET:[[:space:]]+||")
LK_AGENT=$(awk '/^agentMetadata:/,/^livekit:/' "$SECRETS" | grep "LIVEKIT_API_SECRET:" | head -1 | sed -E "s|.*LIVEKIT_API_SECRET:[[:space:]]+||")

if [[ -z "$LK_KEY_MEET" ]]; then
  fail "找不到 livekit.keys.meet (values.secrets.yaml)"
elif [[ "$LK_KEY_MEET" == "$LK_BACKEND" && "$LK_KEY_MEET" == "$LK_CELERY" && "$LK_KEY_MEET" == "$LK_AGENT" ]]; then
  ok "LIVEKIT_API_SECRET 在 livekit.keys.meet / backend / celery / agentMetadata 4 处一致"
else
  fail "LIVEKIT_API_SECRET 跨 section 不一致 (livekit.keys.meet=$LK_KEY_MEET, backend=$LK_BACKEND, celery=$LK_CELERY, agentMetadata=$LK_AGENT) — backend 验签会失败"
fi

# 4.2 livekit.webhook.api_key 必须是 "meet"
WH_KEY=$(yget_nested "$SECRETS" livekit webhook api_key)
if [[ "$WH_KEY" == "meet" ]]; then
  ok "livekit.webhook.api_key = 'meet' (key 名, 不是 secret 值)"
elif [[ -z "$WH_KEY" ]]; then
  fail "livekit.webhook.api_key 未设 — LiveKit 会 CrashLoop"
else
  fail "livekit.webhook.api_key='$WH_KEY' — 应为 keys 块里的 KEY 名字 'meet', 不是 secret 值 (老 dist 模板的坑)"
fi

# 4.3 REDIS_PASSWORD 一致 (URL 里 redis://default:<PW>@redis-master)
# 提取所有 redis URL 中的密码部分, 去重
REDIS_PWS=$(grep -oE "redis://default:[^@]+@" "$SECRETS" | sed -E "s|redis://default:(.+)@|\1|" | sort -u)
N=$(echo "$REDIS_PWS" | wc -l)
if [[ -z "$REDIS_PWS" ]]; then
  warn "找不到任何 redis:// URL"
elif [[ "$N" -eq 1 ]]; then
  ok "REDIS_PASSWORD 在所有 redis:// URL 里一致"
else
  fail "REDIS_PASSWORD 多个不同值 ($N 个): $(echo "$REDIS_PWS" | tr '\n' ' ')"
fi

# 4.4 livekit.redis.password 应跟 URL 里那个一致
LK_REDIS_PW=$(yget_nested "$SECRETS" livekit redis password)
URL_REDIS_PW=$(echo "$REDIS_PWS" | head -1)
if [[ -z "$LK_REDIS_PW" ]]; then
  warn "找不到 livekit.redis.password"
elif [[ "$LK_REDIS_PW" == "$URL_REDIS_PW" ]]; then
  ok "livekit.redis.password 跟 redis:// URL 的密码一致"
else
  fail "livekit.redis.password='$LK_REDIS_PW' 跟 URL 里的 '$URL_REDIS_PW' 不一致"
fi

# 4.5 DB_PASSWORD 跨 section 一致
DB_BACK=$(awk '/^backend:/,/^celery:/' "$SECRETS" | grep "DB_PASSWORD:" | head -1 | sed -E "s|.*DB_PASSWORD:[[:space:]]+||")
DB_CEL=$(awk '/^celery:/,/^summary:/' "$SECRETS" | grep "DB_PASSWORD:" | head -1 | sed -E "s|.*DB_PASSWORD:[[:space:]]+||")
if [[ -n "$DB_BACK" && "$DB_BACK" == "$DB_CEL" ]]; then
  ok "DB_PASSWORD 在 backend + celery 两处一致"
elif [[ -z "$DB_BACK" ]]; then
  fail "backend.envVars.DB_PASSWORD 未设"
else
  fail "DB_PASSWORD 不一致 (backend=$DB_BACK, celery=$DB_CEL) — celery 连不上 DB"
fi

# 4.6 域名一致性: 提取 values.meet.yaml 的 ingress.host (形如 meet.<DOMAIN>),
# 跟 Caddyfile 里的 id.<DOMAIN> 比对.
MEET_HOST=$(grep -E "^[[:space:]]+host:" "$MEET_VALUES" | head -1 | sed -E "s|.*host:[[:space:]]+||")
DOMAIN_FROM_MEET="${MEET_HOST#*.}"   # strip leading subdomain (meet./livekit./id.)
# Caddyfile 第一个非注释 host 行 (id.<DOMAIN> {)
CADDY_HOST=$(grep -vE "^\s*#" "$KC_CADDYFILE" | grep -oE "[a-z][a-z0-9.-]+\.[a-z]{2,}[[:space:]]*\{" | head -1 | sed -E "s|[[:space:]]*\{||")
DOMAIN_FROM_CADDY="${CADDY_HOST#*.}"

if [[ -n "$DOMAIN_FROM_MEET" && "$DOMAIN_FROM_MEET" == "$DOMAIN_FROM_CADDY" ]]; then
  ok "DOMAIN 在 values.meet.yaml 与 keycloak/Caddyfile 一致 ($DOMAIN_FROM_MEET)"
else
  warn "DOMAIN 跨文件不一致 (values.meet.yaml: '$DOMAIN_FROM_MEET', Caddyfile: '$DOMAIN_FROM_CADDY')"
fi

# ── Section 5: 语义 / 格式 / 外部检查 ──
section "[5/5] 语义校验 + DNS"

# 5.1 OPS_EMAIL 格式 (cluster-issuer)
OPS_EMAIL_VAL=$(grep -E "^[[:space:]]*email:" "$CLUSTER_ISSUER" | head -1 | sed -E "s|.*email:[[:space:]]+||")
if [[ "$OPS_EMAIL_VAL" == REPLACE_* ]] || [[ "$OPS_EMAIL_VAL" == *@example.com ]]; then
  fail "cluster-issuer email 还是占位 ('$OPS_EMAIL_VAL') — setup-customer.sh 没替换"
elif [[ "$OPS_EMAIL_VAL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
  ok "cluster-issuer email 格式合法 ($OPS_EMAIL_VAL)"
else
  fail "cluster-issuer email 格式不对: '$OPS_EMAIL_VAL'"
fi

# 5.2 CR registry 格式
CR_REG=$(grep -E "^[[:space:]]+registry:" "$SECRETS" | head -1 | sed -E "s|.*registry:[[:space:]]+||")
if [[ "$CR_REG" =~ ^[a-z0-9.-]+\.cr\.volces\.com$ ]] && ! [[ "$CR_REG" =~ ^your-cr ]]; then
  ok "CR_REGISTRY 格式合法 ($CR_REG)"
else
  fail "CR_REGISTRY 格式不对或仍是占位: '$CR_REG'"
fi

# 5.3 VOLC_CR_USERNAME 包含 @ (实例级凭证格式)
CR_USER=$(grep -E "^[[:space:]]+username:" "$SECRETS" | head -1 | sed -E "s|.*username:[[:space:]]+||; s|[[:space:]]+#.*||")
if [[ "$CR_USER" == *"@"* ]] && [[ "$CR_USER" != "REPLACE_"* ]]; then
  ok "VOLC_CR_USERNAME 格式合法 ($CR_USER)"
else
  fail "VOLC_CR_USERNAME='$CR_USER' — 必须是 <custom_user>@<account_id> 形式 (主账号 AK 不能登 CR)"
fi

# 5.4 DNS 解析 (可选, --skip-dns 跳过)
if [[ $SKIP_DNS -eq 0 && -n "$DOMAIN_FROM_MEET" ]]; then
  if ! command -v nslookup >/dev/null && ! command -v dig >/dev/null && ! command -v host >/dev/null; then
    warn "本机找不到 nslookup/dig/host, 跳过 DNS 检查"
  else
    for sub in meet livekit id; do
      HOST="$sub.$DOMAIN_FROM_MEET"
      RESOLVED=""
      if command -v dig >/dev/null; then
        RESOLVED=$(dig +short "$HOST" @223.5.5.5 2>/dev/null | head -1)
      elif command -v nslookup >/dev/null; then
        RESOLVED=$(nslookup "$HOST" 223.5.5.5 2>/dev/null | awk '/^Address: / {print $2}' | head -1)
      else
        RESOLVED=$(host "$HOST" 223.5.5.5 2>/dev/null | grep "has address" | awk '{print $NF}' | head -1)
      fi
      if [[ -n "$RESOLVED" ]]; then
        ok "DNS: $HOST → $RESOLVED"
      else
        warn "DNS: $HOST 解析失败 (DNS 记录未生效? --skip-dns 跳过)"
      fi
    done
  fi
fi

# ── 总结 ──
echo
echo "================================================================"
echo "结果: ✅ $PASS_COUNT 通过 / ⚠️  $WARN_COUNT 警告 / ❌ $FAIL_COUNT 失败"
echo "================================================================"

if [[ $FAIL_COUNT -gt 0 ]]; then
  echo "❌ 有必修项, 修完再跑 install-meet.sh."
  exit 1
elif [[ $STRICT -eq 1 && $WARN_COUNT -gt 0 ]]; then
  echo "⚠️  --strict 模式: 警告也算失败."
  exit 1
else
  if [[ $WARN_COUNT -gt 0 ]]; then
    echo "⚠️  有警告项 (能跑但建议修)."
  else
    echo "✅ 配置完整, 可以部署."
  fi
  exit 0
fi
