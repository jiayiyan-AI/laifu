#!/bin/bash
# entrypoint.sh （v2：源码移出 home + 环境变量插值）
#
# 职责：
#   1. 首次启动：从 seed 目录初始化空的 home volume
#   2. 旧 volume 迁移：如果 config.yaml 里 api_key 是明文（v1 sed 注入留下的），
#      用 seed 里的模板覆盖一次。新版本 Hermes 启动时会自己从 ${OPENAI_API_KEY}
#      插值，运行时永远不需要把 key 物化到磁盘。
#
# API key 注入：完全由 Hermes 自己处理（config.yaml 里 ${OPENAI_API_KEY}）。
# entrypoint 不再做 sed —— key 不进 volume。

set -e

SEED=/home/hermes-seed
HOME_DIR=/home/hermes
CFG="$HOME_DIR/.hermes/config.yaml"
SEED_CFG="$SEED/.hermes/config.yaml"

# ============ Step 1: seed 初始化 ============
if [ ! -f "$HOME_DIR/.initialized" ]; then
  echo "[entrypoint] first boot — seeding $HOME_DIR from $SEED"
  cp -a "$SEED/." "$HOME_DIR/" 2>/dev/null || true
  touch "$HOME_DIR/.initialized"
  echo "[entrypoint] seed complete"
else
  echo "[entrypoint] existing home detected, skipping seed"
fi

# ============ Step 2: 旧 config 迁移（一次性） ============
# v1 用 sed 把明文 key 替换进了 config.yaml，会持久化到 volume。
# 检测到旧痕迹（不含 ${OPENAI_API_KEY} 字面量）就用 seed 里的模板覆盖。
if [ -f "$CFG" ] && ! grep -q '\${OPENAI_API_KEY}' "$CFG"; then
  echo "[entrypoint] legacy config detected (plaintext key) — restoring template from seed"
  cp -f "$SEED_CFG" "$CFG"
fi

# ============ Step 3: 旧 Hermes 源码 / shim 迁移（一次性） ============
# v1 把 Hermes 装在 ~/.hermes/hermes-agent/ + ~/.local/bin/hermes 这两个位置（都在 volume 里）。
# v2 把 Hermes 移到了 /opt/hermes-agent（镜像只读层），但老 volume 里的旧 shim 仍在 PATH 上
# 抢先匹配，会导致老用户启动后仍跑老代码 —— 与"镜像升级即用户升级"的目标背道而驰。
# 清理掉这两个老路径即可让 hermes 命令解析到 /usr/local/bin/hermes（指向 /opt 里的新版本）。
if [ -d "$HOME_DIR/.hermes/hermes-agent" ]; then
  echo "[entrypoint] legacy Hermes source detected in volume — removing (now lives in /opt/hermes-agent)"
  rm -rf "$HOME_DIR/.hermes/hermes-agent"
fi
if [ -e "$HOME_DIR/.local/bin/hermes" ]; then
  echo "[entrypoint] legacy hermes shim detected in ~/.local/bin — removing"
  rm -f "$HOME_DIR/.local/bin/hermes"
fi

# ============ Step 4: 健全性检查 ============
if [ -z "$OPENAI_API_KEY" ]; then
  echo "[entrypoint] WARN: OPENAI_API_KEY not set — Hermes will fail on first LLM call" >&2
fi

exec "$@"
