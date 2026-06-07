#!/bin/bash
# entrypoint.sh （v3：加 entitlement / token 续签 / observed 上报）
#
# 职责：
#   1. 首次启动：从 seed 目录初始化空的 home volume
#   2. 旧 volume 迁移：legacy config.yaml / 老 Hermes 源码 / 老 shim 清理
#   3. P1: 容器 ↔ gateway 控制面闭环
#      a. 续签 LAIFU_USER_TOKEN（如果距 exp <7d）
#      b. 拉 desired entitlements (GET /api/me/entitlements)
#      c. 按列表软链 /opt/hermes-skills/<feature> → ~/.hermes/skills/<feature>
#      d. 上报 observed (POST /api/me/observed-entitlements)
#   4. 启动 hermes server
#
# 必需环境变量 (gateway provisioning 注入):
#   LAIFU_USER_TOKEN         90d JWT, payload 含 user_id + token_version
#   GATEWAY_BASE_URL         e.g. https://gateway.lingxi.internal
#                            本地 dev 时通过 docker-compose / dev-hermes.sh 传 http://host.docker.internal:9000
#
# 可选:
#   OPENAI_API_KEY / ANTHROPIC_API_KEY  LLM 凭据 (Hermes 直接用)

set -e

# 注: NFS subPath 子目录的 owner 由 ACA initContainer (init-chown) 在主容器启动前 chown,
# 见 apps/gateway/src/provisioning/azure.ts 的 initContainers 块。
# 这里不能用 sudo — ACA 默认 no_new_privs=true 禁止任何 setuid 提权。

SEED=/home/hermes-seed
HOME_DIR=/home/hermes
CFG="$HOME_DIR/.hermes/config.yaml"
SEED_CFG="$SEED/.hermes/config.yaml"
SKILLS_DIR="$HOME_DIR/.hermes/skills"
SKILLS_SOURCE=/opt/hermes-skills
TOKEN_FILE="$HOME_DIR/.hermes/.laifu_user_token"

# ============ Step 1: seed 初始化 ============
if [ ! -f "$HOME_DIR/.initialized" ]; then
  echo "[entrypoint] first boot — seeding $HOME_DIR from $SEED"
  cp -a "$SEED/." "$HOME_DIR/" 2>/dev/null || true
  touch "$HOME_DIR/.initialized"
  echo "[entrypoint] seed complete"
else
  echo "[entrypoint] existing home detected, skipping seed"
fi

# ============ Step 2: 旧 config 迁移 ============
if [ -f "$CFG" ] && ! grep -q '\${OPENAI_API_KEY}' "$CFG"; then
  echo "[entrypoint] legacy config detected (plaintext key) — restoring template from seed"
  cp -f "$SEED_CFG" "$CFG"
fi

# ============ Step 3: 旧 Hermes 源码 / shim 迁移 ============
if [ -d "$HOME_DIR/.hermes/hermes-agent" ]; then
  echo "[entrypoint] legacy Hermes source detected — removing"
  rm -rf "$HOME_DIR/.hermes/hermes-agent"
fi
if [ -e "$HOME_DIR/.local/bin/hermes" ]; then
  echo "[entrypoint] legacy hermes shim detected — removing"
  rm -f "$HOME_DIR/.local/bin/hermes"
fi

# ============ Step 4: 健全性检查 ============
if [ -z "$OPENAI_API_KEY" ] && [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "[entrypoint] WARN: no LLM API key set — Hermes will fail on first LLM call" >&2
fi

# ============ Step 5: LAIFU_USER_TOKEN 续签 (如果距 exp <7d) ============
# Fallback: prod (Azure) gets LAIFU_USER_TOKEN via env. Dev (docker restart) reuses
# the original env from docker run, which won't have a freshly-injected token. In
# both cases, if a token file exists on the persistent home volume, prefer it.
if [ -z "$LAIFU_USER_TOKEN" ] && [ -f "$TOKEN_FILE" ]; then
  LAIFU_USER_TOKEN=$(cat "$TOKEN_FILE")
  echo "[entrypoint] loaded LAIFU_USER_TOKEN from $TOKEN_FILE"
fi
# export 让 server.py / hermes / cloud-file 等子进程都拿到 (line 68 之前是
# shell-only 变量,subprocess 继承不到)
export LAIFU_USER_TOKEN
export GATEWAY_BASE_URL

if [ -z "$LAIFU_USER_TOKEN" ] || [ -z "$GATEWAY_BASE_URL" ]; then
  echo "[entrypoint] FATAL: LAIFU_USER_TOKEN 或 GATEWAY_BASE_URL 未设 — 拒绝启动" >&2
  echo "[entrypoint] 容器必须能向 gateway 鉴权并同步 entitlements; 不再静默降级运行。" >&2
  exit 1
fi

# 解 JWT payload 取 exp
JWT_PAYLOAD=$(echo "$LAIFU_USER_TOKEN" | cut -d. -f2)
# base64url decode (jq 不直接支持 base64url，先转换为 base64)
JWT_PAYLOAD_PADDED=$(echo "$JWT_PAYLOAD" | tr '_-' '/+' )
# pad 到 4 的倍数
PAD=$(( 4 - ${#JWT_PAYLOAD_PADDED} % 4 ))
[ $PAD -eq 4 ] && PAD=0
PADDING=$(printf "%${PAD}s" | tr ' ' '=')
TOKEN_EXP=$(echo "${JWT_PAYLOAD_PADDED}${PADDING}" | base64 -d 2>/dev/null | jq -r '.exp // 0')
NOW=$(date +%s)
SECS_LEFT=$(( TOKEN_EXP - NOW ))

echo "[entrypoint] LAIFU_USER_TOKEN expires in $(( SECS_LEFT / 86400 )) days"

if [ "$SECS_LEFT" -lt $(( 7 * 86400 )) ]; then
  echo "[entrypoint] token within 7d of exp — refreshing"
  REFRESH_RESP=$(curl -fsS -m 10 -X POST \
    -H "Authorization: Bearer $LAIFU_USER_TOKEN" \
    -H "Content-Type: application/json" \
    "$GATEWAY_BASE_URL/api/auth/refresh-token" || echo "")
  if [ -n "$REFRESH_RESP" ]; then
    NEW_TOKEN=$(echo "$REFRESH_RESP" | jq -r '.token // ""')
    if [ -n "$NEW_TOKEN" ] && [ "$NEW_TOKEN" != "null" ]; then
      LAIFU_USER_TOKEN="$NEW_TOKEN"
      echo "$NEW_TOKEN" > "$TOKEN_FILE"
      echo "[entrypoint] token refreshed (new exp ~90 days)"
    else
      echo "[entrypoint] WARN: refresh-token returned no token, keeping old" >&2
    fi
  else
    echo "[entrypoint] WARN: refresh-token request failed, keeping old" >&2
  fi
fi

# ============ Step 6: 拉 desired entitlements 并软链 skills ============
# Retry 7 次 (累计 ~21s),应对 dev 模式下 concurrently 同时起 hermes + gateway
# 但 gateway 还没 ready 的 race condition。
echo "[entrypoint] fetching desired entitlements"
# 重试只为容错 dev 下 gateway 比容器晚起的 race。
# 关键: 区分两种失败 —
#   - 连得上但 HTTP 报错 (401/403/...): token 失效/用户不存在 → 重试无意义, 直接致命退出。
#   - 连不上 (curl 失败 / code 000): gateway 还没起 → 重试; 重试光仍连不上 → 致命退出。
# 绝不再静默降级成"空 entitlements 继续跑"。
ENT_JSON=""
for i in $(seq 1 7); do
  HTTP_OUT=$(curl -sS -m 5 -w $'\n%{http_code}' \
    -H "Authorization: Bearer $LAIFU_USER_TOKEN" \
    "$GATEWAY_BASE_URL/api/me/entitlements" 2>/dev/null) || HTTP_OUT=""
  CODE=$(printf '%s' "$HTTP_OUT" | tail -n1)
  BODY=$(printf '%s' "$HTTP_OUT" | sed '$d')
  if [ "$CODE" = "200" ]; then
    ENT_JSON="$BODY"
    echo "[entrypoint] entitlements 已获取 (attempt $i)"
    break
  fi
  if [ -n "$CODE" ] && [ "$CODE" != "000" ]; then
    echo "[entrypoint] FATAL: gateway 拒绝了 token (HTTP $CODE): $BODY" >&2
    echo "[entrypoint] 多半是 dev token 失效或该用户不在库里。重签 token / 重新 provision 后再启动; 不静默降级。" >&2
    exit 1
  fi
  echo "[entrypoint] gateway 暂不可达 (attempt $i/7), 等 3s..." >&2
  sleep 3
done

if [ -z "$ENT_JSON" ]; then
  echo "[entrypoint] FATAL: 重试 7 次仍连不上 gateway ($GATEWAY_BASE_URL) — 拒绝启动" >&2
  exit 1
fi

DESIRED=$(echo "$ENT_JSON" | jq -r '.entitlements[]?' 2>/dev/null || echo "")
OBSERVED_TOKEN_VERSION=$(echo "$ENT_JSON" | jq -r '.token_version // 0' 2>/dev/null)
echo "[entrypoint] desired entitlements: $(echo "$DESIRED" | tr '\n' ' ')"

mkdir -p "$SKILLS_DIR"

# 清掉所有我们 (laifu) 之前建的 skill 软链, 下面按当前 desired 重建。
# 识别方式: 软链 target 指向 $SKILLS_SOURCE (即 /opt/hermes-skills) 的就是我们建的。
# 这样 disable 的会自然消失, 也顺带迁移旧的无前缀命名; 绝不碰 Hermes 自带 skill 目录/软链。
for link in "$SKILLS_DIR"/*; do
  [ -L "$link" ] || continue
  case "$(readlink "$link")" in
    "$SKILLS_SOURCE"/*) echo "[entrypoint] removing previous skill link: $(basename "$link")"; rm -f "$link" ;;
  esac
done

# 软链 desired 的 skill。统一加 laifu- 前缀: Hermes 自带同名 skill (如 email/github) 时,
# 不加前缀会让 ln 把软链塞进对方真实目录 (email/email), 我们的 SKILL.md 被埋、agent 看不到。
OBSERVED_LIST=""
for feature in $DESIRED; do
  TARGET="$SKILLS_SOURCE/$feature"
  LINK="$SKILLS_DIR/laifu-$feature"
  if [ -d "$TARGET" ]; then
    ln -snf "$TARGET" "$LINK"
    echo "[entrypoint] linked skill: laifu-$feature -> $TARGET"
    OBSERVED_LIST="$OBSERVED_LIST $feature"
  else
    echo "[entrypoint] WARN: skill $feature requested but not installed in image" >&2
  fi
done

# ============ Step 7: 上报 observed ============
# Build JSON array of observed features for the request body
OBSERVED_JSON=$(echo "$OBSERVED_LIST" | tr ' ' '\n' | grep -v '^$' | jq -R . | jq -s . || echo "[]")
REPORT_BODY=$(jq -n --argjson observed "$OBSERVED_JSON" --argjson tv "$OBSERVED_TOKEN_VERSION" \
  '{observed: $observed, token_version: $tv}')

echo "[entrypoint] reporting observed: $REPORT_BODY"
REPORT_CODE=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $LAIFU_USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$REPORT_BODY" \
  "$GATEWAY_BASE_URL/api/me/observed-entitlements" 2>/dev/null) || REPORT_CODE="000"
if [ "$REPORT_CODE" != "200" ]; then
  echo "[entrypoint] FATAL: 上报 observed 失败 (HTTP $REPORT_CODE) — 拒绝启动" >&2
  exit 1
fi
echo "[entrypoint] observed 上报成功"

# ============ Start ============
exec "$@"
