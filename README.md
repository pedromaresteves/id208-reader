# id208-reader

Local, no-account reader for the ID208 Plus smartwatch (IDO/VeryFit BLE
dialect). Pull steps, sleep, heart rate, SpO2, pressure and workouts over
WebBluetooth into an on-phone dashboard. No VeryFit app, no ads, no cloud.

Confirmed on ID208 Plus (FW v1.01.17). Other IDO/VeryFit variants may work
if they speak the same `0x0AF0` service — captures + screen numbers welcome.

Live app (GitHub Pages):
[`webapp/`](https://pedromaresteves.github.io/id208-reader/webapp/) —
[diagnostics](https://pedromaresteves.github.io/id208-reader/webapp/diagnostics.html)
for setup/recovery,
[index](https://pedromaresteves.github.io/id208-reader/webapp/index.html)
for the dashboard.

## Normal use (phone)

1. Open `index.html` and tap **Sync Data**.
2. The app connects, sets the clock, pulls today, and drains every completed
   day the watch has queued. A fresh/reset watch is bound automatically on
   the first sync; the same setup is available as **Set up watch** on the
   Watch page.
3. Values appear on the dashboard. History pages and charts are:
   Activity, Sleep, Workouts.
4. **Backup store** / **Import backup** are on the dashboard and Watch page.
   The store lives only in this browser profile.

`diagnostics.html` is only for recovery and raw protocol work: reconnect,
full sync, setup, device info, live data, health sizes, and collapsed manual
START/STOP commands.

## Offline decode (PC, optional)

Copy a JSONL capture into `captures/` and run `sync.py`; it replays captures
through `src/ido/` into dated `out/` files (`steps.csv`, `sleep.json`,
`hr.json`, `workouts.json`). Captures and `out/` are gitignored.

## Requirements

- Python 3.10+; decoding itself is stdlib-only.
- Node 18+ for the webapp tests.
- `bleak` is optional, only for a best-effort BLE scan
  (`pip install -e ".[ble]"`; skipped cleanly without an adapter).
- Dev: `pytest`, `ruff` (`pip install -e ".[dev]"`).

## Tests

One command runs the Python, lint, syntax and node suites:

```bash
./scripts/test.sh
```

Individual pieces:

```bash
python sync.py
.venv/bin/python -m pytest tests/ -q
.venv/bin/ruff check src tests sync.py && .venv/bin/ruff format --check src tests sync.py
node webapp/capture.test.js
node webapp/chart.test.js
node webapp/skew.test.js
node webapp/store.test.js
node webapp/parity.test.js
```

Serve the webapp locally:

```bash
cd webapp && python3 -m http.server 8080
# → http://localhost:8080/index.html
```

## Privacy

`captures/` (raw JSONL, photos) and `out/` are gitignored and never
committed. If you share a capture for debugging, scrub the full Bluetooth
MAC (keep the first 3 octets) and never include wrist photos.

## Protocol notes

Service `0x0AF0`: `0x0AF6`/`0x0AF7` carry legacy commands and short v3
frames; `0x0AF1`/`0x0AF2` are the bulk pair (refused on the Windows bond).

- **Bind:** `04 01` followed by `04 05` encrypted auth (challenge from the
  bind reply, sealed with challenge-XOR-MAC). Setup replays VeryFit's
  18-step prelude.
- **Day-data history (01/02/03/08):** a persistent cursor over completed
  days, oldest first. START(oper=0, byte14=0) + matching STOP(oper=1,
  byte14=0) returns one day per round; `items=0` ends it. Today comes from
  a separate byte14=1 pull.
- **Count-data (04/06/07):** cursor-paged at offset 0; this firmware has
  returned `items=0` over BLE at every tested offset.
- **CRC:** CRC-16-CCITT-FALSE over v3 bytes `[1..len-3]`.

References: `xssfox/idowatch`, `idoosmart/idowatch`,
`orangebrush/angelfit`, `d3nd3/toobur-veryfit-research`.

Reverse-engineered, unofficial, no affiliation. Works without the vendor
app today; a firmware update could change the wire format.
