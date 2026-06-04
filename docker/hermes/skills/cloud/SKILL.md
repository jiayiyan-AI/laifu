---
name: cloud-publish
description: 管理用户的 laifu 云盘。cloud-publish 把容器内文件发布到云盘（用户在网页"文件"app 可见）；cloud-download 列出并下载用户在网页端上传到云盘的文件。当用户说"保存到云盘/发布"用 cloud-publish；当用户说"用我上传的文件/云盘里的 X 文件/我传了个文件给你"用 cloud-download 先 --list 再按 virtual-path 下载。
version: 0.1.0
platforms: [linux]
metadata:
  hermes:
    tags: [cloud, file, publish, storage, laifu]
---

# cloud-publish

把容器内的一个文件发布到用户的云盘。文件发布后，用户在网页端的"文件" app 可以看到并下载。

## 何时使用

- 用户要求把"成果""产出""报告""图片"等保留下来到云端时使用
- 不是"保存到本地"，而是"发布到云端" — 文件会被上传到用户的私有云盘
- 适合最终产物 (PDF / 图片 / 报告等)，不适合临时草稿

## 用法

```bash
cloud-publish --file <local-path> --virtual-path <cloud-path>
```

例：
```bash
cloud-publish --file /home/hermes/output/report.pdf --virtual-path reports/2026-06/sales.pdf --title "Q2 销售报告"
```

## 参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `--file PATH` | ✓ | 本地文件路径 (绝对或相对 cwd) |
| `--virtual-path PATH` | ✓ | 云盘上的虚拟路径，决定 web 端文件夹结构 |
| `--title TEXT` | | 标题，默认是 virtual-path 的 basename。中文 OK |
| `--description TEXT` | | 简短描述，中文 OK |
| `--tags A,B,C` | | 逗号分隔的 tags |
| `--session-id TEXT` | | 关联的 hermes session id |
| `--content-type MIME` | | 默认从文件扩展名自动推断 |

## 约束

- 单文件 ≤ 10MB (MVP)
- 同 virtual-path 再次发布会覆盖
- virtual-path 路径规则：不含 `..` / 不以 `/` 开头 / 不以 `/` 结尾 / 段长 ≤ 200 / 总长 ≤ 1024

## 输出

stdout 一行 JSON。成功：
```json
{"ok": true, "blob_name": "<user-id>/<virtual-path>", "url": "..."}
```

失败：
```json
{"ok": false, "error": "<message>"}
```

退出码：0=成功，1=参数错误，2=鉴权失败，3=网络/上传失败，4=其他。

---

# cloud-download

列出并下载用户在网页端上传到云盘的文件，供 agent 在容器内使用。

## 何时使用

- 用户说"用我刚上传的文件""云盘里的 data.csv""我传了个文件给你处理"等
- 典型流程：先 `--list` 看有哪些文件，再用 `--virtual-path` 下载到本地处理

## 用法

```bash
# 列出云盘所有文件（扁平递归），可选 --prefix 收窄
cloud-download --list
cloud-download --list --prefix datasets/

# 下载单个文件到本地
cloud-download --virtual-path datasets/sales.csv --output /home/hermes/work/sales.csv
```

## 参数

| 参数 | 说明 |
|---|---|
| `--list` | 列出文件，输出 `{"ok":true,"files":[{virtual_path,size,last_modified,content_type,source,title}]}` |
| `--prefix PFX` | 配合 `--list`，只列该虚拟前缀下的文件，如 `reports/` |
| `--virtual-path PATH` | 要下载的云盘路径 |
| `--output FILE` | 本地保存路径（与 `--virtual-path` 配合，必填） |

`source` 字段：`web`=用户网页上传，`agent`=agent 之前发布。

## 输出与退出码

stdout 一行 JSON。退出码：0=成功，1=参数错误，2=鉴权失败，3=网络/下载失败（含文件不存在），4=其他。
