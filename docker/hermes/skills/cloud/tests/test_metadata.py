"""Unit tests for cloud_publish.metadata."""

import base64
import datetime

import pytest

from cloud_publish.metadata import build_metadata, _b64, MAX_METADATA_BYTES


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _decode(b64_str: str) -> str:
    return base64.b64decode(b64_str.encode('ascii')).decode('utf-8')


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestB64:
    def test_ascii_roundtrip(self):
        original = 'hello world'
        assert _decode(_b64(original)) == original

    def test_chinese_roundtrip(self):
        original = '销售报告'
        assert _decode(_b64(original)) == original


class TestBuildMetadata:
    def test_ascii_title_is_base64_encoded(self):
        meta = build_metadata(title='Sales Report')
        assert _decode(meta['title']) == 'Sales Report'

    def test_chinese_title_roundtrip(self):
        original = '销售报告'
        meta = build_metadata(title=original)
        assert _decode(meta['title']) == original

    def test_description_omitted_when_none(self):
        meta = build_metadata(title='T')
        assert 'description' not in meta

    def test_tags_omitted_when_none(self):
        meta = build_metadata(title='T')
        assert 'tags' not in meta

    def test_description_present_and_encoded(self):
        meta = build_metadata(title='T', description='Some desc 描述')
        assert _decode(meta['description']) == 'Some desc 描述'

    def test_tags_joined_with_comma_and_encoded(self):
        meta = build_metadata(title='T', tags=['alpha', 'beta', '伽马'])
        assert _decode(meta['tags']) == 'alpha,beta,伽马'

    def test_session_id_passes_through_unchanged(self):
        meta = build_metadata(title='T', session_id='sess-abc-123')
        assert meta['session_id'] == 'sess-abc-123'

    def test_session_id_absent_when_none(self):
        meta = build_metadata(title='T', session_id=None)
        assert 'session_id' not in meta

    def test_tool_version_default(self):
        meta = build_metadata(title='T')
        assert meta['tool_version'] == '0.1.0'

    def test_tool_version_custom(self):
        meta = build_metadata(title='T', tool_version='1.2.3')
        assert meta['tool_version'] == '1.2.3'

    def test_published_at_defaults_to_utc_now(self):
        # Truncate to seconds because isoformat(timespec='seconds') drops microseconds
        before = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
        meta = build_metadata(title='T')
        after = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
        # The value should be an ISO-8601 string parseable as UTC
        pa_str = meta['published_at'].replace('Z', '+00:00')
        pa = datetime.datetime.fromisoformat(pa_str)
        assert before <= pa <= after

    def test_published_at_explicit(self):
        ts = '2026-06-01T10:00:00+00:00'
        meta = build_metadata(title='T', published_at=ts)
        assert meta['published_at'] == ts

    def test_metadata_too_large_raises_value_error(self):
        # Build a title that, when base64'd, blows past 8 KB
        big_title = 'x' * MAX_METADATA_BYTES
        with pytest.raises(ValueError, match='metadata too large'):
            build_metadata(title=big_title)

    def test_all_values_are_strings(self):
        meta = build_metadata(
            title='T',
            session_id='s',
            description='d',
            tags=['a', 'b'],
        )
        for k, v in meta.items():
            assert isinstance(v, str), f'key {k!r} has non-str value'
