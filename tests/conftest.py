"""Pytest bootstrap: make `src/` and the repo root importable.

Allows plain `pytest` (and `ruff`) with no PYTHONPATH setup, which is what
the README tells newcomers to run.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT))
