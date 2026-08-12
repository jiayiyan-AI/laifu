"""Virtual-path validation shared by cloud-file subcommands."""

import re

_MAX_SEGMENT_LEN = 200
_MAX_PATH_LEN = 1024
_CONTROL_CHAR_RE = re.compile(r'[\x00-\x1f\x7f]')


def validate_virtual_path(vpath: str) -> None:
    """Raise ValueError if virtual_path is invalid.

    Rules: no leading/trailing '/', no '..' segments, no empty segments,
    no control chars, segment ≤ 200 chars, total ≤ 1024 chars.
    """
    if vpath.startswith('/'):
        raise ValueError("virtual-path must not start with '/'")
    if vpath.endswith('/'):
        raise ValueError("virtual-path must not end with '/'")
    if len(vpath) > _MAX_PATH_LEN:
        raise ValueError(f'virtual-path too long: {len(vpath)} chars > {_MAX_PATH_LEN}')
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
