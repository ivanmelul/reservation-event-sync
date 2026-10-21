/**
 * PMS simulator. Plays the role of the external system: invents realistic reservation
 * histories, then delivers them the way a real webhook source misbehaves (duplicates,
 * out-of-order, concurrent redeliveries, retries on non-2xx). Finally it checks the
 * service's local view against the true histories and counts confirmation emails.
 *
 *   npm run simulate -- --reservations 50 --seed 42 --concurrency 8
 */
import { parseArgs } from 'node:util';
import type { ReservationEvent, ReservationSnapshot } from '../src/domain/events.ts';
import { sign, SIGNATURE_HEADER } from '../src/webhook/signature.ts';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.SERVICE_URL ?? 'http://localhost:3000' },
    secret: { type: 'string', default: process.env.WEBHOOK_SECRET ?? 'dev-secret' },
    reservations: { type: 'string', default: '30' },
    seed: { type: 'string', default: String(Date.now() % 100_000) },
    concurrency: { type: 'string', default: '8' },
    'max-copies': { type: 'string', default: '3' },
  },
});

const N = Number(args.reservations);
const SEED = Number(args.seed);
const CONCURRENCY = Number(args.concurrency);
const MAX_COPIES = Number(args['max-copies']);
// Prefix ids per run so several runs against the same DB don't collide.
const RUN = `s${SEED}_${Date.now().toString(36)}`;

// ── Deterministic randomness: same seed, same chaos ────────────────────────────
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
function shuffle<T>(xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
  }
  return xs;
}

// ── 1. Invent true histories, in order, the way the PMS would record them ──────
const NAMES = ['Ana', 'Lucía', 'Pedro', 'Sofía', 'Mateo', 'Valentina', 'Tomás', 'Camila', 'Joaquín', 'Martina'];
const ROOMS = ['Twin', 'Queen', 'King', 'Suite', 'Penthouse'] as const;

function addDays(iso: string, days: number) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function history(n: number): ReservationEvent[] {
  const reservationId = `res_${RUN}_${n}`;
  const name = pick(NAMES);
  const checkIn = addDays('2026-12-01', int(0, 90));
  let snap: ReservationSnapshot = {
    // Some bookings arrive already confirmed (e.g. prepaid online), most start pending.
    status: rand() < 0.3 ? 'confirmed' : 'pending',
    guest: { name, email: `${name.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')}.${n}.${RUN}@example.com` },
    roomType: pick(ROOMS),
    checkIn,
    checkOut: addDays(checkIn, int(1, 7)),
    totalAmount: int(2, 20) * 100,
    currency: 'USD',
  };

  const events: ReservationEvent[] = [];
  const t0 = Date.UTC(2026, 9, 21, 10, 0, 0);
  const emit = (type: ReservationEvent['type']) => {
    const version = events.length + 1;
    events.push({
      eventId: `evt_${RUN}_${n}_${version}`,
      reservationId,
      type,
      version,
      occurredAt: new Date(t0 + version * 60_000).toISOString(),
      data: structuredClone(snap),
    });
  };

  emit('reservation.created');
  for (let step = int(1, 5); step > 0; step--) {
    const r = rand();
    if (snap.status === 'pending' && r < 0.6) snap = { ...snap, status: 'confirmed' };
    else if (snap.status === 'cancelled' && r < 0.3) snap = { ...snap, status: 'confirmed' }; // guest changed their mind
    else if (snap.status !== 'cancelled' && r < 0.25) snap = { ...snap, status: 'cancelled' };
    else if (snap.status === 'cancelled') continue;
    else if (r < 0.6) snap = { ...snap, roomType: pick(ROOMS) };
    else {
      const shift = int(-3, 3);
      snap = { ...snap, checkIn: addDays(snap.checkIn, shift), checkOut: addDays(snap.checkOut, shift) };
    }
    emit(snap.status === 'cancelled' ? 'reservation.cancelled' : 'reservation.updated');
  }
  return events;
}

const histories = Array.from({ length: N }, (_, i) => history(i + 1));
const allEvents = histories.flat();

// ── 2. Make the feed dirty: 1..MAX_COPIES copies of each event, fully shuffled ──
const deliveries = shuffle(allEvents.flatMap((e) => Array.from({ length: int(1, MAX_COPIES) }, () => e)));

// ── 3. Deliver like a webhook source: signed, concurrent, retry until 2xx ──────
const outcomes = { applied: 0, duplicate: 0, stale: 0 } as Record<string, number>;
let httpRetries = 0;

async function deliver(e: ReservationEvent) {
  const body = JSON.stringify(e);
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${args.url}/webhooks/pms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: sign(body, args.secret) },
        body,
      });
      if (res.ok) {
        const { outcome } = (await res.json()) as { outcome: string };
        outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
        return;
      }
      if (res.status < 500) throw Object.assign(new Error(`${res.status} ${await res.text()}`), { fatal: true });
    } catch (err) {
      if ((err as { fatal?: boolean }).fatal || attempt >= 5) throw err;
    }
    httpRetries++;
    await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
  }
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

const get = async <T>(path: string): Promise<T> => (await fetch(`${args.url}${path}`)).json() as Promise<T>;

try {
  await get('/health');
} catch {
  console.error(`✖ Can't reach the service at ${args.url}. Start it first with: npm start`);
  process.exit(1);
}

console.log(`\n▶ PMS simulator  seed=${SEED}  run=${RUN}`);
console.log(`  ${N} reservations, ${allEvents.length} distinct events, ${deliveries.length} deliveries `
  + `(${deliveries.length - allEvents.length} duplicates), shuffled, concurrency=${CONCURRENCY}\n`);

const started = performance.now();
await pool(deliveries, CONCURRENCY, deliver);
const elapsed = Math.round(performance.now() - started);

// Let the dispatcher drain the outbox (it may be retrying a flaky provider).
type OutboxRow = { reservation_id: string; status: string };
for (let i = 0; i < 120; i++) {
  const outbox = await get<OutboxRow[]>('/outbox');
  if (!outbox.some((r) => r.reservation_id.includes(RUN) && r.status === 'pending')) break;
  await new Promise((r) => setTimeout(r, 500));
}

// ── 4. Verify: local view == last true version, and emails are exactly-once ────
type Reservation = { id: string; version: number; status: string; roomType: string; checkIn: string; checkOut: string };
type Email = { to: string };
const view = new Map((await get<Reservation[]>('/reservations')).map((r) => [r.id, r]));
const emails = await get<Email[]>('/dev/emails').catch(() => [] as Email[]);
const emailCount = (to: string) => emails.filter((e) => e.to === to).length;

const failures: string[] = [];
let endConfirmed = 0;
let deliveredEmails = 0;
let maxPerGuest = 0;

for (const h of histories) {
  const truth = h[h.length - 1]!;
  const got = view.get(truth.reservationId);
  const want = { version: truth.version, status: truth.data.status, roomType: truth.data.roomType,
    checkIn: truth.data.checkIn, checkOut: truth.data.checkOut };
  if (!got) failures.push(`${truth.reservationId}: missing from local view`);
  else {
    for (const [k, v] of Object.entries(want)) {
      if (got[k as keyof Reservation] !== v) failures.push(`${truth.reservationId}: ${k} is ${got[k as keyof Reservation]}, expected ${v}`);
    }
  }

  const sent = emailCount(truth.data.guest.email);
  deliveredEmails += sent;
  maxPerGuest = Math.max(maxPerGuest, sent);
  if (sent > 1) failures.push(`${truth.reservationId}: guest got ${sent} confirmation emails`);
  if (truth.data.status === 'confirmed') {
    endConfirmed++;
    if (sent !== 1) failures.push(`${truth.reservationId}: ends confirmed but guest got ${sent} emails`);
  }
}

// Show one messy reservation end to end, so the run tells a story.
const showcase = histories.reduce((a, b) => (b.length > a.length ? b : a));
const arrival = deliveries.filter((d) => d.reservationId === showcase[0]!.reservationId).map((d) => `v${d.version}`);
const last = showcase[showcase.length - 1]!;
console.log(`  Example: ${last.reservationId} (${last.data.guest.name})`);
console.log(`    true history : ${showcase.map((e) => `v${e.version} ${e.data.status}/${e.data.roomType}`).join(' → ')}`);
console.log(`    arrival order: ${arrival.join(', ')}`);
const g = view.get(last.reservationId);
console.log(`    local view   : v${g?.version} ${g?.status}/${g?.roomType}  emails=${emailCount(last.data.guest.email)}\n`);

console.log(`  Webhook responses : applied=${outcomes.applied ?? 0}  duplicate=${outcomes.duplicate ?? 0}  stale=${outcomes.stale ?? 0}  (http retries: ${httpRetries})`);
console.log(`  Reservations      : ${N - new Set(failures.map((f) => f.split(':')[0])).size}/${N} match the PMS`);
// Guests whose reservation was cancelled after the email went out legitimately keep their one email,
// so "delivered" can exceed "end confirmed". What must hold: max 1 per guest, and every confirmed guest has 1.
console.log(`  Emails            : ${deliveredEmails} delivered, max per guest = ${maxPerGuest}, `
  + `${endConfirmed} reservations end confirmed (each must have exactly 1)`);
console.log(`  Time              : ${elapsed} ms\n`);

if (failures.length) {
  console.log(`✖ ${failures.length} problem(s):`);
  for (const f of failures.slice(0, 20)) console.log(`   - ${f}`);
  process.exit(1);
}
console.log('✔ Local view matches the PMS and every confirmed guest got exactly one email.\n');
