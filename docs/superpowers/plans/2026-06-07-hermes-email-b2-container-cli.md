# Hermes 邮件能力 B2:容器内 `email` CLI + SKILL.md Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Hermes 容器一个 `email` CLI(子命令 `ls`/`read`/`send`/`reply`),让助手按聊天指令读收件箱、发信/回信,完全照 `skills/cloud/` 模子。

**Architecture:** 新建 `docker/hermes/skills/email/` skill 包,Python 包名 `email_cli`(避开 stdlib `email` 同名遮蔽),console 脚本 `email`,**文件夹必须叫 `email`**(entrypoint.sh 按 entitlement id 软链 `$SKILLS_SOURCE/<id>`)。CLI 通过 stdlib `urllib` 调 gateway `/api/email/*` HTTP 端点,鉴权用 `GATEWAY_BASE_URL` + `LAIFU_USER_TOKEN`(Bearer),不碰 Azure/SAS。本期**不做附件**(B1 后端尚未支持附件存取)。

**Tech Stack:** Python 3.10+(stdlib only:argparse / urllib / json),pytest,setuptools entry_points。

---

## 背景与参照(实现者必读)

- 后端端点(已在 B1 落地,见 `apps/gateway/src/api/email.ts`):
  - `GET  /api/email/list?q=&limit=` → `{ emails: EmailListItem[] }`,鉴权 containerAuth + email entitlement。
  - `GET  /api/email/get?id=` → `{ email: EmailDetail }`;找不到 404;缺 id 400。
  - `POST /api/email/send` body `{ to:string[], cc?:string[], subject, body_text, in_reply_to_id? }` → `{ ok:true, id, message_id }`;给 `in_reply_to_id` 时服务端自动接线程头、收件人默认原发件人、主题加 `Re:`;无 `to` 又无 `in_reply_to_id` → 400;无地址(未 provision)→ 409。
  - 鉴权失败统一 401。
- 契约类型见 `packages/shared/src/contracts.ts`:`EmailListItem`(id/direction/from_addr/to_addrs/subject/has_attachments/received_at)、`EmailDetail`(在 List 基础上加 cc_addrs/message_id/in_reply_to/reference_ids/body_text)。
- 参照实现:`docker/hermes/skills/cloud/cloud_file/`(cli.py 的 `_emit`/`_fail`/退出码、`sas_cache.py` 的 urllib + AuthError 模式、`tests/test_cli.py` 的 mock 测试风格、`setup.py` 的 entry_points、`SKILL.md` 的写法)。
- 退出码约定(沿用 cloud_file):**0** 成功 / **1** 参数错误 / **2** 鉴权失败(401)/ **3** 网络或 gateway 非 2xx(含 404 找不到)/ **4** 其他。
- 安装机制:`docker/hermes/Dockerfile` 用 venv 的 pip `-e` 安装 skill 包,console 脚本落到 `/opt/hermes-agent/venv/bin/`(在 PATH 上)。entrypoint.sh Step 6 按 desired entitlements 软链 `skills/<id>` → 容器内 skill 目录,所以 SKILL.md 只在 `email` entitlement 开启时对助手可见。

## 文件结构

```
docker/hermes/skills/email/
  email_cli/__init__.py        # 空(包标记)
  email_cli/client.py          # GatewayClient:urllib 调 gateway, AuthError/GatewayError/NetworkError
  email_cli/cli.py             # argparse ls/read/send/reply + _emit/_fail + 退出码
  setup.py                     # console_scripts: email=email_cli.cli:main
  SKILL.md                     # 何时用 / 用法 / 约束 / 输出与退出码
  tests/__init__.py            # 空
  tests/test_client.py         # GatewayClient 单测(mock urlopen)
  tests/test_cli.py            # CLI 单测(mock GatewayClient)
docker/hermes/Dockerfile       # 追加安装 email skill 的 pip 行
```

---

### Task 1: skill 包骨架 + GatewayClient(HTTP 客户端)

**Files:**
- Create: `docker/hermes/skills/email/email_cli/__init__.py`
- Create: `docker/hermes/skills/email/email_cli/client.py`
- Create: `docker/hermes/skills/email/tests/__init__.py`
- Create: `docker/hermes/skills/email/tests/test_client.py`

- [ ] **Step 1: 写空包标记文件**

`docker/hermes/skills/email/email_cli/__init__.py` 和 `docker/hermes/skills/email/tests/__init__.py` 都写空内容(0 字节)。

- [ ] **Step 2: 写失败测试 `tests/test_client.py`**

```python
"""Unit tests for email_cli.client.GatewayClient (mock urlopen)."""
import io
import json
import urllib.error
import unittest.mock as mock

import pytest

from email_cli.client import GatewayClient, AuthError, GatewayError, NetworkError


def _resp(body: dict):
    """伪造 urlopen 的 context-manager 返回。"""
    m = mock.MagicMock()
    m.read.return_value = json.dumps(body).encode('utf-8')
    m.__enter__.return_value = m
    m.__exit__.return_value = False
    return m


def test_get_returns_json():
    c = GatewayClient('https://gw.test/', 'jwt123')
    with mock.patch('urllib.request.urlopen', return_value=_resp({'emails': []})) as uo:
        out = c.get('/api/email/list', params={'limit': 5})
    assert out == {'emails': []}
    req = uo.call_args.args[0]
    assert req.full_url == 'https://gw.test/api/email/list?limit=5'
    assert req.get_header('Authorization') == 'Bearer jwt123'


def test_get_drops_none_params():
    c = GatewayClient('https://gw.test', 'jwt')
    with mock.patch('urllib.request.urlopen', return_value=_resp({'emails': []})) as uo:
        c.get('/api/email/list', params={'q': None, 'limit': 30})
    assert uo.call_args.args[0].full_url == 'https://gw.test/api/email/list?limit=30'


def test_post_sends_json_body():
    c = GatewayClient('https://gw.test', 'jwt')
    with mock.patch('urllib.request.urlopen', return_value=_resp({'ok': True})) as uo:
        out = c.post('/api/email/send', {'to': ['a@b.com'], 'subject': 's'})
    assert out == {'ok': True}
    req = uo.call_args.args[0]
    assert req.method == 'POST'
    assert json.loads(req.data) == {'to': ['a@b.com'], 'subject': 's'}
    assert req.get_header('Content-type') == 'application/json'


def test_401_raises_auth_error():
    c = GatewayClient('https://gw.test', 'jwt')
    err = urllib.error.HTTPError('u', 401, 'unauth', {}, io.BytesIO(b'{"error":"x"}'))
    with mock.patch('urllib.request.urlopen', side_effect=err):
        with pytest.raises(AuthError):
            c.get('/api/email/list')


def test_404_raises_gateway_error_with_status():
    c = GatewayClient('https://gw.test', 'jwt')
    err = urllib.error.HTTPError('u', 404, 'nf', {}, io.BytesIO(b'{"error":"not found"}'))
    with mock.patch('urllib.request.urlopen', side_effect=err):
        with pytest.raises(GatewayError) as ei:
            c.get('/api/email/get', params={'id': 'nope'})
    assert ei.value.status == 404


def test_urlerror_raises_network_error():
    c = GatewayClient('https://gw.test', 'jwt')
    with mock.patch('urllib.request.urlopen', side_effect=urllib.error.URLError('refused')):
        with pytest.raises(NetworkError):
            c.get('/api/email/list')
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd docker/hermes/skills/email && python -m pytest tests/test_client.py -q`
Expected: FAIL,`ModuleNotFoundError: No module named 'email_cli.client'`(或导入错误)。

- [ ] **Step 4: 写实现 `email_cli/client.py`**

```python
"""Gateway HTTP client for the email CLI.

只用 stdlib urllib(与 cloud_file.sas_cache 同风格,避免额外依赖)。
调 gateway /api/email/* 端点,Bearer = LAIFU_USER_TOKEN。
"""
from __future__ import annotations

import json
import urllib.parse
import urllib.request
import urllib.error


class AuthError(Exception):
    """Gateway 返回 401(token 失效/无效)。"""


class GatewayError(Exception):
    """Gateway 返回非 2xx(401 除外)。带 status + body。"""

    def __init__(self, status: int, body: str) -> None:
        super().__init__(f'gateway HTTP {status}: {body}')
        self.status = status
        self.body = body


class NetworkError(Exception):
    """连不上 gateway(URLError)。"""


class GatewayClient:
    def __init__(self, base_url: str, jwt: str) -> None:
        self._base = base_url.rstrip('/')
        self._jwt = jwt

    def get(self, path: str, params: dict | None = None) -> dict:
        url = f'{self._base}{path}'
        if params:
            clean = {k: v for k, v in params.items() if v is not None}
            if clean:
                url = f'{url}?{urllib.parse.urlencode(clean)}'
        return self._request('GET', url, data=None)

    def post(self, path: str, payload: dict) -> dict:
        url = f'{self._base}{path}'
        data = json.dumps(payload).encode('utf-8')
        return self._request('POST', url, data=data)

    def _request(self, method: str, url: str, data: bytes | None) -> dict:
        headers = {'Authorization': f'Bearer {self._jwt}'}
        if data is not None:
            headers['Content-Type'] = 'application/json'
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req) as resp:
                body = resp.read()
            return json.loads(body) if body else {}
        except urllib.error.HTTPError as exc:
            detail = ''
            try:
                detail = exc.read().decode('utf-8', 'replace')
            except Exception:
                pass
            if exc.code == 401:
                raise AuthError(f'Gateway 401 — token expired/invalid (url={url})') from exc
            raise GatewayError(exc.code, detail) from exc
        except urllib.error.URLError as exc:
            raise NetworkError(f'Network error to {url}: {exc.reason}') from exc
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd docker/hermes/skills/email && python -m pytest tests/test_client.py -q`
Expected: PASS(6 passed)。

- [ ] **Step 6: 提交**

```bash
git add docker/hermes/skills/email/email_cli/__init__.py \
        docker/hermes/skills/email/email_cli/client.py \
        docker/hermes/skills/email/tests/__init__.py \
        docker/hermes/skills/email/tests/test_client.py
git commit -m "feat(email-cli): GatewayClient (urllib HTTP 客户端 + 错误分类)"
```

---

### Task 2: `email` CLI(ls/read/send/reply)

**Files:**
- Create: `docker/hermes/skills/email/email_cli/cli.py`
- Test: `docker/hermes/skills/email/tests/test_cli.py`

- [ ] **Step 1: 写失败测试 `tests/test_cli.py`**

```python
"""Unit tests for email_cli.cli (ls/read/send/reply)。mock GatewayClient。"""
import json
import unittest.mock as mock

import pytest

from email_cli import cli
from email_cli.client import AuthError, GatewayError, NetworkError


def _run(argv, env, capsys):
    with mock.patch('sys.argv', ['email', *argv]), \
         mock.patch.dict('os.environ', env, clear=True):
        try:
            cli.main()
            code = 0
        except SystemExit as e:
            code = e.code
    out = capsys.readouterr().out.strip()
    return code, out


_ENV = {'GATEWAY_BASE_URL': 'https://gw.test', 'LAIFU_USER_TOKEN': 'jwt123'}


# ---------- ls ----------
def test_ls_outputs_emails(capsys):
    with mock.patch('email_cli.cli.GatewayClient') as MockC:
        MockC.return_value.get.return_value = {'emails': [
            {'id': 'eml_1', 'direction': 'inbound', 'from_addr': 'b@x',
             'to_addrs': [], 'subject': '报价', 'has_attachments': False, 'received_at': 't'}]}
        code, out = _run(['ls'], _ENV, capsys)
    assert code == 0
    body = json.loads(out)
    assert body['ok'] is True and body['emails'][0]['id'] == 'eml_1'


def test_ls_passes_q_and_limit(capsys):
    with mock.patch('email_cli.cli.GatewayClient') as MockC:
        MockC.return_value.get.return_value = {'emails': []}
        _run(['ls', '--q', '报价', '--limit', '5'], _ENV, capsys)
    MockC.return_value.get.assert_called_once_with(
        '/api/email/list', params={'q': '报价', 'limit': 5})


def test_ls_auth_error_exit_2(capsys):
    with mock.patch('email_cli.cli.GatewayClient') as MockC:
        MockC.return_value.get.side_effect = AuthError('x')
        code, _ = _run(['ls'], _ENV, capsys)
    assert code == 2


def test_ls_network_error_exit_3(capsys):
    with mock.patch('email_cli.cli.GatewayClient') as MockC:
        MockC.return_value.get.side_effect = NetworkError('refused')
        code, _ = _run(['ls'], _ENV, capsys)
    assert code == 3


# ---------- read ----------
def test_read_outputs_email(capsys):
    with mock.patch('email_cli.cli.GatewayClient') as MockC:
        MockC.return_value.get.return_value = {'email': {
            'id': 'eml_1', 'direction': 'inbound', 'from_addr': 'b@x', 'to_addrs': [],
            'cc_addrs': [], 'subject': '报价', 'message_id': '<m1>', 'in_reply_to': None,
            'reference_ids': [], 'body_text': '请确认', 'has_attachments': False, 'received_at': 't'}}
        code, out = _run(['read', 'eml_1'], _ENV, capsys)
    assert code == 0
    body = json.loads(out)
    assert body['ok'] is True and body['email']['body_text'] == '请确认'
    MockC.return_value.get.assert_called_once_with('/api/email/get', params={'id': 'eml_1'})


def test_read_not_found_exit_3(capsys):
    with mock.patch('email_cli.cli.GatewayClient') as MockC:
        MockC.return_value.get.side_effect = GatewayError(404, '{"error":"not found"}')
        code, _ = _run(['read', 'nope'], _ENV, capsys)
    assert code == 3


# ---------- send ----------
def test_send_posts_payload(capsys):
    with mock.patch('email_cli.cli.GatewayClient') as MockC:
        MockC.return_value.post.return_value = {'ok': True, 'id': 'eml_out', 'message_id': '<o1>'}
        code, out = _run(['send', '--to', 'a@b.com', '--subject', '询价', '--body', '在吗'],
                         _ENV, capsys)
    assert code == 0
    body = json.loads(out)
    assert body['ok'] is True and body['id'] == 'eml_out' and body['message_id'] == '<o1>'
    MockC.return_value.post.assert_called_once_with(
        '/api/email/send',
        {'to': ['a@b.com'], 'cc': [], 'subject': '询价', 'body_text': '在吗'})


def test_send_multiple_to_and_cc(capsys):
    with mock.patch('email_cli.cli.GatewayClient') as MockC:
        MockC.return_value.post.return_value = {'ok': True, 'id': 'e', 'message_id': '<o>'}
        _run(['send', '--to', 'a@b.com', '--to', 'c@d.com', '--cc', 'e@f.com',
              '--subject', 's', '--body', 'x'], _ENV, capsys)
    payload = MockC.return_value.post.call_args.args[1]
    assert payload['to'] == ['a@b.com', 'c@d.com'] and payload['cc'] == ['e@f.com']


def test_send_missing_to_exit_1(capsys):
    code, _ = _run(['send', '--subject', 's', '--body', 'x'], _ENV, capsys)
    assert code == 1


# ---------- reply ----------
def test_reply_posts_in_reply_to_id(capsys):
    with mock.patch('email_cli.cli.GatewayClient') as MockC:
        MockC.return_value.post.return_value = {'ok': True, 'id': 'eml_out', 'message_id': '<o1>'}
        code, out = _run(['reply', 'eml_1', '--body', '同意'], _ENV, capsys)
    assert code == 0
    assert json.loads(out)['id'] == 'eml_out'
    MockC.return_value.post.assert_called_once_with(
        '/api/email/send',
        {'in_reply_to_id': 'eml_1', 'body_text': '同意', 'to': [], 'cc': []})


def test_reply_with_explicit_to_and_subject(capsys):
    with mock.patch('email_cli.cli.GatewayClient') as MockC:
        MockC.return_value.post.return_value = {'ok': True, 'id': 'e', 'message_id': '<o>'}
        _run(['reply', 'eml_1', '--body', 'ok', '--to', 'x@y.com', '--subject', '自定义'],
             _ENV, capsys)
    payload = MockC.return_value.post.call_args.args[1]
    assert payload['to'] == ['x@y.com'] and payload['subject'] == '自定义'
    assert payload['in_reply_to_id'] == 'eml_1'


# ---------- env 缺失 ----------
def test_missing_jwt_exit_2(capsys):
    code, _ = _run(['ls'], {'GATEWAY_BASE_URL': 'https://gw.test'}, capsys)
    assert code == 2


def test_missing_gateway_url_exit_4(capsys):
    code, _ = _run(['ls'], {'LAIFU_USER_TOKEN': 'jwt'}, capsys)
    assert code == 4


def test_send_gateway_400_exit_3(capsys):
    with mock.patch('email_cli.cli.GatewayClient') as MockC:
        MockC.return_value.post.side_effect = GatewayError(400, '{"error":"to required"}')
        code, _ = _run(['send', '--to', 'a@b.com', '--subject', 's', '--body', 'x'], _ENV, capsys)
    assert code == 3
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd docker/hermes/skills/email && python -m pytest tests/test_cli.py -q`
Expected: FAIL,`ModuleNotFoundError: No module named 'email_cli.cli'`。

- [ ] **Step 3: 写实现 `email_cli/cli.py`**

```python
"""email CLI — 助手的邮件收件箱/发信工具(子命令 ls / read / send / reply)。

Stdout: 一行 JSON。退出码:0 成功 / 1 参数错误 / 2 鉴权失败 / 3 网络或 gateway 非 2xx / 4 其他。
本期不支持附件。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import NoReturn

from email_cli.client import GatewayClient, AuthError, GatewayError, NetworkError


def _emit(obj: dict) -> None:
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def _fail(msg: str, code: int) -> NoReturn:
    _emit({'ok': False, 'error': msg})
    sys.exit(code)


def _client() -> GatewayClient:
    base = os.environ.get('GATEWAY_BASE_URL', '').strip()
    jwt = os.environ.get('LAIFU_USER_TOKEN', '').strip()
    if not base:
        _fail('GATEWAY_BASE_URL environment variable not set', 4)
    if not jwt:
        _fail('LAIFU_USER_TOKEN environment variable not set', 2)
    return GatewayClient(base, jwt)


def _call(fn):
    """统一把 client 异常映射到退出码。fn 是无参 lambda 返回 dict。"""
    try:
        return fn()
    except AuthError as exc:
        _fail(str(exc), 2)
    except GatewayError as exc:
        _fail(str(exc), 3)
    except NetworkError as exc:
        _fail(str(exc), 3)
    except Exception as exc:  # noqa: BLE001
        _fail(f'unexpected error: {exc}', 4)


def cmd_ls(args: argparse.Namespace) -> None:
    c = _client()
    out = _call(lambda: c.get('/api/email/list',
                              params={'q': args.q, 'limit': args.limit}))
    _emit({'ok': True, 'emails': out.get('emails', [])})


def cmd_read(args: argparse.Namespace) -> None:
    c = _client()
    out = _call(lambda: c.get('/api/email/get', params={'id': args.id}))
    _emit({'ok': True, 'email': out.get('email')})


def cmd_send(args: argparse.Namespace) -> None:
    to = args.to or []
    if not to:
        _fail('--to required (at least one recipient)', 1)
    c = _client()
    payload = {'to': to, 'cc': args.cc or [],
               'subject': args.subject, 'body_text': args.body}
    out = _call(lambda: c.post('/api/email/send', payload))
    _emit({'ok': True, 'id': out.get('id'), 'message_id': out.get('message_id')})


def cmd_reply(args: argparse.Namespace) -> None:
    c = _client()
    payload: dict = {'in_reply_to_id': args.id, 'body_text': args.body,
                     'to': args.to or [], 'cc': args.cc or []}
    if args.subject is not None:
        payload['subject'] = args.subject
    out = _call(lambda: c.post('/api/email/send', payload))
    _emit({'ok': True, 'id': out.get('id'), 'message_id': out.get('message_id')})


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog='email', description="助手邮件收发工具。")
    sub = p.add_subparsers(dest='cmd', required=True)

    p_ls = sub.add_parser('ls', help='列出收件箱(newest first)')
    p_ls.add_argument('--q', default=None, help='按主题/发件人模糊搜索')
    p_ls.add_argument('--limit', type=int, default=30, help='返回条数(1..100, 默认 30)')

    p_read = sub.add_parser('read', help='读一封邮件全文(含正文+线程头)')
    p_read.add_argument('id', help='邮件 id, 如 eml_abc123')

    p_send = sub.add_parser('send', help='新发一封邮件')
    p_send.add_argument('--to', action='append', help='收件人(可重复)')
    p_send.add_argument('--cc', action='append', help='抄送(可重复)')
    p_send.add_argument('--subject', required=True, help='主题')
    p_send.add_argument('--body', required=True, help='正文(纯文本)')

    p_reply = sub.add_parser('reply', help='回复某封邮件(自动线程头 + 收件人默认原发件人)')
    p_reply.add_argument('id', help='被回复邮件 id')
    p_reply.add_argument('--body', required=True, help='正文(纯文本)')
    p_reply.add_argument('--to', action='append', help='覆盖收件人(默认=原发件人)')
    p_reply.add_argument('--cc', action='append', help='抄送(可重复)')
    p_reply.add_argument('--subject', default=None, help='覆盖主题(默认=Re: 原主题)')
    return p


def main() -> None:
    args = _build_parser().parse_args()
    {'ls': cmd_ls, 'read': cmd_read, 'send': cmd_send, 'reply': cmd_reply}[args.cmd](args)


if __name__ == '__main__':
    main()
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd docker/hermes/skills/email && python -m pytest tests/test_cli.py -q`
Expected: PASS(全部 passed)。

注意:`argparse` 在 `--subject`/`--body` 缺失或 `required=True` 不满足时会 `sys.exit(2)`,而 `test_send_missing_to_exit_1` 走的是我们手动校验(因为 `--to` 用 `action='append'` 无法用 `required` 简洁表达),故 send 缺 `--to` 是 exit 1,缺 `--subject`/`--body` 才是 argparse 的 exit 2。测试只断言缺 `--to` → 1,符合实现。

- [ ] **Step 5: 提交**

```bash
git add docker/hermes/skills/email/email_cli/cli.py docker/hermes/skills/email/tests/test_cli.py
git commit -m "feat(email-cli): email CLI (ls/read/send/reply) + 退出码"
```

---

### Task 3: setup.py + Dockerfile 安装 + SKILL.md

**Files:**
- Create: `docker/hermes/skills/email/setup.py`
- Create: `docker/hermes/skills/email/SKILL.md`
- Modify: `docker/hermes/Dockerfile`(追加安装 email skill)

- [ ] **Step 1: 写 `setup.py`**

```python
from setuptools import setup, find_packages

setup(
    name='email-cli',
    version='0.1.0',
    description='助手邮件收发工具 (Hermes skill: ls/read/send/reply)',
    packages=find_packages(exclude=['tests']),
    python_requires='>=3.10',
    install_requires=[],  # 仅 stdlib
    entry_points={
        'console_scripts': [
            'email=email_cli.cli:main',
        ],
    },
)
```

- [ ] **Step 2: 写 `SKILL.md`**

```markdown
---
name: email
description: 助手的邮件收发能力(读收件箱/发信/回信)。当用户说"看看有没有新邮件/帮我回那封报价邮件/给 X 发封邮件"→ 用 email CLI。收到邮件不会主动通知,需用户让你 ls 才发现。
version: 0.1.0
platforms: [linux]
metadata:
  hermes:
    tags: [email, mail, inbox, laifu]
---

# email

助手的邮件收发工具,四个子命令:`ls`(列收件箱)、`read`(读一封)、`send`(新发)、`reply`(回信)。

## 何时使用

- "有没有新邮件""看下收件箱""客户回复了吗" → `email ls`(可加 `--q` 搜)
- "把那封报价邮件读给我""第二封讲什么" → 先 `email ls` 拿 id,再 `email read <id>`
- "回复那封邮件,说同意报价" → 先 `email read <id>` 看懂原文,再 `email reply <id> --body "..."`
- "给 bob@supplier.com 发封询价" → `email send --to bob@supplier.com --subject "询价" --body "..."`

## 用法

```bash
# 列收件箱(newest first), 可搜可限量
email ls
email ls --q "报价" --limit 20

# 读一封(打印头 + 正文 + 线程头)
email read eml_abc123

# 回信(自动接线程头 + 收件人默认=原发件人 + 主题自动 Re:)
email reply eml_abc123 --body "确认报价,按此推进。"
email reply eml_abc123 --body "..." --to other@x.com --subject "自定义主题"

# 新发
email send --to bob@supplier.com --subject "询价" --body "..."
email send --to a@x.com --to b@y.com --cc c@z.com --subject "..." --body "..."
```

## 重要约束(必读)

- **收到指令才操作**:邮件到达只是静默落库,不会触发你。用户在聊天里让你做时才动。
- **回复前先 `email read` 看懂原文**:别凭主题猜内容。
- **不确定收件人就回聊天问**:尤其用户**转发**进来的邮件,真实收件人藏在转发正文里,`reply` 默认回的是"转发者"而非原始对方。拿不准时让用户明确收件人。
- 本期**不支持附件**(收发都不带附件)。
- `--body` 是纯文本。

## 输出与退出码

stdout 一行 JSON。成功时:
- `ls`:`{"ok":true,"emails":[{id,direction,from_addr,to_addrs,subject,has_attachments,received_at}]}`
- `read`:`{"ok":true,"email":{...,cc_addrs,message_id,in_reply_to,reference_ids,body_text}}`
- `send`/`reply`:`{"ok":true,"id":"eml_...","message_id":"<...>"}`

失败时:`{"ok":false,"error":"<message>"}`

退出码:0=成功,1=参数错误(如 send 缺 --to),2=鉴权失败,3=网络/gateway 非 2xx(含 read 找不到该邮件),4=其他。
```

- [ ] **Step 3: 改 Dockerfile 追加安装**

打开 `docker/hermes/Dockerfile`,找到安装 cloud skill 的 `RUN`(约 113-116 行):

```dockerfile
RUN unset PIP_USER PYTHONUSERBASE && pip install --no-cache-dir \
    -i https://pypi.tuna.tsinghua.edu.cn/simple \
    --trusted-host pypi.tuna.tsinghua.edu.cn \
    -e /opt/hermes-skills/cloud/
```

在 `-e /opt/hermes-skills/cloud/` 行后追加 `-e /opt/hermes-skills/email/`,即改成:

```dockerfile
RUN unset PIP_USER PYTHONUSERBASE && pip install --no-cache-dir \
    -i https://pypi.tuna.tsinghua.edu.cn/simple \
    --trusted-host pypi.tuna.tsinghua.edu.cn \
    -e /opt/hermes-skills/cloud/ \
    -e /opt/hermes-skills/email/
```

(skills/ 整个目录已在前一句 `COPY skills/ /opt/hermes-skills/` 拷入,故 email 子目录已就位。)

- [ ] **Step 4: 验证整包测试 + 包可被 setuptools 发现**

Run: `cd docker/hermes/skills/email && python -m pytest -q && python -c "import setup" 2>/dev/null; python setup.py --name`
Expected: pytest 全 PASS;`python setup.py --name` 打印 `email-cli`。
(若本机无 setuptools 旧式 `setup.py` 支持,改用 `python -c "import ast,2to3" ` 略过;关键是 pytest 通过。)

- [ ] **Step 5: 提交**

```bash
git add docker/hermes/skills/email/setup.py docker/hermes/skills/email/SKILL.md docker/hermes/Dockerfile
git commit -m "feat(email-cli): setup.py + SKILL.md + Dockerfile 安装 email skill"
```

---

## Self-Review 检查点(实现者执行完三个 Task 后)

- [ ] **Spec 覆盖**:spec §五 要求 `ls`/`read`/`send`/`reply` 四子命令 + 一行 JSON + 退出码 0/1/2/3/4 + SKILL.md 写明"收到指令才操作/回复前先 read/不确定收件人回聊天确认"。逐条对照已实现。附件 spec §五 提到但 B1 后端未支持,本期明确不做(SKILL.md 已注明)。
- [ ] **包名不遮蔽 stdlib**:包名是 `email_cli` 不是 `email`(否则 `import email` 被遮蔽);console 脚本名是 `email`;skill 文件夹名是 `email`(entrypoint 软链键)。三者各司其职。
- [ ] **退出码一致**:401→2,网络/非 2xx→3,参数→1,env 缺 GATEWAY_BASE_URL→4 / 缺 TOKEN→2,其他→4。与 cloud_file 一致。
- [ ] **无新容器 env**:CLI 只读 `GATEWAY_BASE_URL` + `LAIFU_USER_TOKEN`(B1 已有),无新增。

## 端到端冒烟(可选,subagent-driven 最终评审后由协调者跑)

参照 B1 的 dev-fake 冒烟:起本地 gateway(EMAIL_PROVIDER=fake),用一个有效 token + 已 provision 地址的用户,在 `skills/email` 目录直接 `GATEWAY_BASE_URL=... LAIFU_USER_TOKEN=... python -m email_cli.cli ls` 验证真实 HTTP 往返。注意需先有 `email_addresses` 行(B3 的 ensureEmailAddress 提供),否则 `send` 会 409。
