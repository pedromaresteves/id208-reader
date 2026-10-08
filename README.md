# id208-reader

Local, no-account reader for the ID208 Plus smartwatch (IDO/VeryFit BLE
dialect). Pull steps, sleep, heart rate and workouts over WebBluetooth into
an on-phone dashboard. No VeryFit app, no ads, no cloud.

Confirmed on ID208 Plus (FW v1.01.17). Other IDO/VeryFit variants may work
if they speak the same `0x0AF0` service — captures + screen numbers welcome.

Live app (GitHub Pages): [`webapp/`](https://pedromaresteves.github.io/id208-reader/webapp/) —
[pull](https://pedromaresteves.github.io/id208-reader/webapp/pull.html) to sync,
[index](https://pedromaresteves.github.io/id208-reader/webapp/index.html) to view history.

## How it works

1. **Pull (phone).** Open the pull page, tap Connect — the sync starts by
   itself when the watch is bound (fresh-reset watches get pointed at
   **A. Setup watch**, which binds with no app). Records land in the
   phone's store automatically; JSONL download stays as audit trail.
2. **View (phone).** Open the dashboard: latest values, history tables and
   charts per data type, all offline.
3. **Decode (PC, optional).** Copy a JSONL into `captures/` and run
   `sync.py` — it replays captures through `src/ido/` into dated `out/`
   files (`steps.csv`, `sleep.json`, `hr.json`, `workouts.json`).
4. **Verify.** Numbers must match the watch screen — that is the project's
   success rule. Mismatches are decoder bugs: open an issue with the JSONL
   (scrubbed, see below) plus the screen numbers.

## Requirements

- Python 3.10+; decoding itself is stdlib-only.
- `bleak` is optional (used only for a best-effort BLE scan; skipped
  cleanly without an adapter).
- Dev: `pytest`, `ruff` (`pip install -e ".[dev]"`).

```bash
python sync.py
pytest
ruff check src tests sync.py && ruff format --check src tests sync.py
```

## Privacy

`captures/` (raw JSONL, photos) and `out/` are gitignored and never
committed. If you share a capture for debugging, scrub the full Bluetooth
MAC (keep the first 3 octets) and never include wrist photos.

## Protocol notes

Service `0x0AF0` (`0x0AF6`/`0x0AF7` legacy + short v3, `0x0AF1`/`0x0AF2`
bulk). Bind is `04 01` followed by `04 05` encrypted-auth
(challenge echoed from the bind reply, sealed with challenge-XOR-MAC).
Health sync is v3 `0x05` sizes + `0x04` per-type START/STOP with
CRC-16-CCITT. References: `xssfox/idowatch`, `idoosmart/idowatch`,
`orangebrush/angelfit`, `d3nd3/toobur-veryfit-research`.

Reverse-engineered, unofficial, no affiliation. Works without the vendor
app today; a firmware update could change the wire format.
