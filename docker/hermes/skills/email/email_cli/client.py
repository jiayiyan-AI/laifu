"""Gateway HTTP client for the email CLI.

只用 stdlib urllib(与 cloud_file.sas_cache 同风格,避免额外依赖)。
调 gateway /api/email/* 端点,Bearer = LAIFU_USER_TOKEN。
"""
from __future__ import annotations

import json
import urllib.parse
import urllib.request
import urllib.error


class AuthError(Exception):
    """Gateway 返回 401(token 失效/无效)。"""


class GatewayError(Exception):
    """Gateway 返回非 2xx(401 除外)。带 status + body。"""

    def __init__(self, status: int, body: str) -> None:
        super().__init__(f'gateway HTTP {status}: {body}')
        self.status = status
        self.body = body


class NetworkError(Exception):
    """连不上 gateway(URLError)。"""


class GatewayClient:
    def __init__(self, base_url: str, jwt: str) -> None:
        self._base = base_url.rstrip('/')
        self._jwt = jwt

    def get(self, path: str, params: dict | None = None) -> dict:
        url = f'{self._base}{path}'
        if params:
            clean = {k: v for k, v in params.items() if v is not None}
            if clean:
                url = f'{url}?{urllib.parse.urlencode(clean)}'
        return self._request('GET', url, data=None)

    def post(self, path: str, payload: dict) -> dict:
        url = f'{self._base}{path}'
        data = json.dumps(payload).encode('utf-8')
        return self._request('POST', url, data=data)

    def _request(self, method: str, url: str, data: bytes | None) -> dict:
        headers = {'Authorization': f'Bearer {self._jwt}'}
        if data is not None:
            headers['Content-Type'] = 'application/json'
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req) as resp:
                body = resp.read()
            return json.loads(body) if body else {}
        except urllib.error.HTTPError as exc:
            detail = ''
            try:
                detail = exc.read().decode('utf-8', 'replace')
            except Exception:
                pass
            if exc.code == 401:
                raise AuthError(f'Gateway 401 — token expired/invalid (url={url})') from exc
            raise GatewayError(exc.code, detail) from exc
        except urllib.error.URLError as exc:
            raise NetworkError(f'Network error to {url}: {exc.reason}') from exc
