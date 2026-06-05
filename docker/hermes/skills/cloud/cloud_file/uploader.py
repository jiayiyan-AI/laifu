"""Blob uploader for cloud-file put.

Wraps azure-storage-blob's BlobClient with:
- 3 retries (1 s / 2 s / 4 s) on 5xx HTTP errors
- One force-refresh + retry on 403 (expired SAS)
- Returns the blob URL without the SAS query string on success
"""

import pathlib
import time
from typing import TYPE_CHECKING

from azure.core.exceptions import HttpResponseError
from azure.storage.blob import BlobClient, ContentSettings

if TYPE_CHECKING:
    from cloud_file.sas_cache import SasCache


_MAX_RETRIES = 3
_INITIAL_BACKOFF_SECONDS = 1.0


def _build_blob_url(sas: dict, blob_name: str) -> str:
    return (
        f"{sas['blob_endpoint']}/{sas['container']}/{blob_name}"
        f"?{sas['sas_token']}"
    )


def _blob_url_without_sas(sas: dict, blob_name: str) -> str:
    return f"{sas['blob_endpoint']}/{sas['container']}/{blob_name}"


def _do_upload(
    blob_url: str,
    file_path: pathlib.Path,
    metadata: dict[str, str],
    content_type: str | None,
) -> None:
    """Single upload attempt; raises HttpResponseError on HTTP failure."""
    client = BlobClient.from_blob_url(blob_url)
    content_settings = ContentSettings(
        content_type=content_type or 'application/octet-stream'
    )
    with open(file_path, 'rb') as fh:
        client.upload_blob(
            fh,
            overwrite=True,
            metadata=metadata,
            content_settings=content_settings,
        )


def upload_blob(
    sas: dict,
    blob_name: str,
    file_path: pathlib.Path,
    metadata: dict[str, str],
    content_type: str | None = None,
    sas_cache: 'SasCache | None' = None,
) -> str:
    """Upload file to Azure Blob; return the blob URL (without SAS).

    Retries 3 times on 5xx errors with exponential backoff (1 s, 2 s, 4 s).
    On 403, force-refreshes the SAS once and retries.
    Non-retryable errors (e.g. 400) propagate immediately.
    """
    blob_url = _build_blob_url(sas, blob_name)
    backoff = _INITIAL_BACKOFF_SECONDS
    last_exc: Exception | None = None

    for attempt in range(_MAX_RETRIES + 1):  # attempts 0, 1, 2, 3
        try:
            _do_upload(blob_url, file_path, metadata, content_type)
            return _blob_url_without_sas(sas, blob_name)

        except HttpResponseError as exc:
            status = exc.status_code if exc.status_code is not None else 0

            if status == 403:
                # SAS expired mid-flight — try force-refresh once then give up
                if sas_cache is not None:
                    sas = sas_cache.force_refresh()
                    blob_url = _build_blob_url(sas, blob_name)
                    try:
                        _do_upload(blob_url, file_path, metadata, content_type)
                        return _blob_url_without_sas(sas, blob_name)
                    except HttpResponseError as retry_exc:
                        raise RuntimeError(
                            f'Upload failed after SAS force-refresh: {retry_exc}'
                        ) from retry_exc
                raise RuntimeError(f'Upload 403 (no SAS cache to refresh): {exc}') from exc

            if 500 <= status < 600:
                # Server error — retry with backoff
                last_exc = exc
                if attempt < _MAX_RETRIES:
                    time.sleep(backoff)
                    backoff *= 2
                continue

            # Non-retryable (4xx that isn't 403, etc.)
            raise

    raise RuntimeError(
        f'Upload failed after {_MAX_RETRIES} retries: {last_exc}'
    ) from last_exc
