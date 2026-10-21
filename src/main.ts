import { openDb } from './db.ts';
import { OutboxDispatcher } from './email/dispatcher.ts';
import { FakeEmailSender } from './email/sender.ts';
import { buildServer } from './server.ts';

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? 'data.db';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'dev-secret';
// Set EMAIL_FAILURE_RATE=0.3 to watch the retry/backoff path in action.
const EMAIL_FAILURE_RATE = Number(process.env.EMAIL_FAILURE_RATE ?? 0);

const db = openDb(DB_PATH);
const sender = new FakeEmailSender({ log: true, failureRate: EMAIL_FAILURE_RATE });
const dispatcher = new OutboxDispatcher(db, sender);
const app = buildServer({
  db,
  webhookSecret: WEBHOOK_SECRET,
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  devEmails: () => sender.delivered,
});

dispatcher.start();
await app.listen({ port: PORT, host: '0.0.0.0' });

// Graceful shutdown: stop taking requests, stop the dispatcher, then close the DB.
// Anything mid-flight either committed or rolled back; pending outbox rows survive the restart.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    dispatcher.stop();
    await app.close();
    db.close();
    process.exit(0);
  });
}
