import type Database from 'better-sqlite3';

/** Only code-owned loaders are injected by tests; no CLI flag/environment can replace the driver. */
export async function verifySqliteDriver(
  load: () => Promise<{ default: typeof Database }> = () => import('better-sqlite3'),
) {
  let db: Database.Database | undefined;
  let stage = 'load';
  try {
    const { default: Driver } = await load();
    stage = 'connect';
    db = new Driver(':memory:');
    if ((db.prepare('SELECT 1 AS value').get() as { value: number }).value !== 1)
      throw Error('Unexpected SQLite result');
    stage = 'fts';
    db.exec(
      "CREATE VIRTUAL TABLE temp.setup_probe USING fts5(text); INSERT INTO temp.setup_probe VALUES('agentmind sqlite probe')",
    );
    if (
      (
        db
          .prepare("SELECT count(*) AS n FROM temp.setup_probe WHERE setup_probe MATCH 'sqlite'")
          .get() as { n: number }
      ).n !== 1
    )
      throw Error('Unexpected FTS result');
    return { status: 'PASS' as const, code: 'SQLITE_DRIVER_FTS5_READY' };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    const message = e.message ?? '';
    const code =
      stage === 'load' && /MODULE_NOT_FOUND/.test(e.code ?? '')
        ? 'SQLITE_DRIVER_MISSING'
        : /NODE_MODULE_VERSION|compiled against a different|ERR_DLOPEN_FAILED|incompatible.*architecture/i.test(
              `${e.code} ${message}`,
            )
          ? 'SQLITE_NATIVE_INCOMPATIBLE'
          : /Could not locate the bindings|Cannot find module.*\.node/i.test(message)
            ? 'SQLITE_BINDING_MISSING'
            : /unsupported.*(?:platform|architecture)|not supported.*(?:platform|architecture)/i.test(
                  message,
                )
              ? 'SQLITE_PLATFORM_UNSUPPORTED'
              : /EACCES|EPERM|SQLITE_PERM/.test(e.code ?? '')
                ? 'SQLITE_DRIVER_PERMISSION'
                : stage === 'fts'
                  ? 'SQLITE_FTS5_UNAVAILABLE'
                  : 'SQLITE_DRIVER_CONNECTION_FAILED';
    return { status: 'FAIL' as const, code };
  } finally {
    db?.close();
  }
}
