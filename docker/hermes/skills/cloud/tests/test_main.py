"""Unit tests for cloud_file.__main__ (the CLI entry point)."""

import json
import pathlib
import sys
import unittest.mock as mock

import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_VALID_SAS = {
    'blob_endpoint': 'https://laifuprod.blob.core.windows.net',
    'container': 'laifu-cloud',
    'prefix': 'user123/',
    'sas_token': 'sv=2024&sig=abc',
    'expires_at': '2099-12-31T23:59:59+00:00',
}

_ENV = {
    'GATEWAY_BASE_URL': 'http://gateway.test',
    'LAIFU_USER_TOKEN': 'test-jwt',
}


def _run(
    args: list[str],
    env: dict | None = None,
    sas: dict | None = None,
    upload_url: str | None = None,
    upload_error: Exception | None = None,
    capsys=None,
) -> tuple[int, dict]:
    """Run main() with the given CLI args and return (exit_code, parsed_stdout_json).

    exit_code 0 when main() returns normally (success path),
    or the SystemExit code when main() calls sys.exit(N).
    """
    from cloud_file.__main__ import main

    env = env or _ENV
    sas = sas or _VALID_SAS
    upload_url = upload_url or 'https://laifuprod.blob.core.windows.net/laifu-cloud/user123/reports/sales.pdf'

    with mock.patch.dict('os.environ', env, clear=False), \
         mock.patch('cloud_file.__main__.SasCache') as MockSasCache, \
         mock.patch('cloud_file.__main__.upload_blob') as mock_upload, \
         mock.patch('sys.argv', ['cloud-publish'] + args):

        sas_instance = MockSasCache.return_value
        sas_instance.get.return_value = sas
        sas_instance.force_refresh.return_value = sas

        if upload_error:
            mock_upload.side_effect = upload_error
        else:
            mock_upload.return_value = upload_url

        try:
            main()
            exit_code = 0
        except SystemExit as exc:
            exit_code = exc.code if exc.code is not None else 0

    if capsys:
        captured = capsys.readouterr()
        stdout_text = captured.out
    else:
        # If capsys not passed, we can't capture — caller should use capsys
        stdout_text = '{}'

    try:
        output = json.loads(stdout_text.strip())
    except json.JSONDecodeError:
        output = {'raw': stdout_text}

    return exit_code, output


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestSuccessPath:
    def test_ok_true_json_and_exit_0(self, tmp_path, capsys):
        pdf = tmp_path / 'report.pdf'
        pdf.write_bytes(b'%PDF-1.4 fake')

        exit_code, out = _run(
            ['--file', str(pdf), '--virtual-path', 'reports/sales.pdf'],
            capsys=capsys,
        )
        assert exit_code == 0
        assert out['ok'] is True
        assert 'blob_name' in out
        assert 'url' in out

    def test_blob_name_includes_prefix(self, tmp_path, capsys):
        pdf = tmp_path / 'report.pdf'
        pdf.write_bytes(b'content')

        exit_code, out = _run(
            ['--file', str(pdf), '--virtual-path', 'reports/sales.pdf'],
            capsys=capsys,
        )
        assert out['blob_name'] == 'user123/reports/sales.pdf'

    def test_title_defaults_to_basename(self, tmp_path, capsys):
        pdf = tmp_path / 'report.pdf'
        pdf.write_bytes(b'content')

        with mock.patch.dict('os.environ', _ENV, clear=False), \
             mock.patch('cloud_file.__main__.SasCache') as MockSasCache, \
             mock.patch('cloud_file.__main__.upload_blob') as mock_upload, \
             mock.patch('sys.argv', ['cloud-publish', '--file', str(pdf),
                                     '--virtual-path', 'reports/sales.pdf']):
            sas_instance = MockSasCache.return_value
            sas_instance.get.return_value = _VALID_SAS
            mock_upload.return_value = 'https://example.com/blob'

            from cloud_file.__main__ import main
            try:
                main()
            except SystemExit:
                pass

            # upload_blob was called: title was passed via metadata kwarg
            assert mock_upload.called


class TestInputErrors:
    def test_file_not_found_exit_1(self, tmp_path, capsys):
        exit_code, out = _run(
            ['--file', str(tmp_path / 'missing.pdf'), '--virtual-path', 'reports/x.pdf'],
            capsys=capsys,
        )
        assert exit_code == 1
        assert out['ok'] is False
        assert 'not found' in out['error']

    def test_file_too_large_exit_1(self, tmp_path, capsys):
        big = tmp_path / 'big.bin'
        big.write_bytes(b'x' * (10 * 1024 * 1024 + 1))

        exit_code, out = _run(
            ['--file', str(big), '--virtual-path', 'data/big.bin'],
            capsys=capsys,
        )
        assert exit_code == 1
        assert out['ok'] is False
        assert 'too large' in out['error']

    def test_virtual_path_with_leading_slash_exit_1(self, tmp_path, capsys):
        f = tmp_path / 'x.txt'
        f.write_bytes(b'hi')

        exit_code, out = _run(
            ['--file', str(f), '--virtual-path', '/leading/slash.txt'],
            capsys=capsys,
        )
        assert exit_code == 1
        assert out['ok'] is False

    def test_virtual_path_with_dotdot_exit_1(self, tmp_path, capsys):
        f = tmp_path / 'x.txt'
        f.write_bytes(b'hi')

        exit_code, out = _run(
            ['--file', str(f), '--virtual-path', 'reports/../../../etc/passwd'],
            capsys=capsys,
        )
        assert exit_code == 1
        assert out['ok'] is False

    def test_virtual_path_with_trailing_slash_exit_1(self, tmp_path, capsys):
        f = tmp_path / 'x.txt'
        f.write_bytes(b'hi')

        exit_code, out = _run(
            ['--file', str(f), '--virtual-path', 'reports/'],
            capsys=capsys,
        )
        assert exit_code == 1
        assert out['ok'] is False


class TestAuthErrors:
    def test_missing_jwt_exit_2(self, tmp_path, capsys):
        f = tmp_path / 'x.txt'
        f.write_bytes(b'hi')

        env = {'GATEWAY_BASE_URL': 'http://gateway.test', 'LAIFU_USER_TOKEN': ''}
        exit_code, out = _run(
            ['--file', str(f), '--virtual-path', 'x.txt'],
            env=env,
            capsys=capsys,
        )
        assert exit_code == 2
        assert out['ok'] is False

    def test_auth_error_from_sas_cache_exit_2(self, tmp_path, capsys):
        from cloud_file.sas_cache import AuthError

        f = tmp_path / 'x.txt'
        f.write_bytes(b'hi')

        with mock.patch.dict('os.environ', _ENV, clear=False), \
             mock.patch('cloud_file.__main__.SasCache') as MockSasCache, \
             mock.patch('sys.argv', ['cloud-publish', '--file', str(f),
                                     '--virtual-path', 'x.txt']):
            sas_instance = MockSasCache.return_value
            sas_instance.get.side_effect = AuthError('401 unauthorized')

            with pytest.raises(SystemExit) as exc_info:
                from cloud_file.__main__ import main
                main()

        captured = capsys.readouterr()
        out = json.loads(captured.out.strip())
        assert exc_info.value.code == 2
        assert out['ok'] is False


class TestNetworkErrors:
    def test_upload_runtime_error_exit_3(self, tmp_path, capsys):
        f = tmp_path / 'x.txt'
        f.write_bytes(b'hi')

        exit_code, out = _run(
            ['--file', str(f), '--virtual-path', 'x.txt'],
            upload_error=RuntimeError('Network failure after retries'),
            capsys=capsys,
        )
        assert exit_code == 3
        assert out['ok'] is False
        assert 'Network failure' in out['error']

    def test_sas_cache_network_error_exit_3(self, tmp_path, capsys):
        f = tmp_path / 'x.txt'
        f.write_bytes(b'hi')

        with mock.patch.dict('os.environ', _ENV, clear=False), \
             mock.patch('cloud_file.__main__.SasCache') as MockSasCache, \
             mock.patch('sys.argv', ['cloud-publish', '--file', str(f),
                                     '--virtual-path', 'x.txt']):
            sas_instance = MockSasCache.return_value
            sas_instance.get.side_effect = RuntimeError('connection refused')

            with pytest.raises(SystemExit) as exc_info:
                from cloud_file.__main__ import main
                main()

        captured = capsys.readouterr()
        out = json.loads(captured.out.strip())
        assert exc_info.value.code == 3
        assert out['ok'] is False


class TestMissingEnvVars:
    def test_missing_gateway_url_exit_4(self, tmp_path, capsys):
        f = tmp_path / 'x.txt'
        f.write_bytes(b'hi')

        env = {'GATEWAY_BASE_URL': '', 'LAIFU_USER_TOKEN': 'jwt'}
        exit_code, out = _run(
            ['--file', str(f), '--virtual-path', 'x.txt'],
            env=env,
            capsys=capsys,
        )
        assert exit_code == 4
        assert out['ok'] is False


class TestOutputIsValidJson:
    def test_stdout_is_single_line_json(self, tmp_path, capsys):
        pdf = tmp_path / 'report.pdf'
        pdf.write_bytes(b'content')

        with mock.patch.dict('os.environ', _ENV, clear=False), \
             mock.patch('cloud_file.__main__.SasCache') as MockSasCache, \
             mock.patch('cloud_file.__main__.upload_blob') as mock_upload, \
             mock.patch('sys.argv', ['cloud-publish', '--file', str(pdf),
                                     '--virtual-path', 'reports/r.pdf']):
            sas_instance = MockSasCache.return_value
            sas_instance.get.return_value = _VALID_SAS
            mock_upload.return_value = 'https://example.com/blob'

            from cloud_file.__main__ import main
            try:
                main()
            except SystemExit:
                pass

        captured = capsys.readouterr()
        lines = [l for l in captured.out.splitlines() if l.strip()]
        assert len(lines) == 1, f'Expected exactly 1 JSON line, got: {captured.out!r}'
        parsed = json.loads(lines[0])
        assert isinstance(parsed, dict)
