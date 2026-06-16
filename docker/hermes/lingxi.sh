# /etc/profile.d/lingxi.sh
# 跟 Dockerfile ENV 同源, 给 login shell (bash -l) 重 assert。
# Debian 的 /etc/profile 会把 PATH 强制重置成 `/usr/local/bin:/usr/bin:/bin:...`,
# 抹掉镜像 ENV PATH 里加的 ~/.local/bin / ~/.npm-global/bin / $PNPM_HOME/bin,
# 走 /etc/profile.d/*.sh 这条尾巴再补回来, 保证 login / non-login shell env 一致。
export HERMES_HOME=/home/hermes/.hermes
export PIP_USER=1
export PYTHONUSERBASE=/home/hermes/.local
export NPM_CONFIG_PREFIX=/home/hermes/.npm-global
export PNPM_HOME=/home/hermes/.local/share/pnpm
case ":$PATH:" in
  *":$PNPM_HOME/bin:"*) ;;
  *) export PATH="/home/hermes/.local/bin:/home/hermes/.npm-global/bin:$PNPM_HOME/bin:/opt/hermes-agent/venv/bin:$PATH" ;;
esac
