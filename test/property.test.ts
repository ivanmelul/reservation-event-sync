import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import type { ReservationEvent, ReservationStatus } from '../src/domain/events.ts';
import { OutboxDispatcher } from '../src/email/dispatcher.ts';
import { FakeEmailSender } from '../src/email/sender.ts';
import { processEvent } from '../src/sync/processEvent.ts';
import { event } from './helpers.ts';

/** A valid PMS history for one reservation: created, then N updates, maybe a cancel at the end. */
const history = (id: string) =>
  fc
    .record({
      statuses: fc.array(fc.constantFrom<ReservationStatus>('pending', 'confirmed', 'cancelled'), {
        minLength: 1,
        maxLength: 6,
      }),
      rooms: fc.array(fc.constantFrom('Twin', 'Suite', 'King'), { minLength: 6, maxLength: 6 }),
    })
    .map(({ statuses, rooms }) =>
      statuses.map((status, i) =>
        event(
          id,
          i + 1,
          i === 0 ? 'reservation.created' : status === 'cancelled' ? 'reservation.cancelled' : 'reservation.updated',
          { status, roomType: rooms[i]! },
        ),
      ),
    );

/** Several reservations, then delivered with duplicates (1-3 copies each) in a random order. */
const scenario = fc
  .integer({ min: 1, max: 5 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => history(`r${i}`))))
  .chain((histories) => {
    const events = histories.flat();
    return fc
      .tuple(
        fc.array(fc.integer({ min: 1, max: 3 }), { minLength: events.length, maxLength: events.length }),
        fc.infiniteStream(fc.double({ noNaN: true })),
        fc.array(fc.boolean(), { minLength: events.length * 3, maxLength: events.length * 3 }),
      )
      .map(([copies, keys, drainAfter]) => {
        const deliveries = events.flatMap((e, i) => Array.from({ length: copies[i]! }, () => e));
        const sortKeys = [...keys.take(deliveries.length)];
        const shuffled = deliveries
          .map((e, i) => ({ e, k: sortKeys[i]! }))
          .sort((a, b) => a.k - b.k)
          .map((x) => x.e);
        return { histories, deliveries: shuffled, drainAfter };
      });
  });

describe('property: any duplication + reordering converges', () => {
  it('ends in the same state as in-order delivery, with at most one email per reservation', async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ({ histories, deliveries, drainAfter }) => {
        const db = openDb();
        const sender = new FakeEmailSender();
        const dispatcher = new OutboxDispatcher(db, sender);

        // Interleave dispatcher runs at random points, as a real background worker would.
        for (const [i, e] of deliveries.entries()) {
          processEvent(db, e as ReservationEvent);
          if (drainAfter[i]) await dispatcher.drain();
        }
        await dispatcher.drain();

        for (const h of histories) {
          const last = h[h.length - 1]!;
          const row = db.prepare('SELECT version, status, room_type FROM reservations WHERE id = ?').get(last.reservationId);
          expect(row).toMatchObject({ version: last.version, status: last.data.status, room_type: last.data.roomType });

          const emails = sender.countFor(last.data.guest.email);
          expect(emails).toBeLessThanOrEqual(1);
          // If it ends confirmed, the guest must have been told exactly once.
          if (last.data.status === 'confirmed') expect(emails).toBe(1);
        }
      }),
      { numRuns: 300 },
    );
  });
});
