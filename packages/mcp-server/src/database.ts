import { parseArgs } from 'node:util';
import {
  AgentMindError,
  backupDatabase,
  checkpointDatabase,
  inspectDatabase,
  migrateDatabase,
  planDatabaseBackup,
  planDatabaseMigration,
  rebuildDatabaseIndexes,
  stageDatabaseRestore,
  verifyDatabaseBackup,
} from '@agentmind/core';
import { diagnosticText } from './installer/files.js';
export const databaseHelp = `AgentMind database maintenance (supervised local owner only)
 agentmind db status|doctor --db PATH [--deep] [--json]
 agentmind db migrate --db PATH [--dry-run | --apply --schema-digest SHA256]
 agentmind db index status|rebuild --db PATH [--dry-run | --apply]
 agentmind db checkpoint --db PATH [--dry-run | --apply]  PASSIVE only
 agentmind db backup --db PATH --output NEW_BUNDLE [--dry-run | --apply --whole-registry]
 agentmind db verify-backup --bundle PATH --checksum SHA256
 agentmind db restore --bundle PATH --checksum SHA256 --output NEW_OFFLINE_FILE [--dry-run | --apply --whole-registry]
All mutations require --apply; default is read-only planning. --json is supported.
Backups contain ALL projects; --whole-registry acknowledges owner-wide export/restore.
Output and source maintenance directories must already be private (0700), files 0600.
Restore stages to an absent offline file; never replaces a live registry. External distribution
artifacts require separate reconciliation. No encryption, credentials, models or arbitrary SQL.
Protected broker registries require the operator deployment workflow; local writes/export/restore
are refused. Deep doctor can be expensive; it performs no repair. Status never migrates.
Exit: 0 success, 2 incomplete, 3 conflict, 4 arguments, 6 permission, 1 failure.`;
export async function runDatabaseCLI(args: string[]) {
  const { values: v, positionals: p } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' },
      db: { type: 'string' },
      deep: { type: 'boolean' },
      apply: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'whole-registry': { type: 'boolean' },
      'schema-digest': { type: 'string' },
      output: { type: 'string' },
      bundle: { type: 'string' },
      checksum: { type: 'string' },
    },
  });
  if (v.help) {
    process.stdout.write(`${databaseHelp}\n`);
    return;
  }
  const action = p.join(' '),
    actions = [
      'status',
      'doctor',
      'migrate',
      'index status',
      'index rebuild',
      'checkpoint',
      'backup',
      'verify-backup',
      'restore',
    ];
  const mutation = ['migrate', 'index rebuild', 'checkpoint', 'backup', 'restore'].includes(action);
  const allowed: Record<string, string[]> = {
    status: ['db'],
    doctor: ['db', 'deep'],
    migrate: ['db', 'apply', 'dry-run', 'schema-digest'],
    'index status': ['db'],
    'index rebuild': ['db', 'apply', 'dry-run'],
    checkpoint: ['db', 'apply', 'dry-run'],
    backup: ['db', 'output', 'apply', 'dry-run', 'whole-registry'],
    'verify-backup': ['bundle', 'checksum'],
    restore: ['bundle', 'checksum', 'output', 'apply', 'dry-run', 'whole-registry'],
  };
  if (
    !actions.includes(action) ||
    Object.keys(v).some((key) => key !== 'json' && !allowed[action]?.includes(key)) ||
    (v.apply && (!mutation || v['dry-run'])) ||
    (['restore', 'backup'].includes(action) && v.apply && !v['whole-registry'])
  )
    throw new AgentMindError(
      'INVALID_INPUT',
      'Use db --help; mutations require --apply and whole-registry consent where documented.',
    );
  const required = (value: string | undefined) => {
    if (!value)
      throw new AgentMindError(
        'INVALID_INPUT',
        'Missing required database, output, bundle, checksum or schema digest. Use db --help.',
      );
    return value;
  };
  let result: unknown;
  switch (action) {
    case 'status':
    case 'doctor':
    case 'index status':
      result = inspectDatabase(required(v.db), !!v.deep);
      break;
    case 'migrate':
      result = v.apply
        ? migrateDatabase(required(v.db), required(v['schema-digest']))
        : planDatabaseMigration(required(v.db));
      break;
    case 'index rebuild':
      result = v.apply
        ? rebuildDatabaseIndexes(required(v.db))
        : { action, applied: false, inspection: inspectDatabase(required(v.db)) };
      break;
    case 'checkpoint':
      result = v.apply
        ? checkpointDatabase(required(v.db))
        : { action, applied: false, inspection: inspectDatabase(required(v.db)) };
      break;
    case 'backup':
      result = v.apply
        ? await backupDatabase(required(v.db), required(v.output))
        : planDatabaseBackup(required(v.db), required(v.output));
      break;
    case 'verify-backup':
      result = await verifyDatabaseBackup(required(v.bundle), required(v.checksum));
      break;
    case 'restore':
      result = await stageDatabaseRestore(
        required(v.bundle),
        required(v.output),
        required(v.checksum),
        !!v.apply,
      );
      break;
  }
  process.stdout.write(`${diagnosticText(result, !v.json)}\n`);
  const status = (result as { status?: string })?.status;
  process.exitCode = status === 'FAIL' ? 7 : status === 'WARNING' ? 2 : 0;
}
