# Agent 云盘 CLI 统一为 `cloud-file` 设计

**日期**: 2026-06-05
**分支**: feat/cloud-drive-upload(在 PR #6 基础上重塑)
**状态**: Draft, pending user review
**关联**: 重塑 [2026-06-04-cloud-drive-upload-design.md](./2026-06-04-cloud-drive-upload-design.md) 的 agent CLI 部分

## 一、概要

把 agent 侧散落的两个云盘命令(`cloud-publish` 发布、`cloud-download` 列出/下载)**收敛成一个统一工具 `cloud-file <子命令>`**,后续删除/移动/复制都往里加,而不是一个个单独写命令。

本期范围:`cloud-file ls / get / put`(读 / 列 / 写),**复用现有 `racwl` 目录 SAS,不动 gateway 与 web**。`rm / mv / cp` 推迟(需先定删除权限方案)。

### 已定决策(来自 brainstorm)

| 维度 | 决定 |
|---|---|
| 迁移方式 | **硬替换** —— 删掉 `cloud-publish` / `cloud-download` 命令,SKILL.md + 所有引用改用 `cloud-file`;不留别名 |
| 本期子命令 | **`ls` / `get` / `put`**(复用 racwl SAS,无需 gateway 改动) |
| 与 PR #6 关系 | **把 #6 重塑成 cloud-file** —— 反向功能直接以统一工具形态出,不再单独留 `cloud-download` |
| `rm` / `mv` / `cp` | 推迟到后续;先定删除权限方案(扩 SAS 到 `racwld` vs gateway 中介端点) |

### 不在本期

- `rm` / `mv` / `cp`(删除/移动/复制)
- web 端删除/重命名/移动 UI
- gateway 任何改动(upload 端点、list source 透传等 PR #6 已有部分**保持不变**)
- 软删除 / 回收站

---

## 二、命令形态

单一可执行 `cloud-file`,argparse subparsers:

```bash
# 列出(扁平递归)。可选 prefix 收窄
cloud-file ls
cloud-file ls reports/

# 下载到本地。-o 缺省 = 取 virtual-path 的 basename 放当前目录
cloud-file get reports/q2.pdf -o /home/hermes/work/q2.pdf
cloud-file get reports/q2.pdf            # → ./q2.pdf

# 上传/发布本地文件到云盘
cloud-file put /home/hermes/out/report.pdf reports/2026-06/sales.pdf --title "Q2 销售"
```

### 子命令 ↔ 现有逻辑映射

| 新命令 | 等价于现在 | 复用模块 |
|---|---|---|
| `cloud-file ls [PREFIX]` | `cloud-download --list [--prefix]` | `downloader.list_files` |
| `cloud-file get <vpath> [-o OUT]` | `cloud-download --virtual-path --output` | `downloader.download_file` |
| `cloud-file put <local> <vpath> [opts]` | `cloud-publish --file --virtual-path [opts]` | `uploader.upload_blob` + `metadata.build_metadata`(`source=agent`) |

`put` 选项沿用现有:`--title / --description / --tags / --session-id / --content-type`。

### 输出与退出码(全子命令统一,沿用现状)

stdout 一行 JSON:
- `ls`:`{"ok": true, "files": [{virtual_path,size,last_modified,content_type,source,title}]}`
- `get`:`{"ok": true, "virtual_path": "...", "output": "...", "size": N}`
- `put`:`{"ok": true, "blob_name": "<user_id>/<vpath>", "url": "..."}`
- 失败:`{"ok": false, "error": "<message>"}`

退出码:`0` 成功 / `1` 参数错误 / `2` 鉴权失败 / `3` 网络或下载/上传失败 / `4` 其他。

---

## 三、包结构重构

把 Python 包 `cloud_publish/` → **`cloud_file/`**(dist 名 `cloud-file`),逻辑模块原样搬,**新增一个 `cli.py` 分发器**,删掉两个旧入口。

### 改动后的目录(`docker/hermes/skills/cloud/`)

```
cloud_file/
  __init__.py
  cli.py          ← 新增:argparse subparsers(ls/get/put)→ main();各 cmd 调下面的模块
  uploader.py     ← 原样(put 用)
  downloader.py   ← 原样(ls/get 用)
  metadata.py     ← 原样(put 用,source=agent)
  sas_cache.py    ← 原样
  paths.py        ← 原样(validate_virtual_path,所有写路径的子命令都校验)
setup.py          ← name='cloud-file';console_scripts 只剩 cloud-file=cloud_file.cli:main
SKILL.md          ← 重写为 cloud-file
tests/            ← 见 §六
```

**删除**:`cloud_publish/__main__.py`(publish 入口,逻辑挪进 `cli.py` 的 `cmd_put`)、`cloud_publish/download_cli.py`(逻辑挪进 `cli.py` 的 `cmd_ls`/`cmd_get`)、旧的 `cloud-publish` / `cloud-download` console scripts。

`cli.py` 的三个 cmd 只是"解析参数 → 读 env → 取 SAS(`sas_cache`)→ 调对应模块 → `_emit` JSON",env 处理 / `_fail` / 退出码逻辑复用现有 `download_cli.py` / `__main__.py` 里那套(搬过来即可,不重写)。

### setup.py

```python
setup(
    name='cloud-file',
    ...
    entry_points={'console_scripts': ['cloud-file=cloud_file.cli:main']},
)
```

---

## 四、SKILL.md 重写

frontmatter `name` 改为 `cloud-file`(**技能目录名 `cloud` 不变**——entitlement feature key 与 entrypoint 软链都按 `cloud` 目录走,不能动)。`description` 覆盖三件事并给 agent 路由提示:

- "保存到云盘 / 发布成果" → `cloud-file put`
- "用我上传的文件 / 云盘里的 X" → 先 `cloud-file ls` 再 `cloud-file get`

正文给出 `ls/get/put` 的用法、参数表、`source` 字段含义、输出与退出码。

---

## 五、Dockerfile / 镜像(必须重建)

`/opt/hermes-skills/cloud` 是 **build 时 `COPY` 进镜像 + `pip install` 到 `/opt/hermes-agent/venv`** 的,**不是挂载**(dev 用 `docker run --rm`,只挂 `~/.hermes-dev:/home/hermes`)。所以:

- **改完源码必须 `docker build -t hermes-probe docker/hermes/` 重建镜像**,容器才有 `cloud-file`(光重启没用——这也正是之前 `cloud-download not found` 的原因)。
- Dockerfile 改动:把安装 cloud skill 的 `pip install` 块对应到新包(路径仍是 `/opt/hermes-skills/cloud`,但产出的命令从 `cloud-publish` 变 `cloud-file`);删除任何针对 `cloud-publish` 的 bin 符号链 / 引用。
- 全仓 grep `cloud-publish` / `cloud_publish` / `cloud-download`,逐处改到 `cloud-file` / `cloud_file`(SKILL.md、Dockerfile、server.py、任何提示词/文档/脚本)。

> **可选(本期不做)开发体验改进**:给 dev 单独 bind-mount 这个 skill 源 + `pip install -e`,让改 CLI 不必每次重建镜像。需绕开 Dockerfile 注释提到的"/home 卷覆盖 pip 安装"坑(只挂 skill 源、装到 /opt 即可)。

---

## 六、测试

逻辑模块没变,所以:

- **保留**(仅把 import `cloud_publish.X` → `cloud_file.X`):`test_metadata.py`、`test_paths.py`、`test_uploader.py`、`test_downloader.py`。
- **替换**:`test_main.py`(测旧 publish 入口)+ `test_download_cli.py`(测旧 download 入口)→ 合并成 **`test_cli.py`**,测 `cloud_file.cli` 的三个子命令:
  - `put`:正常发布(metadata `source=agent`、blob_name 前缀 user_id)、文件不存在 exit 1、路径注入 exit 1、缺鉴权 exit 2。
  - `ls`:输出 files JSON、prefix 自动补尾斜杠、list 错误 exit 3、AuthError exit 2。
  - `get`:下载写文件 + 返回 size、缺 `-o` 用 basename 默认、blob 不存在 exit 3、路径注入 exit 1。
- 三端回归:`python -m pytest -q` 全过(注意环境已装 `azure-storage-blob`)。

---

## 七、PR #6 的重塑

PR #6 现状 = "gateway upload 端点 + web 上传 UI + 下载交互改版 + agent `cloud-download`"。重塑后:

- **保持不变**:gateway `POST /api/cloud/upload`、`/list` 透传 source、web 上传/下载交互/Preview 等(都跟 agent CLID 名字无关)。
- **改**:agent 部分从"新增 cloud-download" 变成"**统一为 cloud-file**(含把已合并的 cloud-publish 一并迁移)" + Dockerfile + SKILL.md + 全仓引用替换。
- PR 标题/描述相应扩展为:"web 上传 → agent 下载 + agent 云盘 CLI 统一为 cloud-file"。

> 注意:`cloud-publish` 是 **已合并到 main(PR #3)** 的正向功能命令。硬替换意味着合并后,正向"保存到云盘"也改走 `cloud-file put`——SKILL.md 是 agent 的事实来源,只要它更新到位即可;但**全仓任何硬编码 `cloud-publish` 的地方(server.py / 提示词 / 文档)必须同步改**,否则正向功能会断。这是本设计的主要风险点,§五的全仓 grep 是强制项。

---

## 八、实施阶段(预告,详见后续 plan)

1. 包重命名 `cloud_publish` → `cloud_file` + 搬模块 + 改所有 import/测试 import(纯机械,回归绿)。
2. 新增 `cli.py`(ls/get/put 分发,逻辑从旧两入口搬入)+ setup.py 改 `cloud-file` + 删旧入口/console scripts。
3. `test_cli.py`(合并替换旧两个入口测试)。
4. SKILL.md 重写 + 全仓 grep 替换 `cloud-publish`/`cloud-download` 引用(含 Dockerfile、server.py 等)。
5. Dockerfile 安装块改到 cloud-file。
6. 本地 `docker build` 重建镜像 + 容器内 `which cloud-file` + `cloud-file ls` 冒烟。
