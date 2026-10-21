import { transaction, type Db } from '../db.ts';
import type { ReservationEvent } from '../domain/events.ts';
import { applySnapshot } from './processEvent.ts';

export interface RebuildResult {
  reservations: number;
  /** Reservation ids whose rebuilt row differs from what was stored before (e.g. a corrupted row). */
  changed: string[];
}

/**
 * Rebuilds the `reservations` projection from the append-only event log.
 *
 * Replays every recorded event (applied and stale) through the same applySnapshot used live, in version
 * order, with each event's original received_at, so a healthy view is reproduced byte for byte.
 * The outbox is never touched: rebuilding state must not re-send emails.
 */
export function rebuildReservations(db: Db): RebuildResult {
  return transaction(db, () => {
    const before = new Map(
      (db.prepare('SELECT * FROM reservations').all() as Array<Record<string, unknown>>).map((r) => [
        r.id as string,
        JSON.stringify(r),
      ]),
    );

    db.exec('DELETE FROM reservations');

    // Replaying in version order means the last write per reservation is its highest version.
    // On a version tie (same version, different eventId), the one that was applied live goes last.
    const log = db
      .prepare(
        `SELECT payload, received_at FROM processed_events
         ORDER BY reservation_id, version, outcome = 'applied'`,
      )
      .all() as Array<{ payload: string; received_at: string }>;

    for (const { payload, received_at } of log) {
      applySnapshot(db, JSON.parse(payload) as ReservationEvent, received_at);
    }

    const after = db.prepare('SELECT * FROM reservations').all() as Array<Record<string, unknown>>;
    const changed = after.filter((r) => before.get(r.id as string) !== JSON.stringify(r)).map((r) => r.id as string);
    return { reservations: after.length, changed };
  });
}
