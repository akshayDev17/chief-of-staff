import sys

import google.adk


def test_runs_on_python_3_13():
    assert sys.version_info[:2] == (3, 13)


def test_adk_imports():
    assert google.adk.__name__ == "google.adk"
