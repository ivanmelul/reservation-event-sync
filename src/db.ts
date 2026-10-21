import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

const SCHEMA = `
  -- Local view of reservations. One row per reservation, always the highest version seen.
  CREATE TABLE IF NOT EXISTS reservations (
    id            TEXT PRIMARY KEY,
    version       INTEGER NOT NULL,
    status        TEXT NOT NULL,
    guest_name    TEXT NOT NULL,
    guest_email   TEXT NOT NULL,
    check_in      TEXT NOT NULL,
    check_out     TEXT NOT NULL,
    room_type     TEXT NOT NULL,
    total_amount  REAL NOT NULL,
    currency      TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  -- Inbox: every eventId we have seen, with what we did with it. PK gives dedupe.
  CREATE TABLE IF NOT EXISTS processed_events (
    event_id       TEXT PRIMARY KEY,
    reservation_id TEXT NOT NULL,
    type           TEXT NOT NULL,
    version        INTEGER NOT NULL,
    outcome        TEXT NOT NULL,          -- applied | stale
    received_at    TEXT NOT NULL,
    payload        TEXT NOT NULL
  );

  -- Outbox: side effects to perform. The UNIQUE key is what makes "one email per reservation" hold.
  CREATE TABLE IF NOT EXISTS outbox (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL UNIQUE,
    kind            TEXT NOT NULL,
    reservation_id  TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending', -- pending | sent | skipped | dead
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error      TEXT,
    created_at      TEXT NOT NULL,
    sent_at         TEXT
  );
  CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (status, next_attempt_at);
`;

export function openDb(path = ':memory:'): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

/** Runs fn inside a write transaction. BEGIN IMMEDIATE takes the write lock up front. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
