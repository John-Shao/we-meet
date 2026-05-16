#!/usr/bin/env bash
# setup-customer.sh — 把 example.com 模板仓库一键改造为某客户的部署仓库.
#
# 做两件事:
#   1. 替换占位符 (9 个文件):
#        example.com                       → 客户域名
#        REPLACE_OWNER_EMAIL@example.com   → 客户 OPS_EMAIL
#        admin@example.com                 → 客户 ADMIN_EMAIL
#        your-cr.cr.volces.com             → 客户 CR_REGISTRY
#        your-cr (bare instance refs)      → CR_REGISTRY 的 instance 部分
#   2. 从 .dist 模板生成 values.secrets.yaml + keycloak/.env, 自动填入随机
#      生成的密钥, 留下需要客户人工填的字段并打印 checklist
#
# 用法:
#   bash deploy/aliyun/setup-customer.sh <DOMAIN> <OPS_EMAIL> [ADMIN_EMAIL]
#
# 示例:
#   bash deploy/aliyun/setup-customer.sh acme.com ops@acme.com
#   # → DOMAIN=acme.com, CR_REGISTRY=acme-cn-guangzhou.cr.volces.com (从 DOMAIN 第一段派生)
#
#   bash deploy/aliyun/setup-customer.sh acme.com ops@acme.com admin@corp.io
#   # → 同上 + ADMIN_EMAIL=admin@corp.io (默认 admin@<DOMAIN>, 此例自定义)
#
#   bash deploy/aliyun/setup-customer.sh acme.com ops@acme.com --cr-registry myorg-cn-beijing.cr.volces.com
#   # → DOMAIN=acme.com, 显式指定 CR 实例 (region 也不是默认 cn-guangzhou)
#
# 选项:
#   --cr-registry <HOST>  显式指定火山 CR registry host (含 region).
#                          默认: <DOMAIN-第一段>-cn-guangzhou.cr.volces.com
#   --force               覆盖已存在的 values.secrets.yaml / keycloak/.env
#   --dry-run             仅打印改动概要, 不真改文件
#   -h | --help           打印帮助
#
# 注意:
#   - 脚本会替换文件 (含 docs/installation/aliyun.md), 跑完 git status 看 diff,
#     满意后 git commit -am 'customer config'. 不满意 git checkout 整体回滚.
#   - 重复执行只在干净 (example.com 还在的) 仓库上有效; 已替换的仓库脚本会
#     拒绝运行 (改成 git checkout main -- <相关文件> 后再跑).
#   - 拒绝用 example.com / your-domain.com / your-cr 等占位值作为参数.
#   - secrets (DJANGO/REDIS/POSTGRES/LIVEKIT/SUMMARY 等) 用 openssl rand 生成.
#     外部凭据 (火山 CR / TOS / ARK / SMTP / Keycloak client secret) 不自动填,
#     脚本末尾会列 checklist.

set -euo pipefail

# -------- 解析参数 --------
FORCE=0
DRY_RUN=0
CR_REGISTRY_ARG=""
POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      sed -n '2,40p' "$0"; exit 0 ;;
    --force)   FORCE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --cr-registry)   CR_REGISTRY_ARG="$2"; shift 2 ;;
    --cr-registry=*) CR_REGISTRY_ARG="${1#--cr-registry=}"; shift ;;
    -*) echo "ERROR: unknown option $1" >&2; exit 2 ;;
    *)  POSITIONAL+=("$1"); shift ;;
  esac
done

if [[ ${#POSITIONAL[@]} -lt 2 ]]; then
  echo "ERROR: 缺少参数. 用法:" >&2
  echo "  bash $0 <DOMAIN> <OPS_EMAIL> [ADMIN_EMAIL] [--cr-registry <HOST>]" >&2
  exit 2
fi

DOMAIN="${POSITIONAL[0]}"
OPS_EMAIL="${POSITIONAL[1]}"
ADMIN_EMAIL="${POSITIONAL[2]:-admin@$DOMAIN}"

# CR_REGISTRY 默认从 DOMAIN 第一段派生; 客户显式 --cr-registry 时覆盖.
DOMAIN_PREFIX="${DOMAIN%%.*}"
CR_REGISTRY="${CR_REGISTRY_ARG:-${DOMAIN_PREFIX}-cn-guangzhou.cr.volces.com}"
# 提取 instance 部分 (用于替换 bare "your-cr" 引用): host 去掉 .cr.volces.com 后缀
CR_INSTANCE="${CR_REGISTRY%.cr.volces.com}"

# 简单格式校验
if ! [[ "$DOMAIN" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]]; then
  echo "ERROR: DOMAIN 看着不像合法域名: $DOMAIN" >&2; exit 2
fi
if ! [[ "$CR_REGISTRY" =~ ^[a-z0-9.-]+\.cr\.volces\.com$ ]]; then
  echo "ERROR: CR_REGISTRY 看着不像火山 CR host (期望 <instance>.cr.volces.com): $CR_REGISTRY" >&2; exit 2
fi
# 拒绝占位值 (会让模板检测失效)
case "$DOMAIN" in
  example.com|example.org|example.net|your-domain.com|localhost|test.com)
    echo "ERROR: DOMAIN=$DOMAIN 是占位/保留域名, 不能用作客户实际域名." >&2
    exit 2 ;;
esac
case "$CR_REGISTRY" in
  your-cr*|*.your-cr.cr.volces.com)
    echo "ERROR: CR_REGISTRY=$CR_REGISTRY 是占位值, 必须 --cr-registry 指定客户实际 CR host." >&2
    exit 2 ;;
esac
for e in "$OPS_EMAIL" "$ADMIN_EMAIL"; do
  if ! [[ "$e" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
    echo "ERROR: 邮箱看着不合法: $e" >&2; exit 2
  fi
done

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

# -------- 检查仓库状态 --------
if ! grep -q "example\.com" src/helm/env.d/aliyun-prod/cluster-issuer.yaml; then
  echo "ERROR: 仓库似乎已经被定制化过 (cluster-issuer.yaml 里找不到 example.com)." >&2
  echo "  如果想重新定制化, 先 git checkout <branch> -- <相关文件> 还原模板." >&2
  exit 3
fi

SECRETS_OUT=src/helm/env.d/aliyun-prod/values.secrets.yaml
KC_ENV_OUT=deploy/aliyun/keycloak/.env
if [[ $FORCE -eq 0 && $DRY_RUN -eq 0 ]]; then
  for f in "$SECRETS_OUT" "$KC_ENV_OUT"; do
    if [[ -f "$f" ]]; then
      echo "ERROR: $f 已存在, 不会覆盖. 加 --force 强制覆盖, 或手动备份." >&2
      exit 3
    fi
  done
fi

# -------- 摘要 --------
cat <<EOF
================================================================
即将定制化仓库:
  DOMAIN       = $DOMAIN          (= meet.$DOMAIN / livekit.$DOMAIN / id.$DOMAIN)
  OPS_EMAIL    = $OPS_EMAIL       (用于 Let's Encrypt 通知, Caddy email)
  ADMIN_EMAIL  = $ADMIN_EMAIL     (Django superuser)
  CR_REGISTRY  = $CR_REGISTRY    (火山 CR host, 镜像走 $CR_REGISTRY/we-meet/*)
  ${DRY_RUN:+(--dry-run, 不真改文件)}
================================================================
EOF

# -------- 文件列表 --------
# Helm/Caddy/Compose configs + driver scripts (build/push/install-meet) + docs.
# 注意: setup-customer.sh 自身不在列表里 (避免自改).
FILES_TO_PATCH=(
  src/helm/env.d/aliyun-prod/values.meet.yaml
  src/helm/env.d/aliyun-prod/values.livekit.yaml
  src/helm/env.d/aliyun-prod/values.secrets.yaml.dist
  src/helm/env.d/aliyun-prod/cluster-issuer.yaml
  deploy/aliyun/keycloak/bootstrap-realm.sh
  deploy/aliyun/keycloak/Caddyfile
  deploy/aliyun/keycloak/compose.yaml
  deploy/aliyun/keycloak/.env.dist
  deploy/aliyun/build.sh
  deploy/aliyun/push.sh
  deploy/aliyun/install-meet.sh
  docs/installation/aliyun.md
)

# run_sub <literal_from> <literal_to> <file>
# 在 dry-run 下仅打印命中数; 否则真改文件.
# from/to 都按 literal 处理 (sed 的正则元字符自动转义).
run_sub() {
  local from=$1 to=$2 file=$3
  # 将 from 里的正则元字符转义, 让 sed 当 literal 处理
  local sed_from
  sed_from=$(printf '%s' "$from" | sed 's/[][\.*^$/&]/\\&/g')
  local sed_to
  sed_to=$(printf '%s' "$to" | sed 's/[\/&]/\\&/g')
  if [[ $DRY_RUN -eq 1 ]]; then
    local hits
    hits=$(grep -cF "$from" "$file" 2>/dev/null || true)
    hits=${hits:-0}
    if [[ "$hits" -gt 0 ]]; then
      echo "  $file: $hits 处 ($from → $to)"
    fi
    return 0
  fi
  sed -i "s|$sed_from|$sed_to|g" "$file"
}

# 重要: 顺序是 email → admin → domain → CR (后做 domain 是为了让前面的 email/admin
# 替换能命中 *example.com* 形式的原始占位, 否则 domain 改完它们就消失了).

echo
echo "==> Step 1/5: 替换 OPS_EMAIL 占位 (Caddyfile + cluster-issuer.yaml)"
run_sub "REPLACE_OWNER_EMAIL@example.com" "$OPS_EMAIL" deploy/aliyun/keycloak/Caddyfile
run_sub "REPLACE_OWNER_EMAIL@example.com" "$OPS_EMAIL" src/helm/env.d/aliyun-prod/cluster-issuer.yaml

# 替换 admin@example.com → ADMIN_EMAIL (仅 ADMIN_EMAIL 非默认时需要)
# 默认是 admin@$DOMAIN, 由 Step 3 的 example.com → DOMAIN 顺带改成.
# 若客户给的 ADMIN_EMAIL 不等于 admin@$DOMAIN, 这里直接替换.
if [[ "$ADMIN_EMAIL" != "admin@$DOMAIN" ]]; then
  echo
  echo "==> Step 2/5: 替换 admin@example.com → $ADMIN_EMAIL (ADMIN_EMAIL 自定义)"
  run_sub "admin@example.com" "$ADMIN_EMAIL" src/helm/env.d/aliyun-prod/values.secrets.yaml.dist
else
  echo
  echo "==> Step 2/5: ADMIN_EMAIL 默认 (admin@$DOMAIN), 跳过 (由 Step 3 顺带替换)"
fi

echo
echo "==> Step 3/5: 替换 example.com → $DOMAIN (扫所有相关文件)"
for f in "${FILES_TO_PATCH[@]}"; do
  run_sub "example.com" "$DOMAIN" "$f"
done

echo
echo "==> Step 4/5: 替换 CR registry 占位 (your-cr.cr.volces.com → $CR_REGISTRY; bare your-cr → $CR_INSTANCE)"
# 顺序很重要: 先替全 host (longest match), 再替 bare instance, 避免双重替换.
for f in "${FILES_TO_PATCH[@]}"; do
  run_sub "your-cr.cr.volces.com" "$CR_REGISTRY" "$f"
done
for f in "${FILES_TO_PATCH[@]}"; do
  run_sub "your-cr" "$CR_INSTANCE" "$f"
done

# -------- Step 3: 生成 secrets / .env --------
gen_hex() { openssl rand -hex 32; }
gen_pw()  { openssl rand -base64 24 | tr -d '+/=' | cut -c1-24; }

echo
echo "==> Step 5/5: 生成 values.secrets.yaml + keycloak/.env (自动填随机密钥)"

if [[ $DRY_RUN -eq 1 ]]; then
  echo "  (--dry-run 跳过 secrets 文件生成)"
else
  # values.secrets.yaml
  cp src/helm/env.d/aliyun-prod/values.secrets.yaml.dist "$SECRETS_OUT"

  DJ_SECRET=$(gen_hex)
  DJ_ADMIN_PW=$(gen_pw)
  PG_PW=$(gen_pw)
  REDIS_PW=$(gen_pw)
  LK_API_SECRET=$(gen_hex)
  SUMMARY_API=$(gen_hex)
  SUMMARY_WEBHOOK=$(gen_hex)

  sed -i \
    -e "s|REPLACE_DJANGO_SECRET_KEY|$DJ_SECRET|g" \
    -e "s|REPLACE_ADMIN_PASSWORD|$DJ_ADMIN_PW|g" \
    -e "s|REPLACE_POSTGRES_APP_PASSWORD|$PG_PW|g" \
    -e "s|REPLACE_REDIS_PASSWORD|$REDIS_PW|g" \
    -e "s|REPLACE_LIVEKIT_API_SECRET|$LK_API_SECRET|g" \
    -e "s|REPLACE_SUMMARY_API_TOKEN|$SUMMARY_API|g" \
    -e "s|REPLACE_SUMMARY_WEBHOOK_TOKEN|$SUMMARY_WEBHOOK|g" \
    "$SECRETS_OUT"

  # keycloak/.env
  cp deploy/aliyun/keycloak/.env.dist "$KC_ENV_OUT"
  KC_ADMIN_PW=$(gen_pw)
  KC_DB_PW=$(gen_pw)
  sed -i \
    -e "s|REPLACE_ADMIN_PASSWORD|$KC_ADMIN_PW|g" \
    -e "s|REPLACE_DB_PASSWORD|$KC_DB_PW|g" \
    "$KC_ENV_OUT"

  echo "  ✓ $SECRETS_OUT (gitignored)"
  echo "  ✓ $KC_ENV_OUT (gitignored)"
fi

# -------- Checklist --------
cat <<EOF

================================================================
✅ 定制化完成. 下一步:

1. 复查 diff:
     git status
     git diff

2. 备份自动生成的 Keycloak admin / DB 密码 (一次性显示, 后续要登 admin 用):
     grep -E "^KC_" deploy/aliyun/keycloak/.env

3. 把这些客户特有外部凭据手填进 $SECRETS_OUT (仍是 REPLACE_* 占位):

   必填 (没这些部署不动) :
     • REPLACE_VOLC_CR_USERNAME / REPLACE_VOLC_CR_PASSWORD
         火山 CR 控制台 → 实例 → 访问凭证 → 创建用户名+固定密码
         (主账号 AK/SK 不能 docker login CR, 必须用实例级凭证)
     • REPLACE_OSS_ACCESS_KEY_ID / REPLACE_OSS_ACCESS_KEY_SECRET
         火山 TOS 主账号 AK/SK, 用于 boto3 S3 协议访问
     • REPLACE_VOLCENGINE_ARK_API_KEY
         火山方舟 ARK API key (LLM + WhisperX, 用于 summary 服务)

   稍后填 (跑 bootstrap-realm.sh 后才知道):
     • REPLACE_KEYCLOAK_CLIENT_SECRET
         在 aliyun-zlm 上 bash deploy/aliyun/keycloak/bootstrap-realm.sh
         脚本会输出 OIDC_RP_CLIENT_SECRET=xxxxx, 填进 $SECRETS_OUT

   可选 (v1 不发邮件可忽略):
     • REPLACE_SMTP_USER / REPLACE_SMTP_PASSWORD

4. 提交客户化 commit (这条 commit 不该 push 回上游模板分支):
     git checkout -b customer/$(echo "$DOMAIN" | cut -d. -f1)
     git commit -am "Configure for $DOMAIN ($OPS_EMAIL)"

5. 跑配置自检 (验证占位都替换好 / secrets 完整 / 跨文件一致):
     bash deploy/aliyun/check-config.sh --skip-dns
     # DNS 配好后再跑不带 --skip-dns 的版本

6. 按 docs/installation/aliyun.md 走部署:
     §3 → DNS 加 meet.$DOMAIN / livekit.$DOMAIN / id.$DOMAIN A 记录
     §4 → 安全组放行端口
     §5 → 在 aliyun-zlm 跑 docker compose up + bootstrap-realm.sh
     §6 → 在 PC 跑 build.sh + push.sh
     §7 → 在 aliyun-sjy 跑 install-k3s.sh + install-meet.sh
================================================================
EOF
