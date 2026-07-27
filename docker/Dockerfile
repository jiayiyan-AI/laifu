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

# ============ GitHub CLI (git/gh 凭证链路, docs/todo/github.md §三) ============
# 装 gh CLI (官方 apt repo), 真 gh 改名 gh.real 给 wrapper 调。刻意放系统包区 (与下方
# scripts/ server COPY 无关), 改脚本/改代码不触发重装 gh, 命中缓存。软链 + helper 配置
# 依赖 scripts/ 已 COPY, 留在下面那段。
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
         -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
         > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && mv /usr/bin/gh /usr/bin/gh.real \
 && rm -rf /var/lib/apt/lists/*

# ============ Bun (TypeScript runtime for our HTTP server + bootstrap scripts) ============
# 装到 /usr/local/bin/bun, 世界可读, hermes 用户能直接调。
# 选 Bun 而非继续 Node 的理由 (vs Phase 1):
#   - 原生 .ts (零 build, 跟 Phase 1 的"无 build 步骤"硬约束一致)
#   - 原生 YAML（干掉 yaml@2 npm 依赖，见下方 /app 源码树）
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
# ★ HERMES_REF 双 pin: 同时锁 install.sh 脚本本身 (api.github.com/contents?ref=SHA) +
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
#
# ★ 末尾 rm -rf /opt/hermes-agent/skills/email: 删掉 Hermes 自带的 email 技能类目
#   (仅含 himalaya, 已被双否决)。它会在首启时 materialize 成 ~/.hermes/skills/email 真目录,
#   与我们 email 能力的 entitlement 软链目标 (~/.hermes/skills/email) 撞名 →
#   sync-entitlements 软链抛 EEXIST → observed 漏报 email → 前端购买一直 timeout。
#   从源头删掉 builtin, 命名空间留给 entitlement 软链, 新用户天然无冲突。必须跟 install 同一
#   RUN (单独 RUN 删只会加 whiteout 层, 旧层文件仍占体积)。cloud 能力无同名 builtin, 不受影响。
ARG HERMES_REF=95715dcb03003eab086eb0494083e6dc1c65f3b3
RUN export UV_PYTHON_INSTALL_DIR=/usr/local/share/uv/python \
    && export UV_PYTHON_BIN_DIR=/usr/local/bin \
    && export UV_NO_CONFIG=1 \
    && curl -fsSL --retry 5 --retry-all-errors --retry-delay 15 "https://raw.githubusercontent.com/NousResearch/hermes-agent/${HERMES_REF}/scripts/install.sh" \
    | bash -s -- --dir /opt/hermes-agent --hermes-home /tmp/install-home --commit "${HERMES_REF}" \
    && ln -sf /opt/hermes-agent/venv/bin/hermes /usr/local/bin/hermes \
    && /opt/hermes-agent/venv/bin/python -m ensurepip --upgrade \
    && /opt/hermes-agent/venv/bin/python -m pip install --no-cache-dir 'anthropic>=0.39.0' \
    && rm -rf /opt/hermes-agent/skills/email \
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
# 解法:落一份 /etc/profile.d/lingxi.sh,login shell 走 /etc/profile 时
# 自动 source, 跟 ENV 双保险, 保证两类 shell 看到的 env 完全一致。
#
# 注: 历史用过 `RUN cat > ... <<EOF` heredoc, 但 ACR Build 不带
# `# syntax=docker/dockerfile:1.4+` directive 时 heredoc 不被识别,
# 产物是 0 字节空文件 (实测 hermes:latest 在 dev 上就是这个状态),
# login shell 拿不到 PATH 救援, pnpm/npm 全局 install 一律报 PATH 警告。
# /app 是容器内唯一的业务源码树；profile 脚本在源码复制后以 symlink 接入系统位置。

USER root
# ============ Seed 目录 ============
# 构建时 home 里只有 .hermes/ 骨架,seed 体积很小(< 10MB)
RUN cp -a /home/hermes /home/hermes-seed \
    && chown -R hermes:hermes /home/hermes-seed

# ============ Pi SDK runtime dependencies ============
# 依赖来自提交的 Bun lock；构建期安装，运行期不会访问 npm registry 或执行 lifecycle scripts。
COPY package.json bun.lock /opt/lingxi-pi/
WORKDIR /opt/lingxi-pi
RUN bun install --production --frozen-lockfile --ignore-scripts
WORKDIR /home/hermes

# ============ 应用源码（唯一副本）============
# 业务代码、启动脚本与 skills 全部位于 /app 的镜像只读层；不再向 /opt 复制第二份源码。
# .dockerignore 排除 host-only 文件与旧实现，避免它们进入生产镜像。
COPY --chown=hermes:hermes . /app/

# Pi SDK 与固定 Pi package 留在不可变 vendor tree；first-party 源码仍只保留在 /app。
RUN chmod -R a+rX /opt/lingxi-pi \
 && ln -s /opt/lingxi-pi/node_modules /app/node_modules

# 系统接入点仅链接回 /app，避免 wrapper / profile 与源码漂移。skills 保留旧路径别名，
# 使挂载在 NFS home 中的既有 ~/.hermes/skills/* 软链在镜像升级后仍可解析。
RUN ln -sf /app/lingxi.sh /etc/profile.d/lingxi.sh \
 && ln -sf /app/boot/scripts/git-credential.ts /usr/local/bin/lingxi-git-credential \
 && ln -sf /app/boot/scripts/gh-wrapper.ts /usr/local/bin/gh \
 && ln -s /app/skills /opt/hermes-skills \
 && git config --system credential.https://github.com.helper /usr/local/bin/lingxi-git-credential

# skills 从唯一的 /app 源码树以 editable 方式安装；安装位置仍在镜像层，不受 home volume 覆盖。
RUN unset PIP_USER PYTHONUSERBASE && pip install --no-cache-dir \
    -i https://pypi.tuna.tsinghua.edu.cn/simple \
    --trusted-host pypi.tuna.tsinghua.edu.cn \
    -e /app/skills/cloud/ \
    -e /app/skills/email/

# editable install 可能生成构建元数据；完成后再锁定应用树，防止运行时改写镜像源码。
RUN chmod -R a-w,a+rX /app \
 && chmod a+rx /app/boot/entrypoint.sh /app/boot/scripts/git-credential.ts /app/boot/scripts/gh-wrapper.ts

USER hermes

EXPOSE 8080

ENTRYPOINT ["/app/boot/entrypoint.sh"]
CMD ["bun", "/app/boot/server/index.ts"]
