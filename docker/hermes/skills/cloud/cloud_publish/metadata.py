"""Blob custom metadata builder.

Azure Blob metadata values must be ASCII (HTTP header constraints).
We base64-utf8 encode any UTF-8 fields (title, description, tags) so
Chinese / emoji characters survive the round-trip.
"""

import base64
import datetime

MAX_METADATA_BYTES = 8 * 1024  # Azure limit: 8 KB total


def _b64(s: str) -> str:
    """UTF-8 → base64 ASCII string."""
    return base64.b64encode(s.encode('utf-8')).decode('ascii')


def build_metadata(
    title: str,
    session_id: str | None = None,
    published_at: str | None = None,
    tool_version: str = '0.1.0',
    description: str | None = None,
    tags: list[str] | None = None,
    source: str = 'agent',
) -> dict[str, str]:
    """Return Azure Blob custom metadata dict (all string values).

    Base64-utf8 encodes UTF-8 fields (title / description / tags) so they
    fit Azure's ISO-8859-1 / ASCII constraint for HTTP headers.
    Plain ASCII fields (session_id, published_at, tool_version) pass through
    unchanged.

    Raises ValueError if total metadata size would exceed 8 KB.
    """
    if published_at is None:
        published_at = datetime.datetime.now(datetime.timezone.utc).isoformat(
            timespec='seconds'
        )

    meta: dict[str, str] = {
        'title': _b64(title),
        'published_at': published_at,
        'tool_version': tool_version,
        'source': source,
    }

    if session_id:
        meta['session_id'] = session_id

    if description:
        meta['description'] = _b64(description)

    if tags:
        meta['tags'] = _b64(','.join(tags))

    total = sum(len(k) + len(v) for k, v in meta.items())
    if total > MAX_METADATA_BYTES:
        raise ValueError(f'metadata too large: {total} bytes > {MAX_METADATA_BYTES}')

    return meta
