import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.ts';
import { buildServer } from '../src/server.ts';
import { sign, SIGNATURE_HEADER } from '../src/webhook/signature.ts';
import { event } from './helpers.ts';

const SECRET = 'test-secret';
let db: Db;
let app: ReturnType<typeof buildServer>;

const post = (body: unknown, signature?: string) => {
  const payload = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: '/webhooks/pms',
    headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signature ?? sign(payload, SECRET) },
    payload,
  });
};

beforeEach(() => {
  db = openDb();
  app = buildServer({ db, webhookSecret: SECRET });
});

describe('POST /webhooks/pms', () => {
  it('applies a valid event and answers 200', async () => {
    const res = await post(event('r1', 1, 'reservation.created', { status: 'confirmed' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ outcome: 'applied', emailEnqueued: true });
  });

  it('answers 200 to a duplicate so the PMS stops retrying', async () => {
    const e = event('r1', 1, 'reservation.created');
    await post(e);
    const res = await post(e);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'duplicate' });
  });

  it('answers 200 to a stale event', async () => {
    await post(event('r1', 2, 'reservation.updated'));
    const res = await post(event('r1', 1, 'reservation.created'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'stale' });
  });

  it('rejects a bad signature with 401 and stores nothing', async () => {
    const res = await post(event('r1', 1, 'reservation.created'), 'sha256=forged');
    expect(res.statusCode).toBe(401);
    expect(db.prepare('SELECT COUNT(*) AS n FROM processed_events').get()).toMatchObject({ n: 0 });
  });

  it('rejects a malformed event with 400', async () => {
    const res = await post({ eventId: 'x', reservationId: 'r1' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects invalid JSON with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/pms',
      headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: sign('{nope', SECRET) },
      payload: '{nope',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('read endpoints', () => {
  it('exposes the local view with its event history', async () => {
    await post(event('r1', 2, 'reservation.updated', { status: 'confirmed' }));
    await post(event('r1', 1, 'reservation.created'));

    const res = await app.inject({ method: 'GET', url: '/reservations/r1' });
    expect(res.json()).toMatchObject({
      id: 'r1',
      version: 2,
      status: 'confirmed',
      history: [
        { event_id: 'r1-v2', outcome: 'applied' },
        { event_id: 'r1-v1', outcome: 'stale' },
      ],
      confirmationEmail: { status: 'pending' },
    });
  });

  it('404s an unknown reservation', async () => {
    const res = await app.inject({ method: 'GET', url: '/reservations/nope' });
    expect(res.statusCode).toBe(404);
  });
});
