/**
 * Rebuilds the reservations table from the event log.
 *   DB_PATH=data.db npm run rebuild
 */
import { openDb } from '../src/db.ts';
import { rebuildReservations } from '../src/sync/rebuild.ts';

const path = process.env.DB_PATH ?? 'data.db';
const db = openDb(path);
const { reservations, changed } = rebuildReservations(db);
db.close();

console.log(`Rebuilt ${reservations} reservations from the event log (${path}).`);
if (changed.length) console.log(`${changed.length} differed from the stored view and were corrected: ${changed.join(', ')}`);
else console.log('All identical to the stored view.');
