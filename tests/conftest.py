"""Keep direct ``pytest`` invocation rooted at the application package."""

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import app as app_module


@pytest.fixture(autouse=True)
def clear_rate_limits():
    """Each test starts with a clean client quota window."""
    app_module._rate_limits.clear()
    yield
    app_module._rate_limits.clear()


@pytest.fixture
def client():
    with TestClient(app_module.app) as test_client:
        yield test_client
