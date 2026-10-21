import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type { Db } from './db.ts';
import { ReservationEvent } from './domain/events.ts';
import { processEvent } from './sync/processEvent.ts';
import { isValidSignature, SIGNATURE_HEADER } from './webhook/signature.ts';

export interface ServerDeps {
  db: Db;
  webhookSecret: string;
  logger?: boolean | { level: string };
  /** Only wired when the email sender is simulated, so the simulator can count deliveries. */
  devEmails?: () => unknown[];
}

interface ReservationRow {
  id: string;
  version: number;
  status: string;
  guest_name: string;
  guest_email: string;
  check_in: string;
  check_out: string;
  room_type: string;
  total_amount: number;
  currency: string;
  updated_at: string;
}

const toReservation = (r: ReservationRow) => ({
  id: r.id,
  version: r.version,
  status: r.status,
  guest: { name: r.guest_name, email: r.guest_email },
  checkIn: r.check_in,
  checkOut: r.check_out,
  roomType: r.room_type,
  totalAmount: r.total_amount,
  currency: r.currency,
  updatedAt: r.updated_at,
});

export function buildServer({ db, webhookSecret, logger = false, devEmails }: ServerDeps): FastifyInstance {
  const app = Fastify({ logger, logController: new LogController({ disableRequestLogging: true }) });

  // The signature is computed over the exact bytes the PMS sent, so keep the raw body around.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as { rawBody?: string }).rawBody = body as string;
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(Object.assign(new Error('invalid JSON'), { statusCode: 400 }), undefined);
    }
  });

  /**
   * The webhook. Response codes are a contract with the PMS:
   *   200 -> "I have it" (including duplicates and stale events: retrying won't change anything)
   *   400 / 401 -> the request is wrong; retrying the same payload won't help
   *   500 -> our fault (e.g. DB down); please retry
   * We only answer 200 after the transaction committed.
   */
  app.post('/webhooks/pms', async (req, reply) => {
    const rawBody = (req as { rawBody?: string }).rawBody ?? '';
    if (!isValidSignature(rawBody, req.headers[SIGNATURE_HEADER] as string | undefined, webhookSecret)) {
      return reply.code(401).send({ error: 'invalid signature' });
    }

    const parsed = ReservationEvent.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid event', issues: parsed.error.issues });
    }

    const event = parsed.data;
    const result = processEvent(db, event);
    req.log.info(
      { eventId: event.eventId, reservationId: event.reservationId, version: event.version, ...result },
      'event processed',
    );
    return reply.code(200).send(result);
  });

  // Read side: lets us (and the simulator) inspect the local view.
  app.get('/reservations', async () => {
    const rows = db.prepare('SELECT * FROM reservations ORDER BY id').all() as unknown as ReservationRow[];
    return rows.map(toReservation);
  });

  app.get<{ Params: { id: string } }>('/reservations/:id', async (req, reply) => {
    const row = db.prepare('SELECT * FROM reservations WHERE id = ?').get(req.params.id) as ReservationRow | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    const events = db
      .prepare(
        `SELECT event_id, type, version, outcome, received_at FROM processed_events
         WHERE reservation_id = ? ORDER BY received_at, rowid`,
      )
      .all(req.params.id);
    const email = db
      .prepare('SELECT idempotency_key, status, attempts, last_error, sent_at FROM outbox WHERE reservation_id = ?')
      .get(req.params.id);
    return { ...toReservation(row), history: events, confirmationEmail: email ?? null };
  });

  app.get('/outbox', async () => db.prepare('SELECT * FROM outbox ORDER BY id').all());

  // Small operational summary: how dirty is the feed, and is anything stuck?
  app.get('/stats', async () => ({
    events: db.prepare('SELECT outcome, COUNT(*) AS count FROM processed_events GROUP BY outcome').all(),
    outbox: db.prepare('SELECT status, COUNT(*) AS count FROM outbox GROUP BY status').all(),
    reservations: db.prepare('SELECT status, COUNT(*) AS count FROM reservations GROUP BY status').all(),
  }));

  app.get('/health', async () => ({ ok: true }));

  if (devEmails) app.get('/dev/emails', async () => devEmails());

  return app;
}
