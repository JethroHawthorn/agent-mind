import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  AgentMindError,
  DATABASE_INDEXES,
  migrateDatabase,
  migrateRetrieval,
  openDatabase,
  openUsageDatabase,
  planDatabaseMigration,
  SCHEMA_VERSION,
} from '@agentmind/core';

function fail(code: string): never {
  throw new AgentMindError(
    code,
    'Registry readiness refused; preserve the registry and inspect database maintenance guidance.',
  );
}

/** No chmod of existing directories/files; reject aliases and unsafe leaf/sidecar ownership. */
export function registryLocation(path: string) {
  if (!path?.startsWith('/') || resolve(path) !== path) fail('INSTALLER_DATABASE_PATH');
  const absent: string[] = [];
  let ancestor = dirname(path);
  while (!existsSync(ancestor)) {
    // existsSync follows dangling links; lstat must still reject those.
    try {
      lstatSync(ancestor);
      fail('INSTALLER_DATABASE_PATH');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    absent.unshift(ancestor);
    ancestor = dirname(ancestor);
  }
  const directory = lstatSync(ancestor);
  if (!directory.isDirectory() || directory.isSymbolicLink() || realpathSync(ancestor) !== ancestor)
    fail('INSTALLER_DATABASE_PATH');
  accessSync(ancestor, constants.W_OK | constants.X_OK);
  if ((directory.mode & 0o200) === 0) fail('INSTALLER_DATABASE_PERMISSION');
  if (
    !absent.length &&
    (directory.mode & 0o077 || (process.getuid && directory.uid !== process.getuid()))
  )
    fail('INSTALLER_DATABASE_PERMISSION');
  for (const name of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    try {
      const file = lstatSync(name);
      if (
        !file.isFile() ||
        file.isSymbolicLink() ||
        file.nlink !== 1 ||
        realpathSync(name) !== name
      )
        fail('INSTALLER_DATABASE_PATH');
      if (file.mode & 0o077 || (process.getuid && file.uid !== process.getuid()))
        fail('INSTALLER_DATABASE_PERMISSION');
      if (name === path) accessSync(name, constants.R_OK | constants.W_OK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return { absent, exists: existsSync(path) };
}

/** Read only the header, not a live SQLite connection: preview creates no WAL/SHM coordination files.
 * Header versions may lag a live WAL. Full schema/ledger validation is explicitly deferred to apply.
 */
export function previewRegistry(path: string) {
  const location = registryLocation(path);
  if (!location.exists)
    return {
      ...location,
      observed_schema: null,
      pending: Array.from({ length: SCHEMA_VERSION }, (_, i) => i + 1),
      operation: 'CREATE_AND_BOOTSTRAP',
      authority: 'NEW_REGISTRY_SETUP_APPLY',
    };
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const header = Buffer.alloc(100),
      bytes = readSync(fd, header, 0, 100, 0);
    const stat = fstatSync(fd);
    if (stat.ino !== lstatSync(path).ino || stat.dev !== lstatSync(path).dev)
      fail('INSTALLER_DATABASE_CONFLICT');
    if (bytes !== 0 && (bytes < 100 || header.subarray(0, 16).toString() !== 'SQLite format 3\0'))
      fail('SQLITE_NOTADB');
    const version = bytes === 0 ? 0 : header.readUInt32BE(60);
    return {
      ...location,
      observed_schema: version,
      pending: 'DEFERRED_LIVE_SCHEMA_CHECK',
      operation: 'INSPECT_AND_REUSE',
      authority: 'EXISTING_PENDING_MIGRATIONS_REQUIRE_OWNER_DIGEST',
      header_only: true,
    };
  } finally {
    closeSync(fd);
  }
}

export function prepareRegistry(path: string, stage: (name: string) => void) {
  stage('registry');
  const location = registryLocation(path);
  let created = false;
  if (!location.exists) {
    for (const directory of location.absent) {
      mkdirSync(directory, { mode: 0o700 });
      if (realpathSync(directory) !== directory) fail('INSTALLER_DATABASE_PATH');
    }
    registryLocation(path);
    const fd = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    closeSync(fd);
    created = true;
  }
  stage('schema');
  // The existing explicit digest boundary is preserved for every pre-existing pending schema.
  const plan = planDatabaseMigration(path);
  if (!created && plan.pending.length) fail('INSTALLER_MIGRATION_OWNER_REQUIRED');
  if (created) migrateDatabase(path, plan.digest);
  const db = created ? openDatabase(path, { supervisedOnly: true }) : openUsageDatabase(path);
  try {
    const needsRetrieval =
      !db.prepare("SELECT 1 FROM sqlite_master WHERE name='retrieval_schema'").get() ||
      !db.prepare("SELECT 1 FROM sqlite_master WHERE name='hybrid_discovery_schema'").get();
    if (needsRetrieval) {
      const versions = (db.prepare('SELECT count(*) n FROM skill_versions').get() as { n: number })
        .n;
      if (versions) fail('INSTALLER_INDEX_INITIALIZATION_REQUIRED');
      migrateRetrieval(db);
    }
    stage('fts');
    if (db.pragma('quick_check', { simple: true }) !== 'ok') fail('DATABASE_UNHEALTHY');
    // FTS control commands verify postings, including external-content consistency. No user record
    // is inserted. Roll back even on success; never run a rebuild as part of health checking.
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const table of DATABASE_INDEXES) {
        db.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ? LIMIT 0`).all('agentmind');
        db.exec(`INSERT INTO ${table}(${table},rank) VALUES('integrity-check',1)`);
      }
    } finally {
      db.exec('ROLLBACK');
    }
  } finally {
    db.close();
  }
  // Reopen through the same read-only owner migration preflight, verifying schema/ledger/digest.
  const ready = planDatabaseMigration(path);
  if (ready.pending.length) fail('MIGRATION_REQUIRED');
  return {
    path,
    created,
    schema: SCHEMA_VERSION,
    schema_digest: ready.digest,
    migrations_applied: created ? plan.pending : [],
    provenance: 'EXISTING_CORE_MIGRATION_LEDGER',
    fts5: 'PASS',
    index_rebuild: false,
  };
}
