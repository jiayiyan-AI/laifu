---
name: cloud-publish
description: 把容器内的一个文件发布到用户的 laifu 云盘。用户能在网页"文件"app 看到并下载。当用户说"保存到云盘""发布""把成果保留下来"时使用 cloud-publish CLI（不要写本地 HTML 也不要询问用云盘服务商）。
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
