"""Unit tests for cloud_publish.paths.validate_virtual_path."""
import pytest
from cloud_publish.paths import validate_virtual_path


class TestValid:
    @pytest.mark.parametrize('vpath', ['a.txt', 'reports/2026/sales.pdf', '销售/报告.pdf'])
    def test_accepts(self, vpath):
        validate_virtual_path(vpath)  # no raise


class TestInvalid:
    @pytest.mark.parametrize('vpath,msg', [
        ('/abs.txt', "must not start with '/'"),
        ('dir/', "must not end with '/'"),
        ('a/../b', "'..'"),
        ('a//b', 'empty segments'),
        ('x' * 1025, 'too long'),
    ])
    def test_rejects(self, vpath, msg):
        with pytest.raises(ValueError, match=msg.replace('.', r'\.')):
            validate_virtual_path(vpath)
