import { openDatabase } from '../../packages/core/dist/index.js';
import { createShutdown } from '../../packages/mcp-server/dist/shutdown.js';

const [mode, dbPath] = process.argv.slice(2);
const db = openDatabase(dbPath);
// Simulate a live handle that would otherwise keep the stdio child around.
setInterval(() => {}, 1000);
const shutdown = createShutdown(
  {
    closeServer: () => (mode === 'stalled' ? new Promise(() => {}) : Promise.resolve()),
    closeDatabase: () => {
      if (db.open) {
        db.close();
        console.error('database closed');
      }
    },
  },
  100,
);
void shutdown();
