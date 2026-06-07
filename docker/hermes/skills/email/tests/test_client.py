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
