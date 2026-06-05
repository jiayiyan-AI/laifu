# Agent 云盘 CLI 统一为 `cloud-file` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 agent 侧的 `cloud-publish` / `cloud-download` 两个命令收敛成一个 `cloud-file <子命令>`(`ls`/`get`/`put`),硬替换、删旧命令,逻辑模块全复用。

**Architecture:** Python 包 `cloud_publish` → `cloud_file`,模块(uploader/downloader/metadata/sas_cache/paths)原样搬;新增 `cli.py` argparse subparsers 分发器,把现有 `__main__.py`(publish)和 `download_cli.py`(list/download)的逻辑搬进 `cmd_put`/`cmd_ls`/`cmd_get`;setup.py 只留一个 `cloud-file` console script。gateway 与 web **不动**。`rm`/`mv` 推迟。

**Tech Stack:** Python 3.12 + `azure-storage-blob`(已装)+ pytest。在 `docker/hermes/skills/cloud/` 下跑 `python -m pytest`。

**Spec:** `docs/superpowers/specs/2026-06-05-cloud-file-cli-design.md`

---

## File Structure

**Rename(整目录搬)**
- `docker/hermes/skills/cloud/cloud_publish/` → `cloud_file/`(含 `uploader.py`/`downloader.py`/`metadata.py`/`sas_cache.py`/`paths.py`/`__init__.py`,逻辑不变)

**Create**
- `docker/hermes/skills/cloud/cloud_file/cli.py` — argparse subparsers(ls/get/put)+ 共享 `_emit`/`_fail`/`_load_sas`
- `docker/hermes/skills/cloud/tests/test_cli.py` — 测三个子命令(替代旧 test_main + test_download_cli)

**Delete**
- `cloud_file/__main__.py`、`cloud_file/download_cli.py`(逻辑已搬进 cli.py)
- `tests/test_main.py`、`tests/test_download_cli.py`(被 test_cli.py 取代)

**Modify**
- `docker/hermes/skills/cloud/setup.py` — `name='cloud-file'`,console_scripts 只剩 `cloud-file=cloud_file.cli:main`
- `docker/hermes/skills/cloud/SKILL.md` — 重写为 cloud-file
- `docker/hermes/Dockerfile` — 注释里的 cloud_publish/cloud-publish 文案(pip install 路径 `/opt/hermes-skills/cloud/` 不变)
- `docker/hermes/entrypoint.sh:75`、`.gitignore:19` — 注释里的 cloud-publish 文案

---

## Task 1: 重命名包 `cloud_publish` → `cloud_file`(纯机械,测试保持绿)

**Files:**
- Rename: `docker/hermes/skills/cloud/cloud_publish/` → `cloud_file/`
- Modify: 该目录下所有 `*.py`、`tests/*.py`、`setup.py` 里出现的标识符 `cloud_publish` → `cloud_file`

- [ ] **Step 1: git mv 整个包目录**

```bash
cd /Users/yanjiayi/workspace/laifu/docker/hermes/skills/cloud
git mv cloud_publish cloud_file
```

- [ ] **Step 2: 把所有 `cloud_publish`(下划线,即包名/import/patch 字符串)替换成 `cloud_file`**

只动这个 skill 目录内的 `.py` 和 `setup.py`;用 perl 跨平台。注意:这一步只替换**下划线** `cloud_publish`(包标识符),不碰带连字符的 `cloud-publish`(那是 dist 名/命令名,Task 2 处理)。

```bash
cd /Users/yanjiayi/workspace/laifu/docker/hermes/skills/cloud
grep -rIl 'cloud_publish' cloud_file tests setup.py 2>/dev/null \
  | xargs perl -pi -e 's/cloud_publish/cloud_file/g'
# 确认没有残留的下划线包名
grep -rn 'cloud_publish' cloud_file tests setup.py || echo "OK: no cloud_publish left"
```

- [ ] **Step 3: 跑全部测试确认仍然绿(纯改名,行为不变)**

Run: `cd /Users/yanjiayi/workspace/laifu/docker/hermes/skills/cloud && python -m pytest -q`
Expected: 全部 PASS(81 passed 量级)。`import cloud_file` 走 cwd,无需重装。

- [ ] **Step 4: Commit**

```bash
cd /Users/yanjiayi/workspace/laifu
git add -A docker/hermes/skills/cloud
git commit -m "refactor(cloud): 重命名 Python 包 cloud_publish → cloud_file (纯机械)"
```

---

## Task 2: 新增 `cli.py`(ls/get/put 分发)+ test_cli.py,删旧入口,setup 改单命令

**Files:**
- Create: `docker/hermes/skills/cloud/cloud_file/cli.py`
- Create: `docker/hermes/skills/cloud/tests/test_cli.py`
- Modify: `docker/hermes/skills/cloud/setup.py`
- Delete: `cloud_file/__main__.py`、`cloud_file/download_cli.py`、`tests/test_main.py`、`tests/test_download_cli.py`

- [ ] **Step 1: 写失败测试 `tests/test_cli.py`**

```python
"""Unit tests for cloud_file.cli (ls/get/put subcommands)."""
import json
import unittest.mock as mock

import pytest

from cloud_file import cli


def _run(argv, env, capsys):
    with mock.patch('sys.argv', ['cloud-file', *argv]), \
         mock.patch.dict('os.environ', env, clear=True):
        try:
            cli.main()
            code = 0
        except SystemExit as e:
            code = e.code
    out = capsys.readouterr().out.strip()
    return code, out


_ENV = {'GATEWAY_BASE_URL': 'https://gw.test', 'LAIFU_USER_TOKEN': 'jwt123'}
_SAS = {'blob_endpoint': 'https://b.net', 'container': 'laifu-cloud',
        'prefix': 'user123/', 'sas_token': 'sig', 'expires_at': '2099-01-01T00:00:00Z'}


# ---------- ls ----------
def test_ls_outputs_files(capsys):
    with mock.patch('cloud_file.cli.SasCache') as MockSas, \
         mock.patch('cloud_file.cli.list_files') as mock_list:
        MockSas.return_value.get.return_value = _SAS
        mock_list.return_value = [{'virtual_path': 'a.txt', 'size': 1, 'source': 'web',
                                   'last_modified': None, 'content_type': 'text/plain', 'title': 'a'}]
        code, out = _run(['ls'], _ENV, capsys)
    assert code == 0
    body = json.loads(out)
    assert body['ok'] is True
    assert body['files'][0]['virtual_path'] == 'a.txt'


def test_ls_prefix_gets_trailing_slash(capsys):
    with mock.patch('cloud_file.cli.SasCache') as MockSas, \
         mock.patch('cloud_file.cli.list_files') as mock_list:
        MockSas.return_value.get.return_value = _SAS
        mock_list.return_value = []
        _run(['ls', 'reports'], _ENV, capsys)
    assert mock_list.call_args.kwargs['sub_prefix'] == 'reports/'


def test_ls_auth_error_exit_2(capsys):
    from cloud_file.sas_cache import AuthError
    with mock.patch('cloud_file.cli.SasCache') as MockSas:
        MockSas.return_value.get.side_effect = AuthError('jwt expired')
        code, _ = _run(['ls'], _ENV, capsys)
    assert code == 2


def test_ls_list_error_exit_3(capsys):
    with mock.patch('cloud_file.cli.SasCache') as MockSas, \
         mock.patch('cloud_file.cli.list_files') as mock_list:
        MockSas.return_value.get.return_value = _SAS
        mock_list.side_effect = RuntimeError('network')
        code, _ = _run(['ls'], _ENV, capsys)
    assert code == 3


# ---------- get ----------
def test_get_downloads_and_reports(capsys):
    with mock.patch('cloud_file.cli.SasCache') as MockSas, \
         mock.patch('cloud_file.cli.download_file') as mock_dl:
        MockSas.return_value.get.return_value = _SAS
        mock_dl.return_value = 2048
        code, out = _run(['get', 'reports/q2.pdf', '-o', '/tmp/q2.pdf'], _ENV, capsys)
    assert code == 0
    body = json.loads(out)
    assert body['ok'] is True and body['size'] == 2048 and body['output'] == '/tmp/q2.pdf'


def test_get_default_output_is_basename(capsys):
    with mock.patch('cloud_file.cli.SasCache') as MockSas, \
         mock.patch('cloud_file.cli.download_file') as mock_dl:
        MockSas.return_value.get.return_value = _SAS
        mock_dl.return_value = 1
        code, out = _run(['get', 'reports/q2.pdf'], _ENV, capsys)
    assert code == 0
    assert json.loads(out)['output'] == 'q2.pdf'
    assert mock_dl.call_args.args[2] == 'q2.pdf'  # output positional


def test_get_path_traversal_exit_1(capsys):
    code, _ = _run(['get', '../x', '-o', '/tmp/x'], _ENV, capsys)
    assert code == 1


def test_get_blob_missing_exit_3(capsys):
    with mock.patch('cloud_file.cli.SasCache') as MockSas, \
         mock.patch('cloud_file.cli.download_file') as mock_dl:
        MockSas.return_value.get.return_value = _SAS
        mock_dl.side_effect = FileNotFoundError('blob not found: a.txt')
        code, _ = _run(['get', 'a.txt', '-o', '/tmp/a'], _ENV, capsys)
    assert code == 3


# ---------- put ----------
def test_put_uploads_and_reports(capsys, tmp_path):
    f = tmp_path / 'report.pdf'
    f.write_bytes(b'%PDF fake')
    with mock.patch('cloud_file.cli.SasCache') as MockSas, \
         mock.patch('cloud_file.cli.upload_blob') as mock_up:
        MockSas.return_value.get.return_value = _SAS
        mock_up.return_value = 'https://b.net/laifu-cloud/user123/reports/sales.pdf'
        code, out = _run(['put', str(f), 'reports/sales.pdf'], _ENV, capsys)
    assert code == 0
    body = json.loads(out)
    assert body['ok'] is True
    assert body['blob_name'] == 'user123/reports/sales.pdf'
    # metadata 默认 source=agent
    meta = mock_up.call_args.kwargs['metadata']
    assert meta['source'] == 'agent'


def test_put_file_missing_exit_1(capsys):
    code, _ = _run(['put', '/no/such/file', 'x.pdf'], _ENV, capsys)
    assert code == 1


def test_put_path_traversal_exit_1(capsys, tmp_path):
    f = tmp_path / 'a.bin'; f.write_bytes(b'x')
    code, _ = _run(['put', str(f), '../x'], _ENV, capsys)
    assert code == 1


def test_put_missing_jwt_exit_2(capsys, tmp_path):
    f = tmp_path / 'a.bin'; f.write_bytes(b'x')
    code, _ = _run(['put', str(f), 'a.bin'], {'GATEWAY_BASE_URL': 'https://gw.test'}, capsys)
    assert code == 2
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/yanjiayi/workspace/laifu/docker/hermes/skills/cloud && python -m pytest tests/test_cli.py -q`
Expected: FAIL(`No module named cloud_file.cli`)。

- [ ] **Step 3: 实现 `cloud_file/cli.py`**

```python
"""cloud-file CLI — 管理用户的 laifu 云盘(子命令 ls / get / put)。

Stdout: 一行 JSON。退出码:0 成功 / 1 参数错误 / 2 鉴权失败 / 3 网络或下载上传失败 / 4 其他。
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import pathlib
import sys

from cloud_file.sas_cache import SasCache, AuthError
from cloud_file.paths import validate_virtual_path
from cloud_file.downloader import list_files, download_file
from cloud_file.uploader import upload_blob
from cloud_file.metadata import build_metadata

_MAX_FILE_BYTES = 10 * 1024 * 1024  # 10 MB


# ---------------------------------------------------------------------------
# 输出 / 错误
# ---------------------------------------------------------------------------

def _emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def _fail(msg: str, code: int) -> None:
    _emit({'ok': False, 'error': msg})
    sys.exit(code)


def _load_sas() -> tuple[dict, SasCache]:
    """读 env + 取 SAS(缓存)。失败按约定退出码 _fail。"""
    gateway_base_url = os.environ.get('GATEWAY_BASE_URL', '').strip()
    jwt = os.environ.get('LAIFU_USER_TOKEN', '').strip()
    if not gateway_base_url:
        _fail('GATEWAY_BASE_URL environment variable not set', 4)
    if not jwt:
        _fail('LAIFU_USER_TOKEN environment variable not set', 2)
    cache_path = pathlib.Path.home() / '.hermes' / '_cloud_sas.json'
    sas_cache = SasCache(path=cache_path, gateway_base_url=gateway_base_url, jwt=jwt)
    try:
        sas = sas_cache.get()
    except AuthError as exc:
        _fail(str(exc), 2)
    except Exception as exc:
        _fail(f'Failed to obtain SAS token: {exc}', 3)
    return sas, sas_cache


# ---------------------------------------------------------------------------
# 子命令
# ---------------------------------------------------------------------------

def cmd_ls(args: argparse.Namespace) -> None:
    sas, _ = _load_sas()
    prefix = args.prefix
    if prefix and not prefix.endswith('/'):
        prefix += '/'
    try:
        files = list_files(sas, sub_prefix=prefix)
    except Exception as exc:
        _fail(f'list failed: {exc}', 3)
    _emit({'ok': True, 'files': files})


def cmd_get(args: argparse.Namespace) -> None:
    try:
        validate_virtual_path(args.virtual_path)
    except ValueError as exc:
        _fail(str(exc), 1)
    output = args.output or pathlib.PurePosixPath(args.virtual_path).name
    sas, sas_cache = _load_sas()
    try:
        size = download_file(sas, args.virtual_path, output, sas_cache=sas_cache)
    except FileNotFoundError as exc:
        _fail(str(exc), 3)
    except RuntimeError as exc:
        _fail(str(exc), 3)
    except Exception as exc:
        _fail(f'Unexpected download error: {exc}', 4)
    _emit({'ok': True, 'virtual_path': args.virtual_path, 'output': output, 'size': size})


def cmd_put(args: argparse.Namespace) -> None:
    file_path = pathlib.Path(args.file)
    if not file_path.exists():
        _fail(f'file not found: {args.file}', 1)
    if not file_path.is_file():
        _fail(f'not a regular file: {args.file}', 1)
    file_size = file_path.stat().st_size
    if file_size > _MAX_FILE_BYTES:
        _fail(f'file too large: {file_size} bytes > {_MAX_FILE_BYTES} (10 MB limit)', 1)

    try:
        validate_virtual_path(args.virtual_path)
    except ValueError as exc:
        _fail(str(exc), 1)

    env_session_id = os.environ.get('LAIFU_SESSION_ID', '').strip() or None
    session_id = args.session_id or env_session_id
    title = args.title or pathlib.PurePosixPath(args.virtual_path).name

    content_type = args.content_type
    if not content_type:
        guessed, _ = mimetypes.guess_type(str(file_path))
        content_type = guessed

    tags_list = None
    if args.tags:
        tags_list = [t.strip() for t in args.tags.split(',') if t.strip()]

    sas, sas_cache = _load_sas()
    prefix = sas.get('prefix', '')
    blob_name = f'{prefix}{args.virtual_path}'

    try:
        metadata = build_metadata(
            title=title,
            session_id=session_id,
            tool_version='0.1.0',
            description=args.description,
            tags=tags_list,
        )
    except ValueError as exc:
        _fail(str(exc), 1)

    try:
        url = upload_blob(
            sas=sas,
            blob_name=blob_name,
            file_path=file_path,
            metadata=metadata,
            content_type=content_type,
            sas_cache=sas_cache,
        )
    except RuntimeError as exc:
        _fail(str(exc), 3)
    except Exception as exc:
        _fail(f'Unexpected upload error: {exc}', 4)

    _emit({'ok': True, 'blob_name': blob_name, 'url': url})


# ---------------------------------------------------------------------------
# 解析 / 入口
# ---------------------------------------------------------------------------

def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog='cloud-file', description="Manage the user's laifu Cloud Drive.")
    sub = p.add_subparsers(dest='cmd', required=True)

    p_ls = sub.add_parser('ls', help='List files (flat, recursive)')
    p_ls.add_argument('prefix', nargs='?', default='', help='Optional virtual prefix, e.g. reports/')

    p_get = sub.add_parser('get', help='Download a file from the cloud drive')
    p_get.add_argument('virtual_path', help='Cloud path, e.g. reports/q2.pdf')
    p_get.add_argument('-o', '--output', default=None,
                       help='Local output path (default: basename of virtual_path in cwd)')

    p_put = sub.add_parser('put', help='Upload/publish a local file to the cloud drive')
    p_put.add_argument('file', help='Local file path')
    p_put.add_argument('virtual_path', help='Cloud path, e.g. reports/2026-06/sales.pdf')
    p_put.add_argument('--title', default=None, help='Human-readable title (UTF-8 OK)')
    p_put.add_argument('--description', default=None, help='Short description (UTF-8 OK)')
    p_put.add_argument('--tags', default=None, help='Comma-separated tags')
    p_put.add_argument('--session-id', default=None, dest='session_id')
    p_put.add_argument('--content-type', default=None, dest='content_type',
                       help='MIME type; auto-detected from extension if omitted')
    return p


def main() -> None:
    args = _build_parser().parse_args()
    if args.cmd == 'ls':
        cmd_ls(args)
    elif args.cmd == 'get':
        cmd_get(args)
    elif args.cmd == 'put':
        cmd_put(args)


if __name__ == '__main__':
    main()
```

- [ ] **Step 4: 删掉旧入口和旧入口测试**

```bash
cd /Users/yanjiayi/workspace/laifu/docker/hermes/skills/cloud
git rm cloud_file/__main__.py cloud_file/download_cli.py tests/test_main.py tests/test_download_cli.py
```

- [ ] **Step 5: 改 setup.py 为单命令 `cloud-file`**

把 `setup.py` 改成(name + 单 console script):

```python
from setuptools import setup, find_packages

setup(
    name='cloud-file',
    version='0.1.0',
    description='Manage files on the laifu cloud drive (Hermes skill: ls/get/put)',
    packages=find_packages(exclude=['tests']),
    python_requires='>=3.10',
    install_requires=[
        'azure-storage-blob>=12.20.0',
    ],
    entry_points={
        'console_scripts': [
            'cloud-file=cloud_file.cli:main',
        ],
    },
)
```

- [ ] **Step 6: 跑测试确认通过 + 重装注册命令**

```bash
cd /Users/yanjiayi/workspace/laifu/docker/hermes/skills/cloud
python -m pytest -q
pip install -e . >/dev/null 2>&1 && cloud-file 2>&1 | head -1; echo "exit reflects head"
```
Expected:
- pytest 全 PASS(test_cli + metadata/paths/uploader/downloader/sas_cache;旧 test_main/test_download_cli 已删)。
- `cloud-file`(无参数)打印 argparse 错误并非零退出(因为 `sub.required=True`);`cloud-file ls --help` 可用。

- [ ] **Step 7: Commit**

```bash
cd /Users/yanjiayi/workspace/laifu
git add -A docker/hermes/skills/cloud
git commit -m "feat(cloud): cloud-file CLI (ls/get/put) 统一入口, 删 publish/download 旧命令"
```

---

## Task 3: SKILL.md 重写 + 全仓注释引用替换

**Files:**
- Modify: `docker/hermes/skills/cloud/SKILL.md`
- Modify: `docker/hermes/Dockerfile`(注释)
- Modify: `docker/hermes/entrypoint.sh:75`(注释)
- Modify: `.gitignore:19`(注释)

- [ ] **Step 1: 重写 SKILL.md**

整体替换 `docker/hermes/skills/cloud/SKILL.md` 为:

```markdown
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
| `put` | `cloud-file put <本地文件> <虚拟路径> [--title ...] [--description ...] [--tags a,b] [--session-id ...] [--content-type ...]` | 上传/发布;≤10MB;同虚拟路径覆盖 |

`source` 字段:`web`=用户网页上传,`agent`=agent(`put`)发布。

## 约束

- 单文件 ≤ 10MB(put)
- 虚拟路径规则:不含 `..` / 不以 `/` 开头或结尾 / 段长 ≤ 200 / 总长 ≤ 1024

## 输出与退出码

stdout 一行 JSON。退出码:0=成功,1=参数错误,2=鉴权失败,3=网络/下载/上传失败(含文件不存在),4=其他。
```

- [ ] **Step 2: 改三处注释里的旧名**

```bash
cd /Users/yanjiayi/workspace/laifu
# Dockerfile 注释:cloud_publish/cloud-publish → cloud_file/cloud-file(只动注释文案;pip install 路径 /opt/hermes-skills/cloud/ 不变)
perl -pi -e 's/cloud_publish/cloud_file/g; s/cloud-publish/cloud-file/g' docker/hermes/Dockerfile
# entrypoint.sh:75 注释
perl -pi -e 's/cloud-publish/cloud-file/g' docker/hermes/entrypoint.sh
# .gitignore:19 注释
perl -pi -e 's/cloud-publish/cloud-file/g' .gitignore
# 确认全仓再无旧名(排除 docs 历史 spec / egg-info / 缓存)
grep -rIn 'cloud-publish\|cloud_publish\|cloud-download' \
  --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.venv \
  --exclude-dir=__pycache__ --exclude-dir=.pytest_cache --exclude='*.egg-info' \
  --exclude-dir=docs . || echo "OK: no legacy names outside docs"
```
Expected: 除 `docs/superpowers/`(历史 spec,保留)外,全仓无 `cloud-publish`/`cloud_publish`/`cloud-download`。

- [ ] **Step 3: 跑测试 + 确认 Dockerfile pip install 路径没被误改**

```bash
cd /Users/yanjiayi/workspace/laifu
grep -n 'pip install' -A2 docker/hermes/Dockerfile | grep -n '/opt/hermes-skills/cloud/' && echo "OK: 安装路径仍是 /opt/hermes-skills/cloud/"
cd docker/hermes/skills/cloud && python -m pytest -q
```
Expected: 安装路径仍是 `/opt/hermes-skills/cloud/`(目录名 `cloud` 没变);pytest 全 PASS。

- [ ] **Step 4: Commit**

```bash
cd /Users/yanjiayi/workspace/laifu
git add -A docker/hermes .gitignore
git commit -m "docs(cloud): SKILL.md 重写为 cloud-file + 全仓清掉 cloud-publish/cloud-download 引用"
```

---

## Task 4: 重建 hermes 镜像 + 容器内冒烟(手动,需 Docker)

**Files:** 无(验证任务)

> `/opt/hermes-skills/cloud` 是 build 时 COPY+pip install 进镜像的、非挂载,所以**必须重建镜像**容器才有 `cloud-file`。

- [ ] **Step 1: 重建镜像**

Run: `cd /Users/yanjiayi/workspace/laifu && docker build -t hermes-probe docker/hermes/`
Expected: build 成功。

- [ ] **Step 2: 容器内确认命令存在 + 旧命令已消失**

```bash
docker run --rm hermes-probe sh -lc 'which cloud-file; which cloud-publish 2>/dev/null || echo "cloud-publish: gone (预期)"; which cloud-download 2>/dev/null || echo "cloud-download: gone (预期)"'
```
Expected:`cloud-file` 有路径(如 `/usr/local/bin/cloud-file` 或 venv bin);`cloud-publish`/`cloud-download` 都 gone。

- [ ] **Step 3: 子命令冒烟(无 env → 鉴权退出码)**

```bash
docker run --rm hermes-probe sh -lc 'cloud-file ls 2>&1 | head -1; echo "---"; cloud-file get x.pdf 2>&1 | head -1'
```
Expected:打印一行 JSON `{"ok": false, "error": "GATEWAY_BASE_URL environment variable not set"}`(退出码 4)——证明命令可执行、参数解析正常。

- [ ] **Step 4(端到端,可选,需真实环境):** 起 `pnpm dev`、登录、启用云盘、刷新容器 token 后,在容器里:
```bash
cloud-file ls
cloud-file put /home/hermes/work/data.csv inbox/data.csv
cloud-file get inbox/data.csv -o /tmp/back.csv && sha256sum /tmp/back.csv
```
Expected:ls 列出文件、put 返回 blob_name、get sha256 与源一致。

---

## Self-Review(已对 spec 核对)

- **spec §二 命令形态 ls/get/put + 输出/退出码** → Task 2 cli.py 全覆盖 ✅
- **spec §三 包重构(cloud_publish→cloud_file、cli.py、删旧入口)** → Task 1(rename)+ Task 2(cli + 删旧)✅
- **spec §四 SKILL.md 重写(name=cloud-file,目录 cloud 不变)** → Task 3 Step 1 ✅
- **spec §五 Dockerfile/镜像 + 全仓 grep 替换 + 重建** → Task 3 Step 2-3(引用)+ Task 4(重建+冒烟)✅
- **spec §六 测试(保留模块测试改 import、合并入口测试为 test_cli)** → Task 1(import 改名)+ Task 2(test_cli 取代 test_main/test_download_cli)✅
- **spec §七 PR #6 重塑、硬替换风险(全仓引用)** → Task 3 Step 2 grep 强制项 ✅;gateway/web 不动(本计划无任何 apps/ 改动)✅
- **类型/命名一致性**:`cli.py` 的 `_emit`/`_fail`/`_load_sas`/`cmd_ls`/`cmd_get`/`cmd_put` 与 test_cli 的 patch 目标(`cloud_file.cli.SasCache`/`list_files`/`download_file`/`upload_blob`)一致;`build_metadata` 默认 `source=agent`(PR #6 已加)→ put 测试断言 source=agent 成立 ✅
- **占位符**:无 TBD/TODO,每个代码步骤含完整代码 ✅
- **gateway/web 未触碰**:本计划只动 `docker/hermes/**` + `.gitignore`,PR #6 的 apps/gateway、apps/web、packages/shared 改动保持不变 ✅
