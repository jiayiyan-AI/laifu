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
#   PATH                       → 把上面两个 bin 目录 + /opt/hermes-agent/.venv/bin 加入查找路径

FROM python:3.12-slim

# ============ 系统依赖 ============
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates build-essential \
    nodejs npm ripgrep sudo \
    && rm -rf /var/lib/apt/lists/*

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
RUN export UV_PYTHON_INSTALL_DIR=/usr/local/share/uv/python \
    && export UV_PYTHON_BIN_DIR=/usr/local/bin \
    && export UV_NO_CONFIG=1 \
    && curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh \
    | bash -s -- --dir /opt/hermes-agent --hermes-home /tmp/install-home \
    && ln -sf /opt/hermes-agent/venv/bin/hermes /usr/local/bin/hermes \
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
ENV PATH="/home/hermes/.local/bin:/home/hermes/.npm-global/bin:/opt/hermes-agent/venv/bin:$PATH"

# ============ 覆盖默认 config.yaml，接 DashScope ============
# config.yaml 里 api_key 字段写 ${OPENAI_API_KEY}，Hermes 启动时自动从环境变量插值。
# entrypoint 不再做 sed 注入，key 永远不会写入 volume。
COPY --chown=hermes:hermes hermes-config.yaml /home/hermes/.hermes/config.yaml

# ============ Seed 目录 ============
# 构建时 home 里只有 .hermes/ 骨架，seed 体积很小（< 10MB）
USER root
RUN cp -a /home/hermes /home/hermes-seed \
    && chown -R hermes:hermes /home/hermes-seed

# ============ entrypoint + HTTP 服务 ============
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

COPY --chown=hermes:hermes server.py /app/server.py

USER hermes

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
CMD ["python", "/app/server.py"]
