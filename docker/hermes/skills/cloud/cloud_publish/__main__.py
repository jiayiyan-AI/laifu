"""cloud-publish CLI entry point.

Usage:
  cloud-publish --file PATH --virtual-path PATH [--title TEXT]
                [--description TEXT] [--tags A,B,C]
                [--session-id TEXT] [--content-type MIME]

Stdout: one-line JSON
  success: {"ok": true, "blob_name": "<user_id>/<virtual-path>", "url": "..."}
  failure: {"ok": false, "error": "<message>"}

Exit codes:
  0  success
  1  input error (file missing, path invalid, size too large, metadata too large)
  2  auth failure (JWT expired / revoked / entitlement missing)
  3  network / upload failure (after retries)
  4  other error
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import pathlib
import re
import sys

from cloud_publish.sas_cache import SasCache, AuthError  # noqa: E402  (top-level for mockability)
from cloud_publish.metadata import build_metadata         # noqa: E402
from cloud_publish.uploader import upload_blob            # noqa: E402

_MAX_FILE_BYTES = 10 * 1024 * 1024   # 10 MB
_MAX_SEGMENT_LEN = 200
_MAX_PATH_LEN = 1024
_CONTROL_CHAR_RE = re.compile(r'[\x00-\x1f\x7f]')


# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

def _ok(blob_name: str, url: str) -> None:
    print(json.dumps({'ok': True, 'blob_name': blob_name, 'url': url}), flush=True)


def _fail(msg: str, code: int) -> None:
    print(json.dumps({'ok': False, 'error': msg}), flush=True)
    sys.exit(code)


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def _validate_virtual_path(vpath: str) -> None:
    """Raise ValueError if virtual_path is invalid."""
    if vpath.startswith('/'):
        raise ValueError("virtual-path must not start with '/'")
    if vpath.endswith('/'):
        raise ValueError("virtual-path must not end with '/'")
    if len(vpath) > _MAX_PATH_LEN:
        raise ValueError(
            f'virtual-path too long: {len(vpath)} chars > {_MAX_PATH_LEN}'
        )
    if _CONTROL_CHAR_RE.search(vpath):
        raise ValueError('virtual-path contains control characters')
    for segment in vpath.split('/'):
        if segment == '..':
            raise ValueError("virtual-path must not contain '..' segments")
        if not segment:
            raise ValueError('virtual-path must not contain empty segments (double slash)')
        if len(segment) > _MAX_SEGMENT_LEN:
            raise ValueError(
                f"virtual-path segment '{segment}' too long: "
                f'{len(segment)} chars > {_MAX_SEGMENT_LEN}'
            )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog='cloud-publish',
        description='Publish a local file to the user\'s laifu Cloud Drive.',
    )
    p.add_argument('--file', required=True, metavar='PATH', help='Local file path')
    p.add_argument(
        '--virtual-path', required=True, metavar='PATH',
        help='Cloud path (e.g. reports/2026-06/sales.pdf)'
    )
    p.add_argument('--title', default=None, help='Human-readable title (UTF-8 OK)')
    p.add_argument('--description', default=None, help='Short description (UTF-8 OK)')
    p.add_argument('--tags', default=None, help='Comma-separated tags')
    p.add_argument('--session-id', default=None, dest='session_id')
    p.add_argument('--content-type', default=None, dest='content_type',
                   help='MIME type; auto-detected from extension if omitted')
    return p


def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()

    # --- 1. Validate file -----------------------------------------------
    file_path = pathlib.Path(args.file)
    if not file_path.exists():
        _fail(f'file not found: {args.file}', 1)
    if not file_path.is_file():
        _fail(f'not a regular file: {args.file}', 1)
    file_size = file_path.stat().st_size
    if file_size > _MAX_FILE_BYTES:
        _fail(
            f'file too large: {file_size} bytes > {_MAX_FILE_BYTES} (10 MB limit)', 1
        )

    # --- 2. Validate virtual-path ----------------------------------------
    virtual_path: str = args.virtual_path
    try:
        _validate_virtual_path(virtual_path)
    except ValueError as exc:
        _fail(str(exc), 1)

    # --- 3. Read env vars ------------------------------------------------
    gateway_base_url = os.environ.get('GATEWAY_BASE_URL', '').strip()
    jwt = os.environ.get('LAIFU_USER_TOKEN', '').strip()
    env_session_id = os.environ.get('LAIFU_SESSION_ID', '').strip() or None

    if not gateway_base_url:
        _fail('GATEWAY_BASE_URL environment variable not set', 4)
    if not jwt:
        _fail('LAIFU_USER_TOKEN environment variable not set', 2)

    session_id = args.session_id or env_session_id

    # --- 4. SAS cache ----------------------------------------------------
    sas_cache_path = pathlib.Path.home() / '.hermes' / '_cloud_sas.json'
    sas_cache = SasCache(path=sas_cache_path, gateway_base_url=gateway_base_url, jwt=jwt)

    try:
        sas = sas_cache.get()
    except AuthError as exc:
        _fail(str(exc), 2)
    except Exception as exc:
        _fail(f'Failed to obtain SAS token: {exc}', 3)

    # --- 5. Build blob_name ----------------------------------------------
    prefix: str = sas.get('prefix', '')
    blob_name = f'{prefix}{virtual_path}'

    # --- 6. Title default ------------------------------------------------
    title = args.title or pathlib.PurePosixPath(virtual_path).name

    # --- 7. Content-type -------------------------------------------------
    content_type = args.content_type
    if not content_type:
        guessed, _ = mimetypes.guess_type(str(file_path))
        content_type = guessed  # may be None; uploader falls back to octet-stream

    # --- 8. Build metadata -----------------------------------------------
    tags_list: list[str] | None = None
    if args.tags:
        tags_list = [t.strip() for t in args.tags.split(',') if t.strip()]

    try:
        metadata = build_metadata(
            title=title,
            session_id=session_id,
            tool_version='0.1.0',
            description=args.description,
            tags=tags_list,
        )
    except ValueError as exc:
        _fail(str(exc), 1)

    # --- 9. Upload -------------------------------------------------------
    try:
        url = upload_blob(
            sas=sas,
            blob_name=blob_name,
            file_path=file_path,
            metadata=metadata,
            content_type=content_type,
            sas_cache=sas_cache,
        )
    except RuntimeError as exc:
        _fail(str(exc), 3)
    except Exception as exc:
        _fail(f'Unexpected upload error: {exc}', 4)

    # --- 10. Success -----------------------------------------------------
    _ok(blob_name=blob_name, url=url)


if __name__ == '__main__':
    main()
