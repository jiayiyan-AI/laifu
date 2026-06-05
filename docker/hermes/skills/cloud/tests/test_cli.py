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


def test_put_missing_gateway_url_exit_4(capsys, tmp_path):
    f = tmp_path / 'a.bin'; f.write_bytes(b'x')
    code, _ = _run(['put', str(f), 'a.bin'], {'LAIFU_USER_TOKEN': 'jwt123'}, capsys)
    assert code == 4


def test_ls_empty_prefix_stays_empty(capsys):
    with mock.patch('cloud_file.cli.SasCache') as MockSas, \
         mock.patch('cloud_file.cli.list_files') as mock_list:
        MockSas.return_value.get.return_value = _SAS
        mock_list.return_value = []
        _run(['ls'], _ENV, capsys)
    assert mock_list.call_args.kwargs['sub_prefix'] == ''


def test_ls_sas_network_error_exit_3(capsys):
    with mock.patch('cloud_file.cli.SasCache') as MockSas:
        MockSas.return_value.get.side_effect = RuntimeError('gateway 500')
        code, _ = _run(['ls'], _ENV, capsys)
    assert code == 3
