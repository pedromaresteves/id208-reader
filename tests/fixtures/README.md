# Test fixtures

Synthetic watch data only. Keep the wire layout and byte lengths realistic,
but never copy a real capture or real health samples here — `captures/` is
the gitignored place for those.

- `history-5day.jsonl` — five synthetic sport/HR/SpO2/pressure days.
- `history-5day.expected.json` — summary produced by the JS decoder.
- `store/` — synthetic step/sleep/HR/workout fixtures for `store.test.js`.
