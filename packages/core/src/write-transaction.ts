import { randomInt } from 'node:crypto';
import type Database from 'better-sqlite3';

const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Retry only failed BEGIN IMMEDIATE lock acquisition, before the callback runs.
 * Nested writes belong to the outer transaction and must not be replayed independently.
 * Four 100ms lock waits plus <=175ms backoff; the prior connection timeout is restored.
 */
export function agentWrite<T>(db: Database.Database, operation: () => T): T {
  if (db.inTransaction) return operation();
  const previous = Number(db.pragma('busy_timeout', { simple: true }));
  db.pragma('busy_timeout=100');
  try {
    for (let attempt = 0; ; attempt++) {
      let started = false;
      try {
        return db
          .transaction(() => {
            started = true;
            return operation();
          })
          .immediate();
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (
          started ||
          attempt >= 3 ||
          db.inTransaction ||
          typeof code !== 'string' ||
          !(code === 'SQLITE_BUSY' || code.startsWith('SQLITE_BUSY_'))
        )
          throw error;
        Atomics.wait(sleeper, 0, 0, 20 * 2 ** attempt + randomInt(0, 11));
      }
    }
  } finally {
    db.pragma(`busy_timeout=${previous}`);
  }
}
