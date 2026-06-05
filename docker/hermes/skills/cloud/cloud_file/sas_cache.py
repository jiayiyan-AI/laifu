"""SAS token cache for cloud-publish.

Reads / refreshes a cached SAS from ~/.hermes/_cloud_sas.json.
Calls GET ${GATEWAY_BASE_URL}/api/cloud/sas if the cache is missing
or expires within 60 seconds.

Uses only stdlib (urllib.request) to avoid extra dependencies.
"""

import json
import pathlib
import urllib.request
import urllib.error
import datetime


class AuthError(Exception):
    """Raised when the gateway returns 401 (JWT expired / invalid)."""


class SasCache:
    _REFRESH_MARGIN_SECONDS = 60  # refresh when expires_at is < this many seconds away

    def __init__(self, path: pathlib.Path, gateway_base_url: str, jwt: str) -> None:
        self._path = path
        self._gateway_base_url = gateway_base_url.rstrip('/')
        self._jwt = jwt

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get(self) -> dict:
        """Return SAS dict, reading from cache if still fresh enough.

        Keys: blob_endpoint, container, prefix, sas_token, expires_at.
        Fetches fresh token from gateway and writes cache if:
        - cache file does not exist, or
        - expires_at < now + 60 s.
        """
        cached = self._read_cache()
        if cached is not None and self._is_fresh(cached):
            return cached
        return self._fetch_and_store()

    def force_refresh(self) -> dict:
        """Always fetch a fresh SAS (use after a 403 response)."""
        return self._fetch_and_store()

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _read_cache(self) -> dict | None:
        try:
            with open(self._path, 'r', encoding='utf-8') as fh:
                return json.load(fh)
        except (FileNotFoundError, json.JSONDecodeError):
            return None

    def _is_fresh(self, sas: dict) -> bool:
        try:
            expires_at_str = sas['expires_at']
            # Support both 'Z' suffix and '+00:00' suffix
            expires_at_str = expires_at_str.replace('Z', '+00:00')
            expires_at = datetime.datetime.fromisoformat(expires_at_str)
            now = datetime.datetime.now(datetime.timezone.utc)
            return (expires_at - now).total_seconds() >= self._REFRESH_MARGIN_SECONDS
        except (KeyError, ValueError):
            return False

    def _fetch_and_store(self) -> dict:
        url = f'{self._gateway_base_url}/api/cloud/sas'
        req = urllib.request.Request(
            url,
            headers={'Authorization': f'Bearer {self._jwt}'},
        )
        try:
            with urllib.request.urlopen(req) as resp:
                body = resp.read()
                sas = json.loads(body)
        except urllib.error.HTTPError as exc:
            if exc.code == 401:
                raise AuthError(
                    f'Gateway returned 401 — JWT expired or invalid (url={url})'
                ) from exc
            raise RuntimeError(
                f'Gateway returned HTTP {exc.code} fetching SAS (url={url})'
            ) from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(
                f'Network error fetching SAS from {url}: {exc.reason}'
            ) from exc

        self._write_cache(sas)
        return sas

    def _write_cache(self, sas: dict) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with open(self._path, 'w', encoding='utf-8') as fh:
            json.dump(sas, fh)
