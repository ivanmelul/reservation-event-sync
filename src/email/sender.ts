export interface Email {
  to: string;
  subject: string;
  body: string;
}

export interface EmailSender {
  /** Providers like Resend/SES/Postmark accept an idempotency key; we model the same contract. */
  send(email: Email, idempotencyKey: string): Promise<void>;
}

/**
 * Simulated provider. Records every delivery so tests and the simulator can assert on it.
 * `failureRate` lets us exercise the retry path.
 */
export class FakeEmailSender implements EmailSender {
  readonly delivered: Array<Email & { idempotencyKey: string; at: Date }> = [];
  private readonly seenKeys = new Set<string>();

  constructor(
    private readonly opts: { failureRate?: number; log?: boolean; random?: () => number } = {},
  ) {}

  async send(email: Email, idempotencyKey: string): Promise<void> {
    const random = this.opts.random ?? Math.random;
    if (random() < (this.opts.failureRate ?? 0)) {
      throw new Error('simulated provider error (503)');
    }
    // Provider-side idempotency: a retry after a lost ack doesn't deliver twice.
    if (this.seenKeys.has(idempotencyKey)) return;
    this.seenKeys.add(idempotencyKey);
    this.delivered.push({ ...email, idempotencyKey, at: new Date() });
    if (this.opts.log) console.log(`📧 [email] to=${email.to} subject="${email.subject}"`);
  }

  countFor(to: string): number {
    return this.delivered.filter((e) => e.to === to).length;
  }
}
