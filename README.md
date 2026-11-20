# Bell keeper output

Published by the Bell keeper (`.github/workflows/keeper.yml` on `main`) on every run:

- `<chainId>/status.json` latest market state (pool, every stock's two prints and whether it is live, confirmed,
  stale or paused, every borrower's debt, borrowing power and health factor) and the run history.
- `<chainId>/index.json` the event-scan cursor, known borrowers, liquidations and health-factor samples (used by the app).
