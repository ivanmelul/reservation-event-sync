import { beforeEach, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.ts';
import { processEvent } from '../src/sync/processEvent.ts';
import { rebuildReservations } from '../src/sync/rebuild.ts';
import { event } from './helpers.ts';

let db: Db;
const all = (table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();

beforeEach(() => {
  db = openDb();
  // A dirty feed: out of order, duplicated, two reservations interleaved.
  for (const e of [
    event('r1', 3, 'reservation.updated', { status: 'confirmed', roomType: 'Suite' }),
    event('r2', 1, 'reservation.created', { status: 'confirmed' }),
    event('r1', 1, 'reservation.created'),
    event('r1', 3, 'reservation.updated', { status: 'confirmed', roomType: 'Suite' }),
    event('r2', 2, 'reservation.cancelled', { status: 'cancelled' }),
    event('r1', 2, 'reservation.updated', { status: 'confirmed', roomType: 'Twin' }),
  ]) {
    processEvent(db, e);
  }
});

it('reproduces the live view exactly from the event log', () => {
  const before = all('reservations');
  expect(rebuildReservations(db)).toEqual({ reservations: 2, changed: [] });
  expect(all('reservations')).toEqual(before);
});

it('repairs a corrupted row', () => {
  const before = all('reservations');
  db.prepare(`UPDATE reservations SET status = 'pending', room_type = 'Broom closet' WHERE id = 'r1'`).run();
  expect(rebuildReservations(db).changed).toEqual(['r1']);
  expect(all('reservations')).toEqual(before);
});

it('never touches the outbox', () => {
  const outbox = all('outbox');
  rebuildReservations(db);
  expect(all('outbox')).toEqual(outbox);
});
