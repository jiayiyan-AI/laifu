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
