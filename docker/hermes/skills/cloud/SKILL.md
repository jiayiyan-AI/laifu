---
name: cloud-file
description: 管理用户的 laifu 云盘(列出/下载/上传)。当用户说"保存到云盘/发布成果"→ cloud-file put;当用户说"用我上传的文件/云盘里的 X 文件"→ 先 cloud-file ls 看有哪些,再 cloud-file get 下载。
version: 0.1.0
platforms: [linux]
metadata:
  hermes:
    tags: [cloud, file, storage, laifu]
---

# cloud-file

一个统一的云盘文件工具,三个子命令:`ls`(列出)、`get`(下载)、`put`(上传/发布)。

## 何时使用

- "把成果/报告/图片保存到云盘""发布到云端" → `cloud-file put`
- "用我刚上传的文件""云盘里的 data.csv""我传了个文件给你处理" → 先 `cloud-file ls`,再 `cloud-file get`

## 用法

```bash
# 列出云盘文件(扁平递归),可选前缀收窄
cloud-file ls
cloud-file ls reports/

# 下载到本地(-o 缺省 = 取 basename 放当前目录)
cloud-file get reports/q2.pdf -o /home/hermes/work/q2.pdf
cloud-file get reports/q2.pdf

# 上传/发布本地文件到云盘
cloud-file put /home/hermes/output/report.pdf reports/2026-06/sales.pdf --title "Q2 销售报告"
```

## 参数

| 子命令 | 形式 | 说明 |
|---|---|---|
| `ls` | `cloud-file ls [PREFIX]` | 列出文件,输出 `{"ok":true,"files":[{virtual_path,size,last_modified,content_type,source,title}]}` |
| `get` | `cloud-file get <虚拟路径> [-o 本地路径]` | 下载;`-o` 缺省取虚拟路径 basename |
| `put` | `cloud-file put <本地文件> <虚拟路径> [--title ...] [--description ...] [--tags a,b] [--session-id ...] [--content-type ...]` | 上传/发布;≤10MB;同虚拟路径覆盖;--title 缺省取虚拟路径 basename |

`source` 字段:`web`=用户网页上传,`agent`=agent(`put`)发布。

## 约束

- 单文件 ≤ 10MB(put)
- 虚拟路径规则:不含 `..` / 不以 `/` 开头或结尾 / 段长 ≤ 200 / 总长 ≤ 1024

## 输出与退出码

stdout 一行 JSON。成功时:
- `ls`:`{"ok":true,"files":[{virtual_path,size,last_modified,content_type,source,title}]}`
- `get`:`{"ok":true,"virtual_path":"...","output":"<本地路径>","size":<字节数>}`
- `put`:`{"ok":true,"blob_name":"<user_id>/<虚拟路径>","url":"..."}`

失败时:`{"ok":false,"error":"<message>"}`

退出码:0=成功,1=参数错误,2=鉴权失败,3=网络/下载/上传失败(含文件不存在),4=其他。
