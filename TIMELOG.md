# Time log

Time-box: 4 hours. Window: Oct 20, 3:00 pm AST – Oct 22, 3:00 pm AST.

Done on Oct 21. Times below are wall-clock (local time, UTC-3), reconstructed from file and commit timestamps.

| Time | Phase | Duration |
|---|---|---|
| 11:23 – 12:25 | Reading the brief; design decisions: SQLite vs in-memory, webhook vs in-process, snapshot + version vs deltas | ~1h |
| 12:25 – 12:30 | Core: event contract, schema, `processEvent`, outbox dispatcher, simulated sender, example and property-based tests. The property test found the skipped/re-confirm bug, which I fixed | ~5m |
| 12:30 – 15:20 | Walking through the whole design end to end with concrete scenarios, to understand and own every decision: duplicates, reordering, cancel before dispatch, crashes and transactions, tests. Reverted the fix to watch the tests catch the bug | ~2h50m |
| 15:20 – 15:36 | Webhook (HMAC signature, read endpoints, graceful shutdown) + HTTP tests | ~15m |
| 15:36 – 15:41 | PMS simulator + end-to-end runs (normal, and with a 40% failing email provider) | ~5m |
| 15:41 – 15:45 | README, time log, commits | ~5m |
| | **Total (wall-clock)** | **~4h20m** |

Code generation was fast because I worked with an AI assistant. Most of the time went into the design and into understanding it deeply, which is the part I have to stand behind.

## How I worked

Built pairing with an AI coding assistant (Claude Code): I made the design decisions, reviewed the code and own it.
