"""Unit tests for cloud_publish.uploader."""

import pathlib
import unittest.mock as mock

import pytest
from azure.core.exceptions import HttpResponseError

from cloud_publish.uploader import upload_blob


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

_SAS = {
    'blob_endpoint': 'https://laifuprod.blob.core.windows.net',
    'container': 'laifu-cloud',
    'prefix': 'user123/',
    'sas_token': 'sv=2024&sig=abc',
}

_BLOB_NAME = 'user123/reports/sales.pdf'
_METADATA = {'title': 'dGl0bGU=', 'published_at': '2026-06-01T00:00:00+00:00'}
_CONTENT_TYPE = 'application/pdf'


@pytest.fixture
def tmp_file(tmp_path):
    p = tmp_path / 'sales.pdf'
    p.write_bytes(b'%PDF-1.4 fake content')
    return p


def _http_error(status: int) -> HttpResponseError:
    exc = HttpResponseError(message=f'HTTP {status}')
    exc.status_code = status
    return exc


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestHappyPath:
    def test_returns_url_without_sas(self, tmp_file):
        with mock.patch('cloud_publish.uploader.BlobClient') as MockClient:
            instance = MockClient.from_blob_url.return_value
            instance.upload_blob.return_value = None

            url = upload_blob(
                sas=_SAS,
                blob_name=_BLOB_NAME,
                file_path=tmp_file,
                metadata=_METADATA,
                content_type=_CONTENT_TYPE,
            )

        expected_url = (
            'https://laifuprod.blob.core.windows.net/laifu-cloud/user123/reports/sales.pdf'
        )
        assert url == expected_url

    def test_upload_called_once(self, tmp_file):
        with mock.patch('cloud_publish.uploader.BlobClient') as MockClient:
            instance = MockClient.from_blob_url.return_value
            instance.upload_blob.return_value = None

            upload_blob(_SAS, _BLOB_NAME, tmp_file, _METADATA, _CONTENT_TYPE)

        instance.upload_blob.assert_called_once()


class Test403ForceRefresh:
    def test_403_triggers_force_refresh_then_succeeds(self, tmp_file):
        with mock.patch('cloud_publish.uploader.BlobClient') as MockClient:
            instance = MockClient.from_blob_url.return_value
            # First call raises 403, second succeeds
            instance.upload_blob.side_effect = [
                _http_error(403),
                None,
            ]

            sas_cache = mock.MagicMock()
            new_sas = {**_SAS, 'sas_token': 'sv=2024&sig=new'}
            sas_cache.force_refresh.return_value = new_sas

            url = upload_blob(
                sas=_SAS,
                blob_name=_BLOB_NAME,
                file_path=tmp_file,
                metadata=_METADATA,
                content_type=_CONTENT_TYPE,
                sas_cache=sas_cache,
            )

        sas_cache.force_refresh.assert_called_once()
        assert url.startswith('https://laifuprod.blob.core.windows.net/laifu-cloud/')

    def test_403_without_sas_cache_raises(self, tmp_file):
        with mock.patch('cloud_publish.uploader.BlobClient') as MockClient:
            instance = MockClient.from_blob_url.return_value
            instance.upload_blob.side_effect = _http_error(403)

            with pytest.raises(RuntimeError, match='403'):
                upload_blob(_SAS, _BLOB_NAME, tmp_file, _METADATA, _CONTENT_TYPE)

    def test_403_after_refresh_raises(self, tmp_file):
        with mock.patch('cloud_publish.uploader.BlobClient') as MockClient:
            instance = MockClient.from_blob_url.return_value
            instance.upload_blob.side_effect = _http_error(403)  # both calls fail

            sas_cache = mock.MagicMock()
            sas_cache.force_refresh.return_value = _SAS

            with pytest.raises(RuntimeError):
                upload_blob(
                    _SAS, _BLOB_NAME, tmp_file, _METADATA, _CONTENT_TYPE,
                    sas_cache=sas_cache,
                )


class Test5xxRetry:
    def test_succeeds_on_third_attempt(self, tmp_file):
        with mock.patch('cloud_publish.uploader.BlobClient') as MockClient, \
             mock.patch('cloud_publish.uploader.time.sleep'):
            instance = MockClient.from_blob_url.return_value
            instance.upload_blob.side_effect = [
                _http_error(500),
                _http_error(503),
                None,  # success on 3rd attempt (index 2)
            ]

            url = upload_blob(_SAS, _BLOB_NAME, tmp_file, _METADATA, _CONTENT_TYPE)

        assert instance.upload_blob.call_count == 3
        assert url.startswith('https://laifuprod.blob.core.windows.net/')

    def test_raises_after_all_retries_exhausted(self, tmp_file):
        with mock.patch('cloud_publish.uploader.BlobClient') as MockClient, \
             mock.patch('cloud_publish.uploader.time.sleep'):
            instance = MockClient.from_blob_url.return_value
            instance.upload_blob.side_effect = _http_error(500)  # always 500

            with pytest.raises(RuntimeError, match='retries'):
                upload_blob(_SAS, _BLOB_NAME, tmp_file, _METADATA, _CONTENT_TYPE)

        # 4 total attempts: initial + 3 retries
        assert instance.upload_blob.call_count == 4

    def test_exponential_backoff_sleep_calls(self, tmp_file):
        with mock.patch('cloud_publish.uploader.BlobClient') as MockClient, \
             mock.patch('cloud_publish.uploader.time.sleep') as mock_sleep:
            instance = MockClient.from_blob_url.return_value
            instance.upload_blob.side_effect = _http_error(500)

            with pytest.raises(RuntimeError):
                upload_blob(_SAS, _BLOB_NAME, tmp_file, _METADATA, _CONTENT_TYPE)

        sleep_calls = [c.args[0] for c in mock_sleep.call_args_list]
        # Should be 1, 2, 4 (three retries)
        assert sleep_calls == [1.0, 2.0, 4.0]


class TestNonRetryableErrors:
    def test_400_raises_immediately(self, tmp_file):
        with mock.patch('cloud_publish.uploader.BlobClient') as MockClient, \
             mock.patch('cloud_publish.uploader.time.sleep') as mock_sleep:
            instance = MockClient.from_blob_url.return_value
            instance.upload_blob.side_effect = _http_error(400)

            with pytest.raises(HttpResponseError):
                upload_blob(_SAS, _BLOB_NAME, tmp_file, _METADATA, _CONTENT_TYPE)

        assert instance.upload_blob.call_count == 1
        mock_sleep.assert_not_called()

    def test_404_raises_immediately(self, tmp_file):
        with mock.patch('cloud_publish.uploader.BlobClient') as MockClient, \
             mock.patch('cloud_publish.uploader.time.sleep') as mock_sleep:
            instance = MockClient.from_blob_url.return_value
            instance.upload_blob.side_effect = _http_error(404)

            with pytest.raises(HttpResponseError):
                upload_blob(_SAS, _BLOB_NAME, tmp_file, _METADATA, _CONTENT_TYPE)

        assert instance.upload_blob.call_count == 1
