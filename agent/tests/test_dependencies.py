import sys
from importlib.metadata import version

import google.adk


def test_runs_on_python_3_13():
    assert sys.version_info[:2] == (3, 13)


def test_adk_imports_at_the_pinned_version():
    assert google.adk.__version__ == "2.15.0"
    assert version("google-adk") == "2.15.0"
