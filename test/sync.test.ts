import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.ts';
import { OutboxDispatcher } from '../src/email/dispatcher.ts';
import { FakeEmailSender } from '../src/email/sender.ts';
import { processEvent } from '../src/sync/processEvent.ts';
import { event } from './helpers.ts';

let db: Db;
let sender: FakeEmailSender;
let dispatcher: OutboxDispatcher;

const reservation = (id: string) =>
  db.prepare('SELECT * FROM reservations WHERE id = ?').get(id) as Record<string, unknown> | undefined;

beforeEach(() => {
  db = openDb();
  sender = new FakeEmailSender();
  dispatcher = new OutboxDispatcher(db, sender);
});

describe('processEvent', () => {
  it('applies events in order', () => {
    processEvent(db, event('r1', 1, 'reservation.created'));
    processEvent(db, event('r1', 2, 'reservation.updated', { roomType: 'Suite' }));
    expect(reservation('r1')).toMatchObject({ version: 2, room_type: 'Suite', status: 'pending' });
  });

  it('treats a redelivered event as a no-op', () => {
    const e = event('r1', 1, 'reservation.created');
    expect(processEvent(db, e).outcome).toBe('applied');
    expect(processEvent(db, e).outcome).toBe('duplicate');
    expect(processEvent(db, e).outcome).toBe('duplicate');
  });

  it('ignores an older version that arrives late', () => {
    processEvent(db, event('r1', 3, 'reservation.updated', { roomType: 'Suite' }));
    expect(processEvent(db, event('r1', 2, 'reservation.updated', { roomType: 'Twin' })).outcome).toBe('stale');
    expect(reservation('r1')).toMatchObject({ version: 3, room_type: 'Suite' });
  });

  it('accepts an update that arrives before its create', () => {
    processEvent(db, event('r1', 2, 'reservation.updated', { status: 'confirmed' }));
    expect(processEvent(db, event('r1', 1, 'reservation.created')).outcome).toBe('stale');
    expect(reservation('r1')).toMatchObject({ version: 2, status: 'confirmed' });
  });

  it('keeps a cancellation even if an older confirmation arrives after it', () => {
    processEvent(db, event('r1', 3, 'reservation.cancelled', { status: 'cancelled' }));
    processEvent(db, event('r1', 2, 'reservation.updated', { status: 'confirmed' }));
    expect(reservation('r1')).toMatchObject({ status: 'cancelled' });
  });

  it('rolls back everything if the transaction fails midway', () => {
    db.exec('DROP TABLE outbox'); // force the outbox insert to throw
    expect(() => processEvent(db, event('r1', 1, 'reservation.created', { status: 'confirmed' }))).toThrow();
    expect(reservation('r1')).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) n FROM processed_events').get()).toMatchObject({ n: 0 });
  });
});

describe('confirmation email', () => {
  it('is sent once when the confirming event is delivered many times', async () => {
    const e = event('r1', 1, 'reservation.created', { status: 'confirmed' });
    for (let i = 0; i < 5; i++) processEvent(db, e);
    await dispatcher.drain();
    await dispatcher.drain();
    expect(sender.countFor('r1@example.com')).toBe(1);
  });

  it('is sent once across several later confirmed updates', async () => {
    processEvent(db, event('r1', 1, 'reservation.created', { status: 'confirmed' }));
    await dispatcher.drain();
    processEvent(db, event('r1', 2, 'reservation.updated', { status: 'confirmed', roomType: 'Suite' }));
    await dispatcher.drain();
    expect(sender.countFor('r1@example.com')).toBe(1);
  });

  it('is not re-sent if the reservation is cancelled and confirmed again', async () => {
    processEvent(db, event('r1', 1, 'reservation.created', { status: 'confirmed' }));
    await dispatcher.drain();
    processEvent(db, event('r1', 2, 'reservation.cancelled', { status: 'cancelled' }));
    processEvent(db, event('r1', 3, 'reservation.updated', { status: 'confirmed' }));
    await dispatcher.drain();
    expect(sender.countFor('r1@example.com')).toBe(1);
  });

  it('is not sent for a pending reservation', async () => {
    processEvent(db, event('r1', 1, 'reservation.created'));
    await dispatcher.drain();
    expect(sender.delivered).toHaveLength(0);
  });

  it('is skipped if the reservation was cancelled before dispatch', async () => {
    processEvent(db, event('r1', 1, 'reservation.created', { status: 'confirmed' }));
    processEvent(db, event('r1', 2, 'reservation.cancelled', { status: 'cancelled' }));
    await dispatcher.drain();
    expect(sender.delivered).toHaveLength(0);
    expect(db.prepare('SELECT status FROM outbox').get()).toMatchObject({ status: 'skipped' });
  });

  // Found by the property test: skipped row + later re-confirmation must still notify the guest.
  it('is sent if the reservation is re-confirmed after a skipped dispatch', async () => {
    processEvent(db, event('r1', 1, 'reservation.created', { status: 'confirmed' }));
    processEvent(db, event('r1', 2, 'reservation.updated', { status: 'pending' }));
    await dispatcher.drain(); // skipped: not confirmed anymore
    processEvent(db, event('r1', 3, 'reservation.updated', { status: 'confirmed' }));
    await dispatcher.drain();
    expect(sender.countFor('r1@example.com')).toBe(1);
  });

  it('is retried with backoff when the provider fails, and still sent once', async () => {
    let t = new Date('2026-10-01T00:00:00Z');
    const flaky = new FakeEmailSender({ failureRate: 1 });
    const d = new OutboxDispatcher(db, flaky, () => t);
    processEvent(db, event('r1', 1, 'reservation.created', { status: 'confirmed' }), t);

    await d.drain();
    expect(db.prepare('SELECT status, attempts FROM outbox').get()).toMatchObject({ status: 'pending', attempts: 1 });

    await d.drain(); // backoff not elapsed: nothing happens
    expect(db.prepare('SELECT attempts FROM outbox').get()).toMatchObject({ attempts: 1 });

    t = new Date(t.getTime() + 60_000);
    const ok = new OutboxDispatcher(db, sender, () => t);
    await ok.drain();
    expect(sender.countFor('r1@example.com')).toBe(1);
    expect(db.prepare('SELECT status FROM outbox').get()).toMatchObject({ status: 'sent' });
  });

  it('dead-letters after max attempts', async () => {
    let t = new Date('2026-10-01T00:00:00Z');
    const d = new OutboxDispatcher(db, new FakeEmailSender({ failureRate: 1 }), () => t);
    processEvent(db, event('r1', 1, 'reservation.created', { status: 'confirmed' }), t);
    for (let i = 0; i < 10; i++) {
      await d.drain();
      t = new Date(t.getTime() + 3_600_000);
    }
    expect(db.prepare('SELECT status, attempts FROM outbox').get()).toMatchObject({ status: 'dead', attempts: 5 });
  });
});
