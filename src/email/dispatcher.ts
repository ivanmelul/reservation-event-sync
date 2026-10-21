import type { Db } from '../db.ts';
import type { EmailSender } from './sender.ts';

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1_000;

interface OutboxRow {
  id: number;
  idempotency_key: string;
  reservation_id: string;
  attempts: number;
}

interface ReservationRow {
  status: string;
  guest_name: string;
  guest_email: string;
  check_in: string;
  check_out: string;
  room_type: string;
}

/**
 * Drains the outbox. Separate from event processing so a slow/failing provider never blocks
 * the webhook, and so a failed send is retried instead of lost.
 */
export class OutboxDispatcher {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly sender: EmailSender,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Processes every due outbox row once. Returns how many were sent. */
  async drain(): Promise<number> {
    // One drain at a time in this process; keeps a row from being sent by two overlapping ticks.
    if (this.running) return 0;
    this.running = true;
    try {
      const due = this.db
        .prepare(
          `SELECT id, idempotency_key, reservation_id, attempts FROM outbox
           WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id`,
        )
        .all(this.now().toISOString()) as unknown as OutboxRow[];

      let sent = 0;
      for (const row of due) {
        if (await this.dispatch(row)) sent++;
      }
      return sent;
    } finally {
      this.running = false;
    }
  }

  private async dispatch(row: OutboxRow): Promise<boolean> {
    // Read the *current* view at send time, not the state at enqueue time.
    const r = this.db
      .prepare('SELECT status, guest_name, guest_email, check_in, check_out, room_type FROM reservations WHERE id = ?')
      .get(row.reservation_id) as ReservationRow | undefined;

    if (!r || r.status !== 'confirmed') {
      // Cancelled before we got to send it: don't confirm a dead reservation.
      this.db.prepare(`UPDATE outbox SET status = 'skipped', last_error = ? WHERE id = ?`)
        .run(`reservation status is ${r?.status ?? 'missing'}`, row.id);
      return false;
    }

    try {
      await this.sender.send(
        {
          to: r.guest_email,
          subject: `Your reservation ${row.reservation_id} is confirmed`,
          body: `Hi ${r.guest_name}, your ${r.room_type} is booked from ${r.check_in} to ${r.check_out}.`,
        },
        row.idempotency_key,
      );
      this.db.prepare(`UPDATE outbox SET status = 'sent', attempts = attempts + 1, sent_at = ? WHERE id = ?`)
        .run(this.now().toISOString(), row.id);
      return true;
    } catch (err) {
      const attempts = row.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      const backoff = BASE_BACKOFF_MS * 2 ** (attempts - 1);
      this.db
        .prepare(`UPDATE outbox SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?`)
        .run(
          dead ? 'dead' : 'pending',
          attempts,
          String((err as Error).message),
          new Date(this.now().getTime() + backoff).toISOString(),
          row.id,
        );
      return false;
    }
  }

  start(intervalMs = 500): void {
    this.timer = setInterval(() => void this.drain(), intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
