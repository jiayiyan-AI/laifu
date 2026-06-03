"""Unit tests for cloud_publish.sas_cache."""

import datetime
import json
import pathlib
import urllib.error
import io

import pytest

from cloud_publish.sas_cache import SasCache, AuthError


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

_VALID_SAS = {
    'sas_token': 'sv=2024&sig=abc',
    'blob_endpoint': 'https://laifuprod.blob.core.windows.net',
    'container': 'laifu-cloud',
    'prefix': '6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f/',
    'expires_at': '2099-12-31T23:59:59+00:00',  # far future = always fresh
}


def _expired_sas(seconds_until_expiry: int = 30) -> dict:
    expires_at = (
        datetime.datetime.now(datetime.timezone.utc)
        + datetime.timedelta(seconds=seconds_until_expiry)
    ).isoformat(timespec='seconds')
    s = dict(_VALID_SAS)
    s['expires_at'] = expires_at
    return s


def _make_cache(tmp_path: pathlib.Path, sas: dict | None = None) -> pathlib.Path:
    p = tmp_path / '_cloud_sas.json'
    if sas is not None:
        p.write_text(json.dumps(sas), encoding='utf-8')
    return p


def _make_sas_cache(
    cache_path: pathlib.Path,
    fetch_return: dict | None = None,
    fetch_error: Exception | None = None,
) -> SasCache:
    sc = SasCache(
        path=cache_path,
        gateway_base_url='http://gateway.test',
        jwt='test-jwt',
    )
    # Monkey-patch the private HTTP fetch to avoid real network calls
    if fetch_error is not None:
        def _fake_fetch():
            raise fetch_error
    else:
        def _fake_fetch():
            return fetch_return or _VALID_SAS  # type: ignore[return-value]

    sc._fetch_and_store = lambda: (  # type: ignore[method-assign]
        (_ := _fake_fetch(), sc._write_cache(_), _)[2]
    )
    return sc


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestGetNoCacheFile:
    def test_calls_http_and_writes_cache(self, tmp_path):
        cache_path = tmp_path / '_cloud_sas.json'
        fetched = dict(_VALID_SAS)
        sc = _make_sas_cache(cache_path, fetch_return=fetched)

        result = sc.get()

        assert result == fetched
        # Cache file should now exist
        assert cache_path.exists()
        assert json.loads(cache_path.read_text()) == fetched


class TestGetValidCache:
    def test_reads_without_http(self, tmp_path):
        cache_path = _make_cache(tmp_path, _VALID_SAS)
        called = []

        sc = SasCache(
            path=cache_path,
            gateway_base_url='http://gateway.test',
            jwt='test-jwt',
        )
        sc._fetch_and_store = lambda: called.append(1) or {}  # type: ignore[method-assign]

        result = sc.get()
        assert result == _VALID_SAS
        assert called == [], 'HTTP should not be called when cache is fresh'


class TestGetNearlyExpiredCache:
    def test_calls_http_and_refreshes(self, tmp_path):
        # expires_at is 30 s from now — within the 60 s margin
        near_expired = _expired_sas(seconds_until_expiry=30)
        cache_path = _make_cache(tmp_path, near_expired)

        fresh = dict(_VALID_SAS)
        sc = _make_sas_cache(cache_path, fetch_return=fresh)

        result = sc.get()
        assert result == fresh


class TestGetHttpFailure:
    def test_raises_on_network_error(self, tmp_path):
        cache_path = tmp_path / '_cloud_sas.json'  # no cache
        sc = _make_sas_cache(
            cache_path,
            fetch_error=RuntimeError('network down'),
        )
        with pytest.raises(RuntimeError):
            sc.get()


class TestGetHttp401:
    def test_raises_auth_error(self, tmp_path):
        cache_path = tmp_path / '_cloud_sas.json'  # no cache
        sc = _make_sas_cache(
            cache_path,
            fetch_error=AuthError('401 unauthorized'),
        )
        with pytest.raises(AuthError):
            sc.get()


class TestForceRefresh:
    def test_always_fetches(self, tmp_path):
        # Even with a fresh cache, force_refresh should call HTTP
        cache_path = _make_cache(tmp_path, _VALID_SAS)
        fresh_sas = {**_VALID_SAS, 'sas_token': 'sv=2024&sig=new'}
        fetch_calls = []

        sc = SasCache(
            path=cache_path,
            gateway_base_url='http://gateway.test',
            jwt='test-jwt',
        )

        def _fake_fetch():
            fetch_calls.append(1)
            return fresh_sas

        sc._fetch_and_store = lambda: (  # type: ignore[method-assign]
            (_ := _fake_fetch(), sc._write_cache(_), _)[2]
        )

        result = sc.force_refresh()
        assert result == fresh_sas
        assert len(fetch_calls) == 1


class TestRealHttpFetch:
    """Tests that exercise the real _fetch_and_store logic via urllib mocking."""

    def test_401_raises_auth_error(self, tmp_path, monkeypatch):
        cache_path = tmp_path / '_cloud_sas.json'
        sc = SasCache(
            path=cache_path,
            gateway_base_url='http://gateway.test',
            jwt='bad-jwt',
        )

        def _mock_urlopen(req):
            raise urllib.error.HTTPError(
                url=str(req.full_url), code=401,
                msg='Unauthorized', hdrs=None, fp=None  # type: ignore[arg-type]
            )

        monkeypatch.setattr('urllib.request.urlopen', _mock_urlopen)

        with pytest.raises(AuthError):
            sc._fetch_and_store()

    def test_500_raises_runtime_error(self, tmp_path, monkeypatch):
        cache_path = tmp_path / '_cloud_sas.json'
        sc = SasCache(
            path=cache_path,
            gateway_base_url='http://gateway.test',
            jwt='test-jwt',
        )

        def _mock_urlopen(req):
            raise urllib.error.HTTPError(
                url=str(req.full_url), code=500,
                msg='Internal Server Error', hdrs=None, fp=None  # type: ignore[arg-type]
            )

        monkeypatch.setattr('urllib.request.urlopen', _mock_urlopen)

        with pytest.raises(RuntimeError, match='500'):
            sc._fetch_and_store()

    def test_url_error_raises_runtime_error(self, tmp_path, monkeypatch):
        cache_path = tmp_path / '_cloud_sas.json'
        sc = SasCache(
            path=cache_path,
            gateway_base_url='http://gateway.test',
            jwt='test-jwt',
        )

        def _mock_urlopen(req):
            raise urllib.error.URLError(reason='Name or service not known')

        monkeypatch.setattr('urllib.request.urlopen', _mock_urlopen)

        with pytest.raises(RuntimeError, match='Network error'):
            sc._fetch_and_store()

    def test_success_writes_cache(self, tmp_path, monkeypatch):
        cache_path = tmp_path / '_cloud_sas.json'
        sc = SasCache(
            path=cache_path,
            gateway_base_url='http://gateway.test',
            jwt='test-jwt',
        )

        class _FakeResp:
            def read(self):
                return json.dumps(_VALID_SAS).encode()

            def __enter__(self):
                return self

            def __exit__(self, *_):
                pass

        monkeypatch.setattr('urllib.request.urlopen', lambda req: _FakeResp())

        result = sc._fetch_and_store()
        assert result == _VALID_SAS
        assert cache_path.exists()
