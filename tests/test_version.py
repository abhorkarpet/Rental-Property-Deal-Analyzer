"""Release version must stay consistent in Python, direct-file HTML, and docs."""

import re
from pathlib import Path

import app as app_module


ROOT = Path(__file__).resolve().parents[1]


def test_version_is_semver_and_matches_direct_html_fallback():
    assert re.fullmatch(r"\d+\.\d+\.\d+", app_module.APP_VERSION)
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    match = re.search(r'id="appVersion">v([^<]+)</div>', html)
    assert match, "index.html must retain a version when opened directly"
    assert match.group(1) == app_module.APP_VERSION


def test_every_version_has_a_changelog_comment():
    source = (ROOT / "app.py").read_text(encoding="utf-8")
    assert f"# {app_module.APP_VERSION} " in source
