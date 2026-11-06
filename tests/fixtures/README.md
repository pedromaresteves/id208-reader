# Test fixtures

Synthetic watch data only. Keep the wire layout and byte lengths realistic,
but never copy a real capture or real health samples here — `captures/` is
the gitignored place for those.

- `history-5day.jsonl` — five synthetic sport/HR/SpO2/pressure days.
- `history-5day.expected.json` — canonical summary used by
  `tests/test_parity.py`.
- `store/` — synthetic step/sleep/HR/workout fixtures for `store.test.js`.

After an intentional decoder change, regenerate the expected summary:

```bash
node webapp/parity.test.js --json > tests/fixtures/history-5day.expected.json
```

`tests/test_parity.py` also decodes the same fixture with the Python decoder,
so a JS-only change fails even when the expected file is regenerated.
