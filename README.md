# Reservation Event Sync

A service that keeps a local view of reservations in sync with webhook events from a PMS, and sends each guest **exactly one** confirmation email, even when events arrive duplicated, out of order, or concurrently.

Node 24 + TypeScript, Fastify, SQLite (`node:sqlite`), zod, Vitest + fast-check.

```bash
npm install
npm test                 # 23 tests, including a property-based test (300 random scenarios per run)
npm start                # service on :3000 (SQLite file: data.db)
npm run simulate         # in another terminal: the PMS simulator, sends a dirty feed and verifies the result
```

---

## How it works

```
 PMS simulator ──POST /webhooks/pms (HMAC-signed)──►  Webhook ──► processEvent() ──► SQLite
 (scripts/simulate.ts)                                (server.ts)  one transaction     ├─ reservations      (current state)
                                                                                     ├─ processed_events  (inbox / audit log)
                                                                                     └─ outbox            (emails to send)
                                                                                              ▲
                                                      OutboxDispatcher (every 500 ms) ────────┘──► EmailSender (simulated)
```

For every event, `processEvent` asks three questions inside **one transaction**:

1. **Have I seen this `eventId`?** → yes: `duplicate`, do nothing.
2. **Is `version` newer than what I have for this reservation?** → no: record it as `stale`, don't touch the reservation.
3. **Is the reservation now `confirmed`?** → yes: make sure a `confirmation:{reservationId}` row exists in the outbox.

The webhook answers **200 only after commit**, and also for duplicates and stale events (retrying won't change anything). 400/401 for malformed or unsigned requests, 500 if we fail (so the PMS retries).

The **dispatcher** sends emails from the outbox, separately from event processing. At send time it re-reads the reservation; if it's no longer confirmed, the row is marked `skipped` instead of sent. A failed send is retried with exponential backoff (1s, 2s, 4s, 8s), and after 5 attempts the row is marked `dead`.

## Assumptions about the event source

The brief lets us define the event shape. These are my assumptions; each one is a decision, not a given.

```jsonc
{
  "eventId": "evt_002",            // unique per event; a redelivery reuses the same id
  "reservationId": "res_100",
  "type": "reservation.updated",   // created | updated | cancelled
  "version": 2,                    // monotonic per reservation, assigned by the PMS
  "occurredAt": "2026-10-21T10:00:00Z",
  "data": { "status": "confirmed", "guest": {...}, "roomType": "...", "checkIn": "...", ... }  // full snapshot
}
```

- **Full snapshot, not deltas.** Each event carries the whole reservation. This is what makes out-of-order delivery easy: keep the highest version and drop older ones. Nothing needs to be buffered or reordered, and a lost intermediate event doesn't block anything.
- **Per-reservation `version`.** *If the real PMS doesn't provide one:* use its `updatedAt` with a tie-breaker. Alternatively, treat the webhook as a "something changed" notification and fetch the current reservation from the PMS API, which removes the ordering problem entirely.
- **The PMS is the source of truth.** Events are facts that already happened. We mirror them and never reject one for business reasons (availability, pricing…); we only validate format.
- **"Exactly once per reservation" means one confirmation *sent* per reservation, ever.** If a reservation is cancelled and re-confirmed *after* the email went out, no second email. If it was cancelled *before* the email went out (`skipped`) and later re-confirmed, the email is re-armed and sent.
- `type: reservation.cancelled` forces `status = cancelled`, whatever the snapshot says.
- An event with the **same version but a different `eventId`** is treated as stale (same version ⇒ same content).

## Guarantees and what provides them

| Guarantee | Mechanism |
|---|---|
| Redelivered event is a no-op | `processed_events.event_id` PRIMARY KEY (inbox / idempotent consumer) |
| Older event never overwrites newer state | `version` comparison (last-writer-wins by version) |
| State, inbox and outbox never diverge | One SQLite transaction (`BEGIN IMMEDIATE`) per event; 200 only after commit |
| At most one confirmation per reservation | `outbox.idempotency_key` UNIQUE (`confirmation:{reservationId}`); a `sent` row is never re-armed |
| No confirmation for a reservation cancelled before dispatch | Dispatcher re-reads current status at send time → `skipped` |
| Email survives provider outages | Transactional outbox + retries with exponential backoff + dead letter |
| Crash between "provider accepted" and "marked sent" doesn't double-send | Idempotency key passed to the provider (Resend/Postmark/SES support this) |
| Only the PMS can post events | HMAC-SHA256 signature over the raw body, constant-time compare |

**"Exactly once" honestly:** between two systems (our DB and an email provider), true exactly-once delivery isn't possible. What this gives is **at-least-once delivery + idempotent receiver = effectively once**.

## Testing

- **`test/sync.test.ts`**: one test per scenario: duplicates, late older version, update before create, cancellation wins over a late confirmation, transaction rollback, cancel-before-dispatch, re-confirm after skip, retry/backoff, dead letter.
- **`test/property.test.ts`**: fast-check generates 1–5 reservations with random valid histories. Each event is delivered 1–3 times, the stream is fully shuffled, and the dispatcher runs at random points. It asserts three things: the final state equals the last true version, no guest gets more than one email, and every reservation that ends confirmed got exactly one.
- **`test/server.test.ts`**: HTTP contract: 200 for applied, duplicate and stale; 401 for a bad signature (nothing stored); 400 for an invalid event or JSON; the read endpoints.
- **`npm run simulate`**: end-to-end over real HTTP, with 8 concurrent senders and retries on non-2xx. It compares the service's view with the true histories and counts emails. It is seeded, so a run is reproducible (`--seed 42`).

**The property test found a real bug.** My first version used `INSERT OR IGNORE` for the outbox. The failing case: confirmed → email enqueued → the reservation goes back to pending before dispatch → the dispatcher marks it `skipped` → re-confirmed → the insert is ignored → the guest never gets an email. The fix re-arms only `skipped` rows (`ON CONFLICT … DO UPDATE … WHERE status = 'skipped'`), and there is now an explicit regression test. Reverting that one statement makes both tests fail.

### Simulator

```bash
npm run simulate -- --reservations 100 --seed 42 --concurrency 16 --max-copies 3
EMAIL_FAILURE_RATE=0.4 npm start      # make the fake email provider fail 40% of the time
```

Sample run (50 reservations, provider failing 40%):

```
  50 reservations, 188 distinct events, 383 deliveries (195 duplicates), shuffled, concurrency=8

  Example: res_s7_…_3 (Lucía)
    true history : v1 confirmed/King → v2 confirmed/Suite → … → v6 cancelled/Suite
    arrival order: v1, v4, v3, v1, v3, v2, v3, v6, v5, v2
    local view   : v6 cancelled/Suite  emails=0

  Webhook responses : applied=96  duplicate=195  stale=92
  Reservations      : 50/50 match the PMS
  Emails            : 36 delivered, max per guest = 1, 35 reservations end confirmed (each must have exactly 1)

✔ Local view matches the PMS and every confirmed guest got exactly one email.
```

## API

| Endpoint | |
|---|---|
| `POST /webhooks/pms` | Receive an event. Header `x-pms-signature: sha256=<hmac>` |
| `GET /reservations` | Local view |
| `GET /reservations/:id` | One reservation, its event history (applied/stale) and its email status |
| `GET /outbox` | Email outbox |
| `GET /stats` | Counts by event outcome, outbox status and reservation status |
| `GET /health` | Liveness |
| `GET /dev/emails` | Emails delivered by the simulated provider (only wired with the fake sender) |

Configuration: `PORT` (3000), `DB_PATH` (`data.db`), `WEBHOOK_SECRET` (`dev-secret`), `EMAIL_FAILURE_RATE` (0), `LOG_LEVEL` (info).

## Decisions and trade-offs

- **SQLite instead of in-memory.** It costs about the same to write, but gives real transactions and UNIQUE constraints. Correctness then rests on the database, not on careful code, and state survives restarts. `node:sqlite` is built into Node 24, so there are no native dependencies (it is still flagged experimental).
- **Process inside the webhook request.** Processing is a millisecond-scale transaction, so we answer after commit. At high volume I'd persist the raw event, ack immediately, and process asynchronously.
- **No message queue.** SQS, SNS or Kafka would help with throughput and isolation, but not with correctness: SQS standard is itself at-least-once and unordered, so the consumer would need the exact same inbox, version and outbox logic. The outbox table acts as the queue here.
- **The reservations table is a projection.** `processed_events` is append-only and keeps every payload. `reservations` is materialized for cheap reads and could be rebuilt by replaying the log.
- **The email reads current state at send time**, not enqueue-time data. A change before dispatch is reflected; a change after dispatch is not notified (see below).

## Known limitations / what I'd do for production

1. **Postgres** instead of SQLite, with the same schema and constraints.
2. **Dispatcher as a separate worker** that claims rows atomically (`FOR UPDATE SKIP LOCKED`), so several instances can run. Today an in-process flag prevents overlapping drains, which assumes a single instance.
3. **Reconciliation job** that periodically compares against the PMS API, to recover from webhooks that were never delivered.
4. **Retention** for `processed_events` (longer than the PMS's retry window).
5. **Observability:** metrics (events by outcome, outbox lag, `dead` count), alerts on dead letters, and a duplicate counter (duplicates are currently not recorded, only applied and stale events are).
6. **Other notifications** (modification or cancellation emails) would be separate outbox kinds with their own idempotency keys, e.g. `modification:{id}:{version}`.
7. Edge cases not handled: a missing or changing guest email, and OTA-masked addresses.

## Project layout

```
src/
  domain/events.ts        event contract (zod)
  db.ts                   schema + transaction helper
  sync/processEvent.ts    dedupe → version check → upsert → outbox
  email/sender.ts         EmailSender interface + simulated provider
  email/dispatcher.ts     outbox worker: re-check status, send, retry/backoff, dead letter
  webhook/signature.ts    HMAC sign/verify
  server.ts               Fastify: webhook + read endpoints
  main.ts                 wiring, dispatcher loop, graceful shutdown
scripts/simulate.ts       PMS simulator + end-to-end verification
test/                     example, property-based and HTTP tests
```

Time log: see [TIMELOG.md](TIMELOG.md).
