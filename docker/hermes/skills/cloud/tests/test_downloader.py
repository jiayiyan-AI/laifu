"""Unit tests for cloud_publish.downloader."""
import unittest.mock as mock
import datetime

import pytest
from azure.core.exceptions import HttpResponseError

from cloud_publish.downloader import list_files, download_file

_SAS = {
    'blob_endpoint': 'https://laifuprod.blob.core.windows.net',
    'container': 'laifu-cloud',
    'prefix': 'user123/',
    'sas_token': 'sv=2024&sig=abc',
}


def _http_error(status: int) -> HttpResponseError:
    exc = HttpResponseError(message=f'HTTP {status}')
    exc.status_code = status
    return exc


def _fake_blob(name, size, title_b64=None, source=None, ct='text/csv'):
    b = mock.MagicMock()
    b.name = name
    b.size = size
    b.last_modified = datetime.datetime(2026, 6, 4, tzinfo=datetime.timezone.utc)
    b.content_settings = mock.MagicMock(content_type=ct)
    meta = {}
    if title_b64:
        meta['title'] = title_b64
    if source:
        meta['source'] = source
    b.metadata = meta
    return b


class TestListFiles:
    def test_strips_user_prefix_and_decodes_title(self):
        import base64
        title_b64 = base64.b64encode('销售'.encode()).decode()
        with mock.patch('cloud_publish.downloader.ContainerClient') as MockCC:
            inst = MockCC.from_container_url.return_value
            inst.list_blobs.return_value = [
                _fake_blob('user123/reports/q2.pdf', 100, title_b64, source='web'),
            ]
            out = list_files(_SAS)
        assert out[0]['virtual_path'] == 'reports/q2.pdf'
        assert out[0]['title'] == '销售'
        assert out[0]['source'] == 'web'
        assert out[0]['size'] == 100

    def test_source_defaults_to_agent(self):
        with mock.patch('cloud_publish.downloader.ContainerClient') as MockCC:
            inst = MockCC.from_container_url.return_value
            inst.list_blobs.return_value = [_fake_blob('user123/a.txt', 1)]
            out = list_files(_SAS)
        assert out[0]['source'] == 'agent'

    def test_passes_full_prefix_to_list_blobs(self):
        with mock.patch('cloud_publish.downloader.ContainerClient') as MockCC:
            inst = MockCC.from_container_url.return_value
            inst.list_blobs.return_value = []
            list_files(_SAS, sub_prefix='reports/')
        kwargs = inst.list_blobs.call_args.kwargs
        assert kwargs['name_starts_with'] == 'user123/reports/'

    def test_title_falls_back_to_basename_when_no_metadata(self):
        with mock.patch('cloud_publish.downloader.ContainerClient') as MockCC:
            inst = MockCC.from_container_url.return_value
            inst.list_blobs.return_value = [_fake_blob('user123/reports/q2.pdf', 5)]
            out = list_files(_SAS)
        assert out[0]['title'] == 'q2.pdf'


class TestDownloadFile:
    def test_writes_file_and_returns_size(self, tmp_path):
        out = tmp_path / 'q2.pdf'
        with mock.patch('cloud_publish.downloader.BlobClient') as MockBC:
            inst = MockBC.from_blob_url.return_value
            inst.download_blob.return_value.readall.return_value = b'hello-bytes'
            size = download_file(_SAS, 'reports/q2.pdf', str(out))
        assert out.read_bytes() == b'hello-bytes'
        assert size == len(b'hello-bytes')

    def test_404_raises_filenotfound(self, tmp_path):
        with mock.patch('cloud_publish.downloader.BlobClient') as MockBC:
            inst = MockBC.from_blob_url.return_value
            inst.download_blob.side_effect = _http_error(404)
            with pytest.raises(FileNotFoundError):
                download_file(_SAS, 'missing.pdf', str(tmp_path / 'x'))

    def test_403_force_refresh_then_succeeds(self, tmp_path):
        out = tmp_path / 'q2.pdf'
        with mock.patch('cloud_publish.downloader.BlobClient') as MockBC:
            inst = MockBC.from_blob_url.return_value
            inst.download_blob.side_effect = [
                _http_error(403),
                mock.MagicMock(readall=mock.MagicMock(return_value=b'ok')),
            ]
            sas_cache = mock.MagicMock()
            sas_cache.force_refresh.return_value = {**_SAS, 'sas_token': 'sv=2024&sig=new'}
            size = download_file(_SAS, 'reports/q2.pdf', str(out), sas_cache=sas_cache)
        sas_cache.force_refresh.assert_called_once()
        assert out.read_bytes() == b'ok'
        assert size == 2
        # 验证刷新后的 SAS 真的被用于重建 URL（第二次 from_blob_url 用新 token）
        second_url = MockBC.from_blob_url.call_args_list[1].args[0]
        assert 'sig=new' in second_url

    def test_403_without_sas_cache_raises(self, tmp_path):
        with mock.patch('cloud_publish.downloader.BlobClient') as MockBC:
            inst = MockBC.from_blob_url.return_value
            inst.download_blob.side_effect = _http_error(403)
            with pytest.raises(RuntimeError, match='403'):
                download_file(_SAS, 'x.pdf', str(tmp_path / 'x'))

    def test_5xx_retries_then_raises(self, tmp_path):
        with mock.patch('cloud_publish.downloader.BlobClient') as MockBC, \
             mock.patch('cloud_publish.downloader.time.sleep') as mock_sleep:
            inst = MockBC.from_blob_url.return_value
            inst.download_blob.side_effect = _http_error(500)
            with pytest.raises(RuntimeError, match='retries'):
                download_file(_SAS, 'x.pdf', str(tmp_path / 'x'))
        assert inst.download_blob.call_count == 4  # initial + 3 retries
        assert [c.args[0] for c in mock_sleep.call_args_list] == [1.0, 2.0, 4.0]
