"""cloud-download CLI entry point.

Usage:
  cloud-download --list [--prefix PFX]          # 扁平递归列出前缀下所有文件
  cloud-download --virtual-path PATH --output FILE

Stdout: one-line JSON.
  --list:     {"ok": true, "files": [{...}]}
  --download: {"ok": true, "virtual_path": "...", "output": "...", "size": N}
  failure:    {"ok": false, "error": "<message>"}

Exit codes: 0 ok / 1 input error / 2 auth failure / 3 network|download / 4 other.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys

from cloud_publish.sas_cache import SasCache, AuthError
from cloud_publish.paths import validate_virtual_path
from cloud_publish.downloader import list_files, download_file


def _emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def _fail(msg: str, code: int) -> None:
    _emit({'ok': False, 'error': msg})
    sys.exit(code)


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog='cloud-download',
        description="List or download files from the user's laifu Cloud Drive.",
    )
    p.add_argument('--list', action='store_true', help='List files (flat, recursive)')
    p.add_argument('--prefix', default='', help="Narrow --list to this virtual prefix, e.g. reports/")
    p.add_argument('--virtual-path', default=None, dest='virtual_path',
                   help='Cloud path to download, e.g. reports/q2.pdf')
    p.add_argument('--output', default=None, help='Local output file path (required with --virtual-path)')
    return p


def main() -> None:
    args = _build_parser().parse_args()

    if not args.list and not args.virtual_path:
        _fail('either --list or --virtual-path is required', 1)
    if args.virtual_path and not args.output:
        _fail('--output is required when using --virtual-path', 1)

    # env
    gateway_base_url = os.environ.get('GATEWAY_BASE_URL', '').strip()
    jwt = os.environ.get('LAIFU_USER_TOKEN', '').strip()
    if not gateway_base_url:
        _fail('GATEWAY_BASE_URL environment variable not set', 4)
    if not jwt:
        _fail('LAIFU_USER_TOKEN environment variable not set', 2)

    # validate download path before any network
    if args.virtual_path:
        try:
            validate_virtual_path(args.virtual_path)
        except ValueError as exc:
            _fail(str(exc), 1)

    sas_cache_path = pathlib.Path.home() / '.hermes' / '_cloud_sas.json'
    sas_cache = SasCache(path=sas_cache_path, gateway_base_url=gateway_base_url, jwt=jwt)
    try:
        sas = sas_cache.get()
    except AuthError as exc:
        _fail(str(exc), 2)
    except Exception as exc:
        _fail(f'Failed to obtain SAS token: {exc}', 3)

    if args.list:
        try:
            prefix = args.prefix
            if prefix and not prefix.endswith('/'):
                prefix += '/'
            files = list_files(sas, sub_prefix=prefix)
        except Exception as exc:
            _fail(f'list failed: {exc}', 3)
        _emit({'ok': True, 'files': files})
        return

    # download
    try:
        size = download_file(sas, args.virtual_path, args.output, sas_cache=sas_cache)
    except FileNotFoundError as exc:
        _fail(str(exc), 3)
    except RuntimeError as exc:
        _fail(str(exc), 3)
    except Exception as exc:
        _fail(f'Unexpected download error: {exc}', 4)

    _emit({'ok': True, 'virtual_path': args.virtual_path, 'output': args.output, 'size': size})


if __name__ == '__main__':
    main()
