# Hermes 容器化 — 关键设计说明
#
# ## 镜像设计思路（v2：源码移出 home）
# 之前版本把 Hermes 装在 ~/.hermes/hermes-agent，整个 home 会被 volume 挂载覆盖，
# 导致老用户的 volume 里锁死老版本源码，镜像升级时不会跟随更新。
#
# v2 改为：以 root 身份装到 /opt/hermes-agent（镜像只读层），
# 用户 home 只保留真正的"用户数据"（config.yaml、memories、sessions、pip/npm 包等）。
# 镜像升级时所有用户自动跑新版本代码，volume 里的用户数据保持不变。
#
# ## Seed 目录
# Volume 挂上 /home/hermes 后会遮盖镜像里的初始用户数据，所以构建时把
# 必要的 .hermes/ 骨架（config.yaml + 空的 memories/sessions 等子目录）
# 备份到 /home/hermes-seed，entrypoint 首次启动时复制过去。
# 因为代码不在 home，seed 体积从 ~2GB 缩到 < 10MB。
#
# ## 环境变量
#   HERMES_HOME                → 显式锁定 Hermes 数据目录为 /home/hermes/.hermes
#   PIP_USER / PYTHONUSERBASE  → pip install 装到 /home/hermes/.local（落在 volume）
#   NPM_CONFIG_PREFIX          → npm install -g 装到 /home/hermes/.npm-global（落在 volume）
#   PNPM_HOME                  → pnpm 的 store + 全局包目录, 锁到 /home/hermes/.local/share/pnpm（落在 volume）
#   PATH                       → 把上面三个 bin 目录 + /opt/hermes-agent/.venv/bin 加入查找路径

# ============ Bun 二进制源 (多阶段, 仅取 binary) ============
# oven/bun 是 Bun 官方维护的 Docker image, ARG 锁定 tag 保证可复现。
# `:1.3.14-slim` 同时支持 linux/amd64 + linux/arm64, BuildKit 按宿主 arch 自动选,
# 不再需要手写 dpkg/case 映射, 也不需要 unzip 解 release zip。
# 整个上游镜像约 ~120MB, 但我们只 COPY /usr/local/bin/bun 一个二进制到最终镜像,
# 实际增量 ~95MB (跟手动 release zip 解出来等价)。
ARG BUN_VERSION=1.3.14
FROM oven/bun:${BUN_VERSION}-slim AS bun-source

# ============ 最终镜像 ============
FROM python:3.12-slim

# ============ 系统依赖 ============
# 替换 apt mirror 到阿里云,绕开国内访问 deb.debian.org 的网络问题
# (兼容 Debian 12+ 的 deb822 sources 和老格式 /etc/apt/sources.list)
RUN (sed -i 's|http://deb.debian.org|http://mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null \
     || sed -i 's|http://deb.debian.org|http://mirrors.aliyun.com|g' /etc/apt/sources.list 2>/dev/null \
     || true) \
 && apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates build-essential \
    ripgrep sudo jq \
    && rm -rf /var/lib/apt/lists/*

# ============ Node.js 24 LTS + pnpm ============
# Debian 12 仓库的 nodejs 卡在 18.x (已 EOL 2025-04),走 NodeSource 装 24.x LTS。
# pnpm 走 npm -g 装到 /usr/bin (NodeSource 的 npm prefix 是 /usr),所有用户共享;
# 锁定到 npm 仓库的 latest tag,build 时拉到 pnpm 最新稳定版。
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@latest \
    && npm cache clean --force

# ============ Bun (TypeScript runtime for our HTTP server + bootstrap scripts) ============
# 装到 /usr/local/bin/bun, 世界可读, hermes 用户能直接调。
# 选 Bun 而非继续 Node 的理由 (vs Phase 1):
#   - 原生 .ts (零 build, 跟 Phase 1 的"无 build 步骤"硬约束一致)
#   - 原生 YAML (干掉 yaml@2 npm 依赖, 见下面 /opt/lingxi-scripts 段落)
#   - 原生 bun:sqlite (跟 node:sqlite 一样零 native module, 容器 build 不依赖 build-essential)
# Node 不能下: 用户的 AI agent 仍要靠 pnpm 装 npm CLI 工具 (Bug A 触发那条 `pnpm add -g`),
# 所以 Bun 是 *加法*, 不是替换。镜像净增 ~95MB, 相对 ~2GB 镜像可忽略。
#
# 多阶段 COPY 替代手动 release 下载: oven/bun 镜像就是 Bun 官方发版渠道之一,
# tag 锁定时单次拉取, 跨 arch 自动选, 上面 FROM 那段定义了 builder stage。
COPY --from=bun-source /usr/local/bin/bun /usr/local/bin/bun
RUN bun --version

# ============ 创建非 root 用户 ============
RUN useradd -m -s /bin/bash hermes \
    && echo "hermes ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# ============ 安装 Hermes 到 /opt（镜像只读层） ============
# install.sh 在 root 身份下默认走 FHS（/usr/local/lib/hermes-agent + /usr/local/bin/hermes），
# 但我们显式 --dir 锁定位置，避免脚本自行决策。
# --hermes-home 临时指到 /tmp，避免装过程产物落到将来要被 volume 覆盖的 /home/hermes。
#
# 关键：install.sh 用 uv 拉独立 Python，默认装到 /root/.local/share/uv（700 权限），
# hermes 用户无法 traverse。手动 export UV_PYTHON_INSTALL_DIR 到世界可读路径，
# 这样 venv 里的 python3 软链才能被 hermes 用户跟随。
#
# 顺手装 Anthropic SDK (hermes 默认带 OpenAI/DashScope, Anthropic provider 需另装)。
# 必须跟 install.sh 同一 RUN —— 拆出去再 chmod -R a+rX 会触发 OverlayFS copy-up,
# 把整个 /opt/hermes-agent (~1.5GB) 在新层复制一份, 镜像凭空多 ~500MB 压缩体积。
# uv 创建的 venv 不自带 pip, 先 ensurepip 再 pip install。
#
# ★ HERMES_REF 双 pin: 同时锁 install.sh 脚本本身 (raw URL 用 SHA) +
#   install.sh 内部 git clone 的 hermes-agent 仓库 (--commit 参数)。
#   两边同一个 SHA → 脚本逻辑跟它装的代码完全自洽, 重复 build 完全可复现。
#   不 pin 时拉 main, 镜像体积 / behavior 会跟着上游每次 commit 漂移
#   (实例: 6-09 #42998 fix(install) self-heal Electron download → 镜像 -740MB)。
#
# 升级流程:
#   1. 看 NousResearch/hermes-agent 是否有新 release tag (semver-friendly):
#        curl -s 'https://api.github.com/repos/NousResearch/hermes-agent/releases?per_page=1' | jq -r '.[0].tag_name'
#      或抓 main HEAD (没 release 时):
#        curl -s 'https://api.github.com/repos/NousResearch/hermes-agent/commits/main' | jq -r '.sha'
#   2. 改下面 ARG, 重 build, 跑 docker/hermes/server smoke test
#   3. 镜像体积变化对照 docker history 看是不是上游 install.sh 漂移
#
# 当前 pin: 2026-06-15 main HEAD, 我们本次 5 项验证矩阵 (sync/async/pgkill/multimodal/health) 全过。
ARG HERMES_REF=95715dcb03003eab086eb0494083e6dc1c65f3b3
RUN export UV_PYTHON_INSTALL_DIR=/usr/local/share/uv/python \
    && export UV_PYTHON_BIN_DIR=/usr/local/bin \
    && export UV_NO_CONFIG=1 \
    && curl -fsSL "https://raw.githubusercontent.com/NousResearch/hermes-agent/${HERMES_REF}/scripts/install.sh" \
    | bash -s -- --dir /opt/hermes-agent --hermes-home /tmp/install-home --commit "${HERMES_REF}" \
    && ln -sf /opt/hermes-agent/venv/bin/hermes /usr/local/bin/hermes \
    && /opt/hermes-agent/venv/bin/python -m ensurepip --upgrade \
    && /opt/hermes-agent/venv/bin/python -m pip install --no-cache-dir 'anthropic>=0.39.0' \
    && chmod -R a+rX /opt/hermes-agent /usr/local/share/uv

# ============ 准备 hermes 用户的初始 home 骨架 ============
# install.sh 在 /tmp/install-home 下创建了完整 .hermes/{cron,sessions,logs,memories,...}
# 把这份骨架（不含 hermes-agent 源码）拷给 hermes 用户作为初始 home
RUN mkdir -p /home/hermes/.hermes \
    && cp -a /tmp/install-home/. /home/hermes/.hermes/ \
    && rm -rf /tmp/install-home \
    && chown -R hermes:hermes /home/hermes

USER hermes
WORKDIR /home/hermes

# ============ 关键环境变量 ============
ENV HERMES_HOME=/home/hermes/.hermes
ENV PIP_USER=1
ENV PYTHONUSERBASE=/home/hermes/.local
ENV NPM_CONFIG_PREFIX=/home/hermes/.npm-global
# pnpm 默认 storeDir/globalDir 走 XDG ($HOME/.local/share/pnpm/...), 也落在 volume,
# 显式设 PNPM_HOME 避免依赖 HOME/XDG_DATA_HOME 推导链;
# pnpm v11+ 把全局 cli 的 bin 放 $PNPM_HOME/bin (子目录),需要进 PATH 才能在 shell 里直接调用。
ENV PNPM_HOME=/home/hermes/.local/share/pnpm
ENV PATH="/home/hermes/.local/bin:/home/hermes/.npm-global/bin:/home/hermes/.local/share/pnpm/bin:/opt/hermes-agent/venv/bin:$PATH"

# ============ config.yaml 由 entrypoint 每次启动按 env 渲染 ============
# 不再 COPY 静态文件,改 provider/model 只需改 env, 无需重 build 镜像。
# 详见 entrypoint.sh Step 2。

# ============ login shell PATH 修复 ============
# Dockerfile 的 ENV 只覆盖容器主进程 + 非 login shell。AI agent 经 hermes 调用
# 外部命令时走 `bash -l`,Debian 的 /etc/profile 会把 PATH 强制重置成
# `/usr/local/bin:/usr/bin:/bin:...`,抹掉我们上面 ENV PATH 里加的三个 bin
# (~/.local/bin / ~/.npm-global/bin / $PNPM_HOME/bin),pnpm/npm/pip 全局
# install 因而看不到 global-bin-dir, 报 ERR_PNPM_NO_GLOBAL_BIN_DIR 等错。
# 解法:再下一份 /etc/profile.d/lingxi.sh,login shell 走 /etc/profile 时
# 自动 source, 跟 ENV 双保险, 保证两类 shell 看到的 env 完全一致。
USER root
RUN cat > /etc/profile.d/lingxi.sh <<'EOF'
# 跟 Dockerfile ENV 同源, 给 login shell (bash -l) 重 assert
export HERMES_HOME=/home/hermes/.hermes
export PIP_USER=1
export PYTHONUSERBASE=/home/hermes/.local
export NPM_CONFIG_PREFIX=/home/hermes/.npm-global
export PNPM_HOME=/home/hermes/.local/share/pnpm
case ":$PATH:" in
  *":$PNPM_HOME/bin:"*) ;;
  *) export PATH="/home/hermes/.local/bin:/home/hermes/.npm-global/bin:$PNPM_HOME/bin:/opt/hermes-agent/venv/bin:$PATH" ;;
esac
EOF
RUN chmod 0644 /etc/profile.d/lingxi.sh

# ============ Seed 目录 ============
# 构建时 home 里只有 .hermes/ 骨架,seed 体积很小(< 10MB)
RUN cp -a /home/hermes /home/hermes-seed \
    && chown -R hermes:hermes /home/hermes-seed

# ============ entrypoint + HTTP 服务 + bootstrap scripts ============
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

COPY --chown=hermes:hermes server/ /app/server/

# Bootstrap Bun (TypeScript) 脚本 (放只读层, volume 覆盖不到)。
# Bun 原生支持 TS + YAML, 不再需要 npm install yaml@2 三方包,
# /opt/lingxi-scripts 退化成"一堆 .ts 文件"目录, 不需要 package.json / node_modules。
USER root
RUN mkdir -p /opt/lingxi-scripts
COPY scripts/ /opt/lingxi-scripts/
RUN chmod -R a+rX /opt/lingxi-scripts
# 不切回 hermes — 后续 mkdir /opt/hermes-skills + pip install -e 都需要 root,
# 最末尾 line ~130 才统一切回 hermes。

# ============ Hermes skills 占位目录 ============
# P1 阶段为 cloud_file 留一个能软链的目标 (SKILL.md 占位)。
# P3 会替换 SKILL.md + 加 cloud_file CLI 实现。
RUN mkdir -p /opt/hermes-skills && chown hermes:hermes /opt/hermes-skills
COPY --chown=hermes:hermes skills/ /opt/hermes-skills/

# 装 cloud-file Hermes skill 的 Python CLI
# ⚠️ 不能装到 /home/hermes/.local/ — 那里 dev 模式被 -v host volume 整盘 mount 覆盖。
# 装到 hermes-agent venv (/opt/hermes-agent/venv/),在 /opt 下不会被 volume 影响,
# 然后软链到 /usr/local/bin/ 让任何 PATH 配置都能找到。
# 走清华 pypi mirror 避免国内访问 pypi.org 慢/超时。
# unset PIP_USER (line 77 env 设了 PIP_USER=1, 但 user 模式装到 /home/hermes/.local/
# 会被 dev volume 覆盖)。这里强制装到系统 /usr/local 路径,在 /opt 同样不会被
# volume mount mask。
RUN unset PIP_USER PYTHONUSERBASE && pip install --no-cache-dir \
    -i https://pypi.tuna.tsinghua.edu.cn/simple \
    --trusted-host pypi.tuna.tsinghua.edu.cn \
    -e /opt/hermes-skills/cloud/ \
    -e /opt/hermes-skills/email/

USER hermes

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
CMD ["bun", "/app/server/index.ts"]
