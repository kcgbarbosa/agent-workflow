"""The design doc names every `loop.toml` key the code reads, so a new key cannot ship undocumented."""

from __future__ import annotations

import re
from pathlib import Path

LOOP = Path(__file__).resolve().parents[1]
DESIGN = LOOP.parent / "skills" / "setup-loop" / "loop.md"


def test_the_design_doc_names_every_config_key() -> None:
    source = (LOOP / "src" / "loop" / "config.py").read_text()
    keys = set(re.findall(r'\.(?:text|number|texts|table)\(\s*"([a-z_]+)"', source))
    doc = DESIGN.read_text()

    assert keys, "the key pattern no longer matches config.py"
    missing = sorted(key for key in keys if not re.search(rf"`[^`\n]*\b{key}\b[^`\n]*`", doc))
    assert not missing, f"{DESIGN} does not name these loop.toml keys: {missing}"
