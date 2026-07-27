"""Blob lister + downloader for cloud-file ls/get.

Reuses the SAS issued by GET /api/cloud/sas (permissions racwl → read + list).
"""

import base64
import time
from typing import TYPE_CHECKING

from azure.core.exceptions import HttpResponseError
from azure.storage.blob import BlobClient, ContainerClient

if TYPE_CHECKING:
    from cloud_file.sas_cache import SasCache

_MAX_RETRIES = 3
_INITIAL_BACKOFF_SECONDS = 1.0


def _b64_decode(s: str | None) -> str | None:
    if not s:
        return None
    try:
        return base64.b64decode(s).decode('utf-8')
    except Exception:
        return None


def list_files(sas: dict, sub_prefix: str = '') -> list[dict]:
    """Flat-recursive list of all blobs under the user's prefix.

    Returns a list of dicts: virtual_path, size, last_modified, content_type,
    source, title. `sub_prefix` (e.g. 'reports/') narrows the listing.
    """
    user_prefix = sas.get('prefix', '')  # "<user_id>/"
    container_url = f"{sas['blob_endpoint']}/{sas['container']}?{sas['sas_token']}"
    client = ContainerClient.from_container_url(container_url)
    full_prefix = f'{user_prefix}{sub_prefix}'

    out: list[dict] = []
    for blob in client.list_blobs(name_starts_with=full_prefix, include=['metadata']):
        rel = blob.name[len(user_prefix):]
        meta = blob.metadata or {}
        ct = blob.content_settings.content_type if blob.content_settings else None
        out.append({
            'virtual_path': rel,
            'size': blob.size,
            'last_modified': blob.last_modified.isoformat() if blob.last_modified else None,
            'content_type': ct,
            'source': meta.get('source', 'agent'),
            'title': _b64_decode(meta.get('title')) or rel.split('/')[-1],
        })
    return out


def _blob_url(sas: dict, virtual_path: str) -> str:
    blob_name = f"{sas.get('prefix', '')}{virtual_path}"
    return f"{sas['blob_endpoint']}/{sas['container']}/{blob_name}?{sas['sas_token']}"


def _download_once(blob_url: str, output_path: str) -> int:
    client = BlobClient.from_blob_url(blob_url)
    data = client.download_blob().readall()
    with open(output_path, 'wb') as fh:
        fh.write(data)
    return len(data)


def download_file(
    sas: dict,
    virtual_path: str,
    output_path: str,
    sas_cache: 'SasCache | None' = None,
) -> int:
    """Download a single blob to output_path; return bytes written.

    Retries 3x on 5xx (backoff 1/2/4 s). 403 → force-refresh SAS once.
    404 → FileNotFoundError. Non-retryable 4xx propagate.
    """
    blob_url = _blob_url(sas, virtual_path)
    backoff = _INITIAL_BACKOFF_SECONDS
    last_exc: Exception | None = None

    for attempt in range(_MAX_RETRIES + 1):
        try:
            return _download_once(blob_url, output_path)
        except HttpResponseError as exc:
            status = exc.status_code if exc.status_code is not None else 0

            if status == 404:
                raise FileNotFoundError(f'blob not found: {virtual_path}') from exc

            if status == 403:
                if sas_cache is not None:
                    sas = sas_cache.force_refresh()
                    blob_url = _blob_url(sas, virtual_path)
                    try:
                        return _download_once(blob_url, output_path)
                    except HttpResponseError as retry_exc:
                        raise RuntimeError(
                            f'Download failed after SAS force-refresh: {retry_exc}'
                        ) from retry_exc
                raise RuntimeError(f'Download 403 (no SAS cache to refresh): {exc}') from exc

            if 500 <= status < 600:
                last_exc = exc
                if attempt < _MAX_RETRIES:
                    time.sleep(backoff)
                    backoff *= 2
                continue

            raise

    raise RuntimeError(f'Download failed after {_MAX_RETRIES} retries: {last_exc}') from last_exc
