#!/usr/bin/env bash
# One command for the full safety net: Python tests/lint + every node test.
# Works from a clean clone once the dev extra is installed (see README).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -x .venv/bin/python ]; then
  PY=.venv/bin/python
else
  PY=${PYTHON:-python3}
fi
if [ -x .venv/bin/ruff ]; then
  RUFF=.venv/bin/ruff
elif command -v ruff >/dev/null 2>&1; then
  RUFF=ruff
else
  echo "ruff not found (install the dev extra: pip install -e '.[dev]')" >&2
  exit 1
fi

echo "== pytest =="
"$PY" -m pytest tests/ -q

echo "== ruff =="
"$RUFF" check src tests sync.py
"$RUFF" format --check src tests sync.py

echo "== node syntax =="
for f in webapp/ble.js webapp/store.js webapp/ui.js webapp/*.test.js; do
  node --check "$f"
done

echo "== node tests =="
node webapp/capture.test.js
node webapp/chart.test.js
node webapp/skew.test.js
node webapp/store.test.js
node webapp/parity.test.js

echo "All checks passed."
