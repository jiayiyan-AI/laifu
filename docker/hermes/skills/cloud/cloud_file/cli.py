"""cloud-file CLI — 管理用户的 laifu 云盘(子命令 ls / get / put)。

Stdout: 一行 JSON。退出码:0 成功 / 1 参数错误 / 2 鉴权失败 / 3 网络或下载上传失败 / 4 其他。
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import pathlib
import sys
from typing import NoReturn

from cloud_file.sas_cache import SasCache, AuthError
from cloud_file.paths import validate_virtual_path
from cloud_file.downloader import list_files, download_file
from cloud_file.uploader import upload_blob
from cloud_file.metadata import build_metadata

_MAX_FILE_BYTES = 10 * 1024 * 1024  # 10 MB


def _emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def _fail(msg: str, code: int) -> NoReturn:
    _emit({'ok': False, 'error': msg})
    sys.exit(code)


def _load_sas() -> tuple[dict, SasCache]:
    """读 env + 取 SAS(缓存)。失败按约定退出码 _fail。"""
    gateway_base_url = os.environ.get('GATEWAY_BASE_URL', '').strip()
    jwt = os.environ.get('LAIFU_USER_TOKEN', '').strip()
    if not gateway_base_url:
        _fail('GATEWAY_BASE_URL environment variable not set', 4)
    if not jwt:
        _fail('LAIFU_USER_TOKEN environment variable not set', 2)
    cache_path = pathlib.Path.home() / '.hermes' / '_cloud_sas.json'
    sas_cache = SasCache(path=cache_path, gateway_base_url=gateway_base_url, jwt=jwt)
    try:
        sas = sas_cache.get()
    except AuthError as exc:
        _fail(str(exc), 2)
    except Exception as exc:
        _fail(f'Failed to obtain SAS token: {exc}', 3)
    return sas, sas_cache


def cmd_ls(args: argparse.Namespace) -> None:
    sas, _ = _load_sas()
    prefix = args.prefix
    if prefix and not prefix.endswith('/'):
        prefix += '/'
    try:
        files = list_files(sas, sub_prefix=prefix)
    except Exception as exc:
        _fail(f'list failed: {exc}', 3)
    _emit({'ok': True, 'files': files})


def cmd_get(args: argparse.Namespace) -> None:
    try:
        validate_virtual_path(args.virtual_path)
    except ValueError as exc:
        _fail(str(exc), 1)
    output = args.output or pathlib.PurePosixPath(args.virtual_path).name
    sas, sas_cache = _load_sas()
    try:
        size = download_file(sas, args.virtual_path, output, sas_cache=sas_cache)
    except FileNotFoundError as exc:
        _fail(str(exc), 3)
    except RuntimeError as exc:
        _fail(str(exc), 3)
    except Exception as exc:
        _fail(f'Unexpected download error: {exc}', 4)
    _emit({'ok': True, 'virtual_path': args.virtual_path, 'output': output, 'size': size})


def cmd_put(args: argparse.Namespace) -> None:
    file_path = pathlib.Path(args.file)
    if not file_path.exists():
        _fail(f'file not found: {args.file}', 1)
    if not file_path.is_file():
        _fail(f'not a regular file: {args.file}', 1)
    file_size = file_path.stat().st_size
    if file_size > _MAX_FILE_BYTES:
        _fail(f'file too large: {file_size} bytes > {_MAX_FILE_BYTES} (10 MB limit)', 1)

    try:
        validate_virtual_path(args.virtual_path)
    except ValueError as exc:
        _fail(str(exc), 1)

    env_session_id = os.environ.get('LAIFU_SESSION_ID', '').strip() or None
    session_id = args.session_id or env_session_id
    title = args.title or pathlib.PurePosixPath(args.virtual_path).name

    content_type = args.content_type
    if not content_type:
        guessed, _ = mimetypes.guess_type(str(file_path))
        content_type = guessed

    tags_list = None
    if args.tags:
        tags_list = [t.strip() for t in args.tags.split(',') if t.strip()]

    sas, sas_cache = _load_sas()
    prefix = sas.get('prefix', '')
    blob_name = f'{prefix}{args.virtual_path}'

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

    _emit({'ok': True, 'blob_name': blob_name, 'url': url})


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog='cloud-file', description="Manage the user's laifu Cloud Drive.")
    sub = p.add_subparsers(dest='cmd', required=True)

    p_ls = sub.add_parser('ls', help='List files (flat, recursive)')
    p_ls.add_argument('prefix', nargs='?', default='', help='Optional virtual prefix, e.g. reports/')

    p_get = sub.add_parser('get', help='Download a file from the cloud drive')
    p_get.add_argument('virtual_path', help='Cloud path, e.g. reports/q2.pdf')
    p_get.add_argument('-o', '--output', default=None,
                       help='Local output path (default: basename of virtual_path in cwd)')

    p_put = sub.add_parser('put', help='Upload/publish a local file to the cloud drive')
    p_put.add_argument('file', help='Local file path')
    p_put.add_argument('virtual_path', help='Cloud path, e.g. reports/2026-06/sales.pdf')
    p_put.add_argument('--title', default=None, help='Human-readable title (UTF-8 OK)')
    p_put.add_argument('--description', default=None, help='Short description (UTF-8 OK)')
    p_put.add_argument('--tags', default=None, help='Comma-separated tags')
    p_put.add_argument('--session-id', default=None, dest='session_id')
    p_put.add_argument('--content-type', default=None, dest='content_type',
                       help='MIME type; auto-detected from extension if omitted')
    return p


def main() -> None:
    args = _build_parser().parse_args()
    if args.cmd == 'ls':
        cmd_ls(args)
    elif args.cmd == 'get':
        cmd_get(args)
    elif args.cmd == 'put':
        cmd_put(args)


if __name__ == '__main__':
    main()
