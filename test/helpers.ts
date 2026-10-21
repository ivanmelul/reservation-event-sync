import type { ReservationEvent, ReservationSnapshot } from '../src/domain/events.ts';

export const snapshot = (over: Partial<ReservationSnapshot> = {}): ReservationSnapshot => ({
  status: 'pending',
  guest: { name: 'Ada Lovelace', email: 'ada@example.com' },
  checkIn: '2026-12-01',
  checkOut: '2026-12-05',
  roomType: 'Deluxe King',
  totalAmount: 1200,
  currency: 'USD',
  ...over,
});

export const event = (
  reservationId: string,
  version: number,
  type: ReservationEvent['type'],
  data: Partial<ReservationSnapshot> = {},
): ReservationEvent => ({
  eventId: `${reservationId}-v${version}`,
  reservationId,
  type,
  version,
  occurredAt: new Date(Date.UTC(2026, 9, 1, 0, version)).toISOString(),
  data: snapshot({ guest: { name: 'Guest', email: `${reservationId}@example.com` }, ...data }),
});
