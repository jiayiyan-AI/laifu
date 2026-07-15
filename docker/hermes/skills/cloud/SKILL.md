---
name: cloud
description: 管理用户的 laifu 云盘（列出/下载/上传）。用户本机自动同步的文件位于 sync/：用户说“同步盘里的文件”时在 sync/ 查找；要让交付物自动出现在用户电脑时上传到 sync/。其他路径仍可正常读写，仅不自动同步。
version: 0.1.0
platforms: [linux]
metadata:
  hermes:
    tags: [cloud, file, storage, laifu]
---

# cloud-file

当前 skill 安装后已经自动注册了 `cloud-file` 命令行工具,可在 shell 中直接使用。有三个子命令:`ls`(列出)、`get`(下载)、`put`(上传/发布)。

## 何时使用

- "把成果/报告/图片保存到云盘""发布到云端" → `cloud-file put`
- "用我刚上传的文件""云盘里的 data.csv""我传了个文件给你处理" → 先 `cloud-file ls`,再 `cloud-file get`

## `sync/` 自动同步约定（重要）

云盘是 Agent 的完整工作区，`sync/` 只是其中一个有特殊产品语义的子目录，**不是权限边界**：你仍可读取和写入任意合法虚拟路径。

- 用户在桌面同步盘本地新增或修改的文件，会自动上行到 `sync/`。当用户说“我放在同步盘/电脑同步目录里的文件”时，先用 `cloud-file ls sync/` 查找，再以 `sync/...` 路径 `get`。
- 要让用户在电脑本地同步目录自动看到交付物，必须 `put` 到 `sync/...`。上传成功后才能说“已同步到你的电脑”。
- 需要交付给用户查看的文件，应该写入 `sync/` 目录中，否则用户将难以查看到。
- `reports/`、`internal/` 或根目录等其他路径可用于云端保留的数据、工作中间产物和未来业务数据；它们不会自动下载到用户设备，不能声称已同步到本地。

```bash
# 用户说“我放到同步盘里的 input.xlsx”
cloud-file ls sync/
cloud-file get sync/input.xlsx -o /home/hermes/work/input.xlsx

# 让用户在电脑同步目录自动收到交付物
cloud-file put /home/hermes/output/report.pdf sync/report.pdf --title "分析报告"

# 仅供云端业务使用；允许读写，但不会自动同步到 desktop
cloud-file put /tmp/intermediate.json internal/job-123/intermediate.json
```

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

## 失败了怎么办(必读)

任何子命令返回 `{"ok":false,...}` 或退出码非 0,都表示这次云盘操作**没成功**。此时:

- **如实回报**:把 `error` 的内容直接告诉用户,例如"云盘操作失败:<error>"。
- **就此打住**:不要重试同一命令、不要换参数反复试、不要为此去问无关的澄清(clarify)、**绝不能谎称"已上传/已完成"**。
- 按退出码给用户一句可操作提示:2=鉴权失败(token 问题,通常需重新登录或联系管理员);1=参数错误(检查虚拟路径/本地文件);3=网络/上传下载失败(含文件不存在)。
