import { z } from 'zod';

/**
 * Event contract we assume from the PMS.
 *
 * Key assumptions (see README):
 * - `eventId` is unique per logical event. Redeliveries reuse the same id.
 * - `version` is monotonic per reservation, assigned by the PMS.
 * - `data` is a full snapshot of the reservation at that version, not a delta.
 *   This is what lets us resolve out-of-order delivery with "highest version wins".
 */
export const ReservationStatus = z.enum(['pending', 'confirmed', 'cancelled']);
export type ReservationStatus = z.infer<typeof ReservationStatus>;

export const ReservationSnapshot = z.object({
  status: ReservationStatus,
  guest: z.object({
    name: z.string().min(1),
    email: z.email(),
  }),
  checkIn: z.iso.date(),
  checkOut: z.iso.date(),
  roomType: z.string().min(1),
  totalAmount: z.number().nonnegative(),
  currency: z.string().length(3),
});
export type ReservationSnapshot = z.infer<typeof ReservationSnapshot>;

export const ReservationEvent = z.object({
  eventId: z.string().min(1),
  reservationId: z.string().min(1),
  type: z.enum(['reservation.created', 'reservation.updated', 'reservation.cancelled']),
  version: z.number().int().positive(),
  occurredAt: z.iso.datetime(),
  data: ReservationSnapshot,
});
export type ReservationEvent = z.infer<typeof ReservationEvent>;
