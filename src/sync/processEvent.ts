import { transaction, type Db } from '../db.ts';
import type { ReservationEvent } from '../domain/events.ts';

export type ProcessOutcome = 'applied' | 'duplicate' | 'stale';

export interface ProcessResult {
  outcome: ProcessOutcome;
  emailEnqueued: boolean;
}

export const confirmationKey = (reservationId: string) => `confirmation:${reservationId}`;

/**
 * Writes the event's snapshot as the current state of the reservation. Shared by live processing
 * and by the rebuild, so both derive the view with the exact same rule. Returns the stored status.
 */
export function applySnapshot(db: Db, event: ReservationEvent, updatedAt: string): ReservationEvent['data']['status'] {
  const d = event.data;
  // `cancelled` events are authoritative about status even if the snapshot disagrees.
  const status = event.type === 'reservation.cancelled' ? 'cancelled' : d.status;
  db.prepare(
    `INSERT INTO reservations (id, version, status, guest_name, guest_email, check_in, check_out,
                               room_type, total_amount, currency, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       version = excluded.version, status = excluded.status, guest_name = excluded.guest_name,
       guest_email = excluded.guest_email, check_in = excluded.check_in, check_out = excluded.check_out,
       room_type = excluded.room_type, total_amount = excluded.total_amount,
       currency = excluded.currency, updated_at = excluded.updated_at`,
  ).run(
    event.reservationId, event.version, status, d.guest.name, d.guest.email, d.checkIn, d.checkOut,
    d.roomType, d.totalAmount, d.currency, updatedAt,
  );
  return status;
}

/**
 * Applies one event to the local view. Safe to call any number of times, in any order.
 *
 * All of this runs in one transaction, so the inbox row, the reservation row and the
 * outbox row are committed together or not at all. A crash halfway leaves nothing behind,
 * and the PMS redelivery is then processed from scratch.
 */
export function processEvent(db: Db, event: ReservationEvent, now = new Date()): ProcessResult {
  const nowIso = now.toISOString();

  return transaction(db, () => {
    // 1. Exact redelivery of an event we already handled: no-op.
    const seen = db.prepare('SELECT 1 FROM processed_events WHERE event_id = ?').get(event.eventId);
    if (seen) return { outcome: 'duplicate', emailEnqueued: false };

    // 2. Out-of-order: only a strictly newer version may overwrite the view.
    const current = db
      .prepare('SELECT version FROM reservations WHERE id = ?')
      .get(event.reservationId) as { version: number } | undefined;
    const isNewer = !current || event.version > current.version;
    const outcome: ProcessOutcome = isNewer ? 'applied' : 'stale';

    db.prepare(
      `INSERT INTO processed_events (event_id, reservation_id, type, version, outcome, received_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(event.eventId, event.reservationId, event.type, event.version, outcome, nowIso, JSON.stringify(event));

    if (!isNewer) return { outcome, emailEnqueued: false };

    const status = applySnapshot(db, event, nowIso);

    // 3. Reservation is confirmed -> make sure a confirmation email is on its way.
    //    The unique key means at most one row per reservation. If that row was skipped
    //    (the reservation stopped being confirmed before we sent it), a re-confirmation
    //    re-arms it. A row that was already sent is never touched: the guest is told once.
    let emailEnqueued = false;
    if (status === 'confirmed') {
      const res = db
        .prepare(
          `INSERT INTO outbox (idempotency_key, kind, reservation_id, next_attempt_at, created_at)
           VALUES (?, 'confirmation_email', ?, ?, ?)
           ON CONFLICT (idempotency_key) DO UPDATE SET
             status = 'pending', attempts = 0, last_error = NULL, next_attempt_at = excluded.next_attempt_at
           WHERE outbox.status = 'skipped'`,
        )
        .run(confirmationKey(event.reservationId), event.reservationId, nowIso, nowIso);
      emailEnqueued = res.changes === 1;
    }

    return { outcome, emailEnqueued };
  });
}
