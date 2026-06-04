"""Unit tests for cloud_publish.download_cli."""
import json
import unittest.mock as mock

import pytest

from cloud_publish import download_cli


def _run(argv, env, capsys):
    with mock.patch('sys.argv', ['cloud-download', *argv]), \
         mock.patch.dict('os.environ', env, clear=True):
        try:
            download_cli.main()
            code = 0
        except SystemExit as e:
            code = e.code
    out = capsys.readouterr().out.strip()
    return code, out


_ENV = {'GATEWAY_BASE_URL': 'https://gw.test', 'LAIFU_USER_TOKEN': 'jwt123'}
_SAS = {'blob_endpoint': 'https://b.net', 'container': 'laifu-cloud',
        'prefix': 'user123/', 'sas_token': 'sig', 'expires_at': '2099-01-01T00:00:00Z'}


def test_list_outputs_files_json(capsys):
    with mock.patch('cloud_publish.download_cli.SasCache') as MockSas, \
         mock.patch('cloud_publish.download_cli.list_files') as mock_list:
        MockSas.return_value.get.return_value = _SAS
        mock_list.return_value = [{'virtual_path': 'a.txt', 'size': 1, 'source': 'web',
                                   'last_modified': None, 'content_type': 'text/plain', 'title': 'a'}]
        code, out = _run(['--list'], _ENV, capsys)
    assert code == 0
    body = json.loads(out)
    assert body['ok'] is True
    assert body['files'][0]['virtual_path'] == 'a.txt'


def test_download_writes_and_reports(capsys):
    with mock.patch('cloud_publish.download_cli.SasCache') as MockSas, \
         mock.patch('cloud_publish.download_cli.download_file') as mock_dl:
        MockSas.return_value.get.return_value = _SAS
        mock_dl.return_value = 2048
        code, out = _run(['--virtual-path', 'reports/q2.pdf', '--output', '/tmp/q2.pdf'], _ENV, capsys)
    assert code == 0
    body = json.loads(out)
    assert body['ok'] is True
    assert body['virtual_path'] == 'reports/q2.pdf'
    assert body['size'] == 2048
    assert body['output'] == '/tmp/q2.pdf'


def test_missing_jwt_exit_2(capsys):
    code, out = _run(['--list'], {'GATEWAY_BASE_URL': 'https://gw.test'}, capsys)
    assert code == 2


def test_download_requires_output(capsys):
    code, _ = _run(['--virtual-path', 'a.txt'], _ENV, capsys)
    assert code == 1


def test_path_traversal_exit_1(capsys):
    code, _ = _run(['--virtual-path', '../x', '--output', '/tmp/x'], _ENV, capsys)
    assert code == 1


def test_blob_missing_exit_3(capsys):
    with mock.patch('cloud_publish.download_cli.SasCache') as MockSas, \
         mock.patch('cloud_publish.download_cli.download_file') as mock_dl:
        MockSas.return_value.get.return_value = _SAS
        mock_dl.side_effect = FileNotFoundError('blob not found: a.txt')
        code, _ = _run(['--virtual-path', 'a.txt', '--output', '/tmp/a'], _ENV, capsys)
    assert code == 3


def test_list_error_exit_3(capsys):
    with mock.patch('cloud_publish.download_cli.SasCache') as MockSas, \
         mock.patch('cloud_publish.download_cli.list_files') as mock_list:
        MockSas.return_value.get.return_value = _SAS
        mock_list.side_effect = RuntimeError('network error')
        code, out = _run(['--list'], _ENV, capsys)
    assert code == 3
    assert json.loads(out)['ok'] is False


def test_auth_error_exit_2(capsys):
    from cloud_publish.sas_cache import AuthError
    with mock.patch('cloud_publish.download_cli.SasCache') as MockSas:
        MockSas.return_value.get.side_effect = AuthError('jwt expired')
        code, _ = _run(['--list'], _ENV, capsys)
    assert code == 2


def test_sas_fetch_network_error_exit_3(capsys):
    with mock.patch('cloud_publish.download_cli.SasCache') as MockSas:
        MockSas.return_value.get.side_effect = RuntimeError('gateway 500')
        code, _ = _run(['--list'], _ENV, capsys)
    assert code == 3


def test_list_prefix_gets_trailing_slash(capsys):
    with mock.patch('cloud_publish.download_cli.SasCache') as MockSas, \
         mock.patch('cloud_publish.download_cli.list_files') as mock_list:
        MockSas.return_value.get.return_value = _SAS
        mock_list.return_value = []
        _run(['--list', '--prefix', 'reports'], _ENV, capsys)
    assert mock_list.call_args.kwargs['sub_prefix'] == 'reports/'


def test_list_empty_prefix_stays_empty(capsys):
    with mock.patch('cloud_publish.download_cli.SasCache') as MockSas, \
         mock.patch('cloud_publish.download_cli.list_files') as mock_list:
        MockSas.return_value.get.return_value = _SAS
        mock_list.return_value = []
        _run(['--list'], _ENV, capsys)
    assert mock_list.call_args.kwargs['sub_prefix'] == ''
