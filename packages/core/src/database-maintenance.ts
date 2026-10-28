import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  createReadStream,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import { migrate, SCHEMA_VERSION } from './database.js';
import { AgentMindError } from './errors.js';
import { hybridMetadataPrefix } from './retrieval/hybrid-storage.js';
import { hashSkillFiles } from './skill-model.js';
import { verifyCoreSchema } from './storage-reliability-migration.js';

/** Maintenance has no broker authority. A private path is not proof of operator identity. */
const fail = (code: string, message: string): never => {
  throw new AgentMindError(code, message);
};
export function classifySqliteError(error: unknown) {
  const code = (error as { code?: string })?.code ?? '';
  if (code === 'SQLITE_BUSY_SNAPSHOT') return 'SQLITE_BUSY_SNAPSHOT';
  for (const category of [
    'BUSY',
    'LOCKED',
    'READONLY',
    'FULL',
    'IOERR',
    'CORRUPT',
    'NOTADB',
    'SCHEMA',
    'PERM',
    'CANTOPEN',
  ])
    if (code === `SQLITE_${category}` || code.startsWith(`SQLITE_${category}_`))
      return `SQLITE_${category}`;
  return 'DATABASE_UNAVAILABLE';
}

/** Reject aliases, symlinks and hard links; do not chmod existing directories or files. */
function regular(path: string) {
  const absolute = resolve(path);
  const st = lstatSync(absolute);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || realpathSync(absolute) !== absolute)
    fail('DATABASE_PATH', 'Use a canonical regular database file without links.');
  return { path: absolute, dev: st.dev, ino: st.ino };
}
function unchanged(identity: ReturnType<typeof regular>) {
  const current = regular(identity.path);
  if (current.dev !== identity.dev || current.ino !== identity.ino)
    fail('DATABASE_CONFLICT', 'Database identity changed; inspect and plan again.');
}
function privateParent(path: string) {
  const p = dirname(resolve(path)),
    st = lstatSync(p);
  if (
    !st.isDirectory() ||
    realpathSync(p) !== p ||
    (process.getuid && st.uid !== process.getuid()) ||
    st.mode & 0o077
  )
    fail(
      'DATABASE_PERMISSIONS',
      'Maintenance output requires an existing private owner-only canonical directory.',
    );
  if (existsSync(resolve(path)))
    fail('DATABASE_CONFLICT', 'Output already exists; choose a new destination.');
  return { path: p, dev: st.dev, ino: st.ino };
}
function sameParent(parent: ReturnType<typeof privateParent>) {
  const st = lstatSync(parent.path);
  if (
    st.dev !== parent.dev ||
    st.ino !== parent.ino ||
    realpathSync(parent.path) !== parent.path ||
    st.mode & 0o077
  )
    fail('DATABASE_CONFLICT', 'Output directory changed; inspect and plan again.');
}
function owner(path: string) {
  const st = lstatSync(path),
    parent = lstatSync(dirname(path));
  if (
    (process.getuid && (st.uid !== process.getuid() || parent.uid !== process.getuid())) ||
    st.mode & 0o077 ||
    parent.mode & 0o077
  )
    fail(
      'DATABASE_PERMISSIONS',
      'Whole-registry maintenance requires private owner-controlled source files and directory.',
    );
}
function has(db: Database.Database, table: string) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}
function supervised(db: Database.Database) {
  if (has(db, 'broker_deployment'))
    fail(
      'PROTECTED_MAINTENANCE_UNAVAILABLE',
      'Protected registries require the separately authorized operator deployment workflow. Local maintenance is unavailable.',
    );
}
function connect(path: string, writable = false) {
  const id = regular(path);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      regular(id.path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const db = new Database(id.path, { readonly: !writable, fileMustExist: true, timeout: 1000 });
  try {
    unchanged(id);
    db.pragma('trusted_schema=OFF');
    // Current immutable schemas use JSON functions in CHECKs/triggers. Read-only diagnostics
    // do not execute triggers; explicit rebuild uses trusted repository SQL only.
    db.pragma('foreign_keys=ON');
    if (!writable) db.pragma('query_only=ON');
    else {
      supervised(db);
      owner(id.path);
      db.pragma('synchronous=FULL');
    }
    return { db, id };
  } catch (error) {
    db.close();
    throw error;
  }
}
function compatible(db: Database.Database) {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version !== SCHEMA_VERSION)
    fail(
      version > SCHEMA_VERSION ? 'SCHEMA_TOO_NEW' : 'MIGRATION_REQUIRED',
      'Schema is incompatible; inspect the migration plan with the matching release.',
    );
  verifyCoreSchema(db);
}

/** Historical snapshots remain at their original version until explicit migration.
 * Older schemas predate checksummed migration provenance; never fabricate that assurance.
 */
function backupCompatible(db: Database.Database) {
  const version = Number(db.pragma('user_version', { simple: true }));
  if (version < 1 || version > SCHEMA_VERSION)
    fail('SCHEMA_UNSUPPORTED', 'Backup requires a known versioned AgentMind registry.');
  if (version === SCHEMA_VERSION) verifyCoreSchema(db);
  db.prepare('SELECT id,canonical_path FROM projects LIMIT 0').all();
  db.prepare('SELECT id,project_id,title,content FROM memories LIMIT 0').all();
  return version;
}
export const DATABASE_INDEXES = [
  'memories_fts',
  'experiences_fts',
  'skills_fts',
  'skill_version_retrieval_fts',
  'skill_discovery_fts',
] as const;
/** Fingerprints actual schema definitions, not a claim about historical migration provenance. */
export function databaseSchemaDigest(db: Database.Database) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        db
          .prepare(
            'SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name',
          )
          .all(),
      ),
    )
    .digest('hex');
}
export function inspectDatabase(path: string, deep = false) {
  const { db, id } = connect(path);
  try {
    return db.transaction(() => {
      const schema = db.pragma('user_version', { simple: true }) as number;
      let schemaIntegrity = 'NOT_VERIFIED';
      if (schema === SCHEMA_VERSION) {
        try {
          verifyCoreSchema(db);
          schemaIntegrity = 'PASS';
        } catch {
          schemaIntegrity = 'FAIL';
        }
      }
      const check = deep ? db.pragma('integrity_check(1)') : null;
      const integrity =
        check === null
          ? 'NOT_VERIFIED'
          : JSON.stringify(check) === '[{"integrity_check":"ok"}]'
            ? 'PASS'
            : 'FAIL';
      const foreignKeys = deep
        ? !db.prepare('SELECT 1 FROM pragma_foreign_key_check LIMIT 1').get()
          ? 'PASS'
          : 'FAIL'
        : 'NOT_VERIFIED';
      unchanged(id);
      return {
        schema_version: 1,
        sqlite_version: db.prepare('SELECT sqlite_version() AS version').get(),
        schema,
        supported_schema: SCHEMA_VERSION,
        status:
          schema !== SCHEMA_VERSION ||
          schemaIntegrity === 'FAIL' ||
          integrity === 'FAIL' ||
          foreignKeys === 'FAIL'
            ? 'FAIL'
            : deep
              ? 'PASS'
              : 'WARNING',
        schema_structure: schemaIntegrity,
        schema_digest: databaseSchemaDigest(db),
        integrity,
        foreign_keys: foreignKeys,
        journal_mode: db.pragma('journal_mode', { simple: true }),
        connection_synchronous: db.pragma('synchronous', { simple: true }),
        connection_wal_autocheckpoint: db.pragma('wal_autocheckpoint', { simple: true }),
        connection_fullfsync: db.pragma('fullfsync', { simple: true }),
        connection_foreign_keys: db.pragma('foreign_keys', { simple: true }),
        busy_timeout_ms: db.pragma('busy_timeout', { simple: true }),
        indexes: DATABASE_INDEXES.map((name) => ({
          name,
          present: has(db, name),
          postings: 'NOT_VERIFIED',
        })),
        protected_registry: has(db, 'broker_deployment'),
        protected_os_deployment: 'NOT_VERIFIED',
        backup: has(db, 'broker_deployment')
          ? 'OPERATOR_REQUIRED'
          : 'WHOLE_REGISTRY_OWNER_CONSENT_REQUIRED',
        distribution_recovery: 'USE_DISTRIBUTION_STATUS_AND_VERIFY',
        limitations: [
          'Default checks do not scan database contents.',
          'Deep integrity/FK checks can be expensive; no repair or FTS posting verification occurs.',
          'Read-only access can require SQLite-managed WAL/SHM coordination.',
        ],
      };
    })();
  } finally {
    db.close();
  }
}

export function planDatabaseMigration(path: string) {
  const { db } = connect(path);
  try {
    supervised(db);
    const version = db.pragma('user_version', { simple: true }) as number;
    if (version < 0 || version > SCHEMA_VERSION)
      fail('SCHEMA_TOO_NEW', 'Unknown schema version; use a matching release.');
    if (version === SCHEMA_VERSION) verifyCoreSchema(db);
    if (
      version === 0 &&
      db.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()
    )
      fail(
        'SCHEMA_UNKNOWN',
        'Unversioned nonempty database requires explicit inspection; no migration plan is safe.',
      );
    return {
      schema_version: 1,
      from: version,
      to: SCHEMA_VERSION,
      pending: Array.from({ length: SCHEMA_VERSION - version }, (_, i) => version + i + 1),
      destructive_reset: false,
      digest: databaseSchemaDigest(db),
      available_bytes:
        statfsSync(dirname(resolve(path))).bavail * statfsSync(dirname(resolve(path))).bsize,
      authority: 'SUPERVISED_LOCAL_OWNER_ONLY',
    };
  } finally {
    db.close();
  }
}
export function migrateDatabase(path: string, expectedSchemaDigest: string) {
  const { db, id } = connect(path, true);
  try {
    // Existing original migrations contain trusted schema expressions.
    db.pragma('trusted_schema=ON');
    migrate(db, () => {
      unchanged(id);
      supervised(db);
      if (databaseSchemaDigest(db) !== expectedSchemaDigest)
        fail('DATABASE_CONFLICT', 'Schema changed after planning.');
    });
    return { status: 'PASS', schema: db.pragma('user_version', { simple: true }) };
  } finally {
    db.close();
  }
}

/** Explicit fixed allowlist; one transaction includes all rebuilds and verification. */
export function rebuildDatabaseIndexes(path: string) {
  const { db, id } = connect(path, true);
  try {
    compatible(db);
    db.pragma('trusted_schema=ON');
    return db
      .transaction(() => {
        unchanged(id);
        const rebuilt: string[] = [];
        for (const name of DATABASE_INDEXES.slice(0, 3)) {
          db.exec(
            `INSERT INTO ${name}(${name}) VALUES('rebuild'); INSERT INTO ${name}(${name},rank) VALUES('integrity-check',1)`,
          );
          rebuilt.push(name);
        }
        if (has(db, 'skill_version_retrieval_fts')) {
          db.exec(
            `DELETE FROM skill_version_retrieval_fts; INSERT INTO skill_version_retrieval_fts(rowid,name,description,version_id,project_id) SELECT v.rowid,k.name,v.description,v.id,v.project_id FROM skill_versions v JOIN skills k ON k.id=v.skill_id AND k.project_id=v.project_id`,
          );
          rebuilt.push('skill_version_retrieval_fts');
        }
        if (has(db, 'skill_discovery_fts')) {
          db.exec(
            `DELETE FROM skill_discovery_fts; INSERT INTO skill_discovery_fts(rowid,name,description,metadata,project_id,version_id,digest) SELECT v.rowid,k.name,v.description,${hybridMetadataPrefix('v.files_json')},v.project_id,v.id,v.content_hash FROM skill_versions v JOIN skills k ON k.id=v.skill_id AND k.project_id=v.project_id`,
          );
          rebuilt.push('skill_discovery_fts');
        }
        for (const name of rebuilt.slice(3))
          db.exec(`INSERT INTO ${name}(${name}) VALUES('integrity-check')`);
        unchanged(id);
        return { status: 'PASS', rebuilt, source_records_modified: false };
      })
      .immediate();
  } finally {
    db.close();
  }
}
export function checkpointDatabase(path: string) {
  const { db } = connect(path, true);
  try {
    compatible(db);
    return {
      mode: 'PASSIVE',
      result: db.pragma('wal_checkpoint(PASSIVE)'),
      guarantee: 'NO_FORCED_READER_EVICTION_OR_WAL_TRUNCATION',
    };
  } finally {
    db.close();
  }
}
async function digestFile(path: string) {
  const hash = createHash('sha256');
  for await (const part of createReadStream(path)) hash.update(part);
  return hash.digest('hex');
}
function durable(path: string) {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/** No arbitrary paths or SQL are taken from the recovery manifest. Packages are inline snapshots. */
function verifyContents(db: Database.Database) {
  const schema = backupCompatible(db);
  supervised(db);
  if (
    JSON.stringify(db.pragma('integrity_check(1)')) !== '[{"integrity_check":"ok"}]' ||
    db.prepare('SELECT 1 FROM pragma_foreign_key_check LIMIT 1').get()
  )
    fail('DATABASE_UNHEALTHY', 'Snapshot failed SQLite or foreign-key verification.');
  let packages = 0;
  for (const row of (has(db, 'skill_versions')
    ? db.prepare('SELECT files_json,content_hash FROM skill_versions').iterate()
    : []) as Iterable<{ files_json: string; content_hash: string }>) {
    if (hashSkillFiles(JSON.parse(row.files_json)) !== row.content_hash)
      fail('PACKAGE_INTEGRITY', 'Snapshot contains an invalid immutable package.');
    packages++;
  }
  const records = createHash('sha256');
  const tables = db
    .prepare(
      "SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string; sql: string }[];
  const virtuals = tables.filter((t) => /^CREATE VIRTUAL TABLE/i.test(t.sql)).map((t) => t.name);
  for (const table of tables) {
    if (virtuals.some((v) => table.name === v || table.name.startsWith(`${v}_`))) continue;
    // Names are identifiers read from the schema, quoted rather than interpolated as SQL.
    const quoted = `"${table.name.replaceAll('"', '""')}"`;
    records.update(`${table.name}\0`);
    for (const row of db.prepare(`SELECT * FROM ${quoted} ORDER BY rowid`).iterate())
      records.update(`${JSON.stringify(row)}\n`);
  }
  const active = has(db, 'skills')
    ? db
        .prepare(
          'SELECT id,project_id,active_version_id FROM skills WHERE active_version_id IS NOT NULL ORDER BY id',
        )
        .all()
    : [];
  return {
    packages,
    schema,
    canonical_records_digest: records.digest('hex'),
    registry_identity: has(db, 'skill_registry_identity')
      ? db.prepare('SELECT id FROM skill_registry_identity WHERE singleton=1').get()
      : null,
    fts_postings: 'NOT_VERIFIED_CONTROLLED_REBUILD_AVAILABLE',
    active_digest: createHash('sha256').update(JSON.stringify(active)).digest('hex'),
    schema_digest: databaseSchemaDigest(db),
    external_artifacts: 'NOT_INCLUDED_RECONCILIATION_REQUIRED',
    lifecycle_authority: 'SNAPSHOT_ONLY_NOT_NEW_APPROVAL',
    evaluation_authority: 'UNCHANGED_NOT_REVERIFIED',
  };
}
export function planDatabaseBackup(path: string, output: string) {
  const parent = privateParent(output),
    { db, id } = connect(path);
  try {
    supervised(db);
    owner(id.path);
    backupCompatible(db);
    return {
      schema_version: 1,
      source_schema_digest: databaseSchemaDigest(db),
      scope: 'ENTIRE_REGISTRY_ALL_PROJECTS',
      output: resolve(output),
      free_bytes: statfsSync(parent.path).bavail * statfsSync(parent.path).bsize,
      source_bytes: lstatSync(id.path).size,
      protection: 'PRIVATE_FILES_NOT_ENCRYPTION',
      protected_maintenance: 'UNAVAILABLE',
      external_artifacts: 'NOT_INCLUDED',
    };
  } finally {
    db.close();
  }
}
/** Online backup includes committed WAL; cancelled/failed bundles are never published. */
export async function backupDatabase(path: string, output: string, signal?: AbortSignal) {
  if (signal?.aborted) fail('BACKUP_CANCELLED', 'Backup was cancelled before starting.');
  planDatabaseBackup(path, output);
  const parent = privateParent(output),
    { db, id } = connect(path);
  const stage = mkdtempSync(join(parent.path, '.agentmind-backup-'));
  chmodSync(stage, 0o700);
  const snapshot = join(stage, 'registry.sqlite');
  const deadline = Date.now() + 60_000;
  try {
    supervised(db);
    backupCompatible(db);
    await db.backup(snapshot, {
      progress: () => {
        if (signal?.aborted || Date.now() > deadline)
          fail('BACKUP_CANCELLED', 'Backup cancelled or exceeded its bounded time budget.');
        unchanged(id);
        return 100;
      },
    });
    chmodSync(snapshot, 0o600);
    // Normalize only the disposable copy: portable backups must not require WAL/SHM.
    const standalone = new Database(snapshot, { fileMustExist: true, timeout: 1000 });
    try {
      standalone.pragma('journal_mode=DELETE');
    } finally {
      standalone.close();
    }
    const copy = connect(snapshot);
    let contents: ReturnType<typeof verifyContents>;
    try {
      contents = verifyContents(copy.db);
    } finally {
      copy.db.close();
    }
    if (signal?.aborted || Date.now() > deadline)
      fail('BACKUP_CANCELLED', 'Backup cancelled before publication.');
    const manifest = {
      format: 'agentmind-sqlite-backup-v1',
      id: randomUUID(),
      created_at: new Date().toISOString(),
      sha256: await digestFile(snapshot),
      ...contents,
    };
    writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    durable(snapshot);
    durable(join(stage, 'manifest.json'));
    durable(stage);
    unchanged(id);
    sameParent(parent);
    // Directory rename would replace an empty user directory. Claim the requested bundle
    // as a new private directory, then publish files without replacement; marker is last.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(resolve(output), { mode: 0o700 });
    // Partial bundles are explicitly invalid and never auto-resumed.
    linkSync(snapshot, join(resolve(output), 'registry.sqlite'));
    linkSync(join(stage, 'manifest.json'), join(resolve(output), 'manifest.json'));
    durable(resolve(output));
    durable(parent.path);
    return manifest;
  } finally {
    db.close();
    rmSync(stage, { recursive: true, force: true });
  }
}
export async function verifyDatabaseBackup(bundle: string, expectedChecksum: string) {
  if (!/^[a-f0-9]{64}$/.test(expectedChecksum))
    fail(
      'BACKUP_CHECKSUM',
      'Supply the reviewed snapshot SHA-256. A checksum is not an operator signature.',
    );
  const base = resolve(bundle),
    snapshot = join(base, 'registry.sqlite');
  if (realpathSync(base) !== base || !lstatSync(base).isDirectory())
    fail('BACKUP_PATH', 'Use a canonical backup directory.');
  regular(snapshot);
  regular(join(base, 'manifest.json'));
  if (lstatSync(join(base, 'manifest.json')).size > 16_384)
    fail('BACKUP_METADATA', 'Backup manifest exceeds its size limit.');
  const manifest = JSON.parse(readFileSync(join(base, 'manifest.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  if (
    typeof manifest.id !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(manifest.id) ||
    typeof manifest.created_at !== 'string' ||
    !Number.isFinite(Date.parse(manifest.created_at)) ||
    manifest.format !== 'agentmind-sqlite-backup-v1' ||
    typeof manifest.schema !== 'number' ||
    manifest.schema < 1 ||
    manifest.schema > SCHEMA_VERSION ||
    manifest.sha256 !== expectedChecksum ||
    (await digestFile(snapshot)) !== expectedChecksum
  )
    fail('BACKUP_CHECKSUM', 'Backup identity, checksum or schema does not match.');
  // A backup is self-contained. Unexpected WAL could otherwise override reviewed bytes.
  for (const suffix of ['-wal', '-shm', '-journal'])
    if (existsSync(snapshot + suffix))
      fail('BACKUP_SIDECAR', 'Backup contains unexpected SQLite sidecars.');
  const { db, id } = connect(snapshot);
  try {
    const contents = verifyContents(db);
    if (
      contents.schema !== manifest.schema ||
      contents.schema_digest !== manifest.schema_digest ||
      contents.active_digest !== manifest.active_digest ||
      contents.packages !== manifest.packages ||
      contents.canonical_records_digest !== manifest.canonical_records_digest
    )
      fail('BACKUP_METADATA', 'Backup recovery manifest disagrees with the snapshot.');
    unchanged(id);
    return { status: 'PASS', sha256: expectedChecksum, ...contents };
  } finally {
    db.close();
  }
}
/** Restore only to a new offline staging file, never replace live or protected state. */
export async function stageDatabaseRestore(
  bundle: string,
  output: string,
  checksum: string,
  apply = false,
) {
  const parent = privateParent(output);
  const verification = await verifyDatabaseBackup(bundle, checksum);
  if (resolve(output).startsWith(resolve(bundle) + sep))
    fail('RESTORE_PATH', 'Restore outside the source backup.');
  if (!apply)
    return {
      ...verification,
      action: 'RESTORE_TO_NEW_OFFLINE_FILE',
      applied: false,
      adoption: 'MANUAL_SUPERVISED_RECOVERY_ONLY',
      external_artifacts: 'RECONCILIATION_REQUIRED',
    };
  const stage = mkdtempSync(join(parent.path, '.agentmind-restore-'));
  chmodSync(stage, 0o700);
  try {
    const target = join(stage, 'registry.sqlite');
    copyFileSync(join(resolve(bundle), 'registry.sqlite'), target, constants.COPYFILE_EXCL);
    if ((await digestFile(target)) !== checksum)
      fail('BACKUP_CHECKSUM', 'Backup changed during restore staging.');
    chmodSync(target, 0o600);
    // Staged bytes must match the reviewed snapshot exactly.
    const restored = connect(target);
    try {
      verifyContents(restored.db);
    } finally {
      restored.db.close();
    }
    await verifyDatabaseBackup(bundle, checksum);
    sameParent(parent);
    durable(target);
    linkSync(target, resolve(output));
    durable(parent.path);
    return {
      ...verification,
      applied: true,
      adoption: 'OFFLINE_STAGED_ONLY',
      external_artifacts: 'RECONCILIATION_REQUIRED',
    };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
