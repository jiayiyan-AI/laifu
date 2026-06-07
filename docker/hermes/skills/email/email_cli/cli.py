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
