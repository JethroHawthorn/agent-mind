#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  brokerRequest,
  loadBrokerClient,
  parseKnowledgeBundle,
  redactSecrets,
} from '@agentmind/core';
import Database from 'better-sqlite3';
import { assertCallerProject } from './codex/project.js';
import { diagnosticText } from './installer/files.js';

/** Legacy SQLite is read only by an unprivileged exporter, never by the broker. */
async function main() {
  const { values: v, positionals } = parseArgs({
    strict: true,
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      'source-db': { type: 'string' },
      'project-root': { type: 'string' },
      kind: { type: 'string' },
      limit: { type: 'string' },
      offset: { type: 'string' },
      bundle: { type: 'string' },
      'client-config': { type: 'string' },
      apply: { type: 'boolean' },
      'expected-project-id': { type: 'string' },
    },
  });
  if (v.help) {
    console.log(
      'Usage: broker:migrate export --source-db ABS --project-root ABS --kind memory|experience [--limit 1..10 --offset N]\n       broker:migrate import --bundle JSON [--client-config ROOT_OWNED_CLIENT --expected-project-id SHA256 --apply]\nExport from the legacy owner account only (never root/broker/operator). Imports preview by default and stage unverified records through agent IPC only. No skills, grants, evaluations or lifecycle history are transferred.',
    );
    return;
  }
  if (process.getuid?.() === 0 || process.geteuid?.() === 0)
    throw Error('ROOT_EXPORT_IMPORT_FORBIDDEN');
  if (positionals.length !== 1) throw Error('INVALID_ARGUMENTS');
  if (positionals[0] === 'export') {
    if (
      !v['source-db'] ||
      !v['project-root'] ||
      !['memory', 'experience'].includes(v.kind ?? '') ||
      v.apply ||
      v.bundle ||
      v['client-config'] ||
      v['expected-project-id']
    )
      throw Error('INVALID_EXPORT_ARGUMENTS');
    const scope = assertCallerProject(v['project-root']);
    const limit = Number(v.limit ?? 10),
      offset = Number(v.offset ?? 0);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 10 ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > 10000
    )
      throw Error('INVALID_PAGE');
    const fd = openSync(
      v['source-db'],
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const s = fstatSync(fd);
      if (!s.isFile() || s.size > 268435456) throw Error('SOURCE_LIMIT');
    } finally {
      closeSync(fd);
    }
    const db = new Database(v['source-db'], { readonly: true, fileMustExist: true, timeout: 1000 });
    try {
      db.pragma('query_only=ON');
      db.pragma('trusted_schema=OFF');
      const table = v.kind === 'memory' ? 'memories' : 'experiences';
      const declaration = db
        .prepare('SELECT type,sql FROM sqlite_master WHERE name=?')
        .get(table) as { type: string; sql: string } | undefined;
      if (
        declaration?.type !== 'table' ||
        !/^CREATE TABLE\s/i.test(declaration.sql) ||
        !/\bid\b/.test(declaration.sql)
      )
        throw Error('SOURCE_TABLE_UNSUPPORTED');
      const info = db.prepare(`PRAGMA table_xinfo(${table})`).all() as { hidden: number }[];
      if (info.some((c) => c.hidden !== 0)) throw Error('GENERATED_COLUMNS_UNSUPPORTED');
      const fields =
        v.kind === 'memory'
          ? 'id,substr(title,1,201) title,substr(content,1,4001) content,kind,(length(title)>200 OR length(content)>4000) oversized'
          : 'id,substr(problem,1,2001) problem,substr(solution,1,4001) solution,substr(outcome_summary,1,1001) outcome_summary,(length(problem)>2000 OR length(solution)>4000 OR length(outcome_summary)>1000) oversized';
      const rows = db
        .prepare(`SELECT ${fields} FROM ${table} WHERE project_id=? ORDER BY id LIMIT ? OFFSET ?`)
        .all(scope.id, limit + 1, offset) as Record<string, string>[];
      if (rows.some((row) => Number(row.oversized)))
        throw Error('SOURCE_RECORD_TOO_LARGE; no partial record exported');
      const items = rows.slice(0, limit).map((row) =>
        v.kind === 'memory'
          ? {
              kind: 'memory',
              source_ref: row.id,
              data: {
                title: redactSecrets(row.title ?? ''),
                content: redactSecrets(row.content ?? ''),
                kind: row.kind,
              },
            }
          : {
              kind: 'experience',
              source_ref: row.id,
              data: {
                problem: redactSecrets(row.problem ?? ''),
                solution: redactSecrets(row.solution ?? ''),
                outcome: {
                  status: 'unknown',
                  summary: redactSecrets(row.outcome_summary ?? 'Legacy outcome unavailable'),
                },
                evidence: [],
                provenance: {},
              },
            },
      );
      if (!items.length) {
        console.log(diagnosticText({ schema_version: 1, empty: true, next_offset: null }));
        return;
      }
      const bundle = parseKnowledgeBundle({
        schema_version: 1,
        source_namespace: createHash('sha256').update(`legacy-project:${scope.id}`).digest('hex'),
        items,
      });
      console.log(
        diagnosticText(
          {
            bundle,
            next_offset: rows.length > limit ? offset + limit : null,
            trust: 'UNVERIFIED_LEGACY_CLAIMS',
            discarded:
              'Approvals, evaluation, evidence attestations, original agent identity and active state were not copied.',
          },
          false,
        ),
      );
    } finally {
      db.close();
    }
  } else if (positionals[0] === 'import') {
    if (!v.bundle || v['source-db'] || v['project-root'] || v.kind || v.limit || v.offset)
      throw Error('INVALID_IMPORT_ARGUMENTS');
    const fd = openSync(v.bundle, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let raw: string;
    try {
      if (!fstatSync(fd).isFile()) throw Error('INVALID_BUNDLE');
      const b = Buffer.alloc(65537);
      let n = 0;
      while (n < b.length) {
        const count = readSync(fd, b, n, b.length - n, null);
        if (!count) break;
        n += count;
      }
      if (n > 65536) throw Error('BUNDLE_LIMIT');
      raw = b.subarray(0, n).toString('utf8');
    } finally {
      closeSync(fd);
    }
    const decoded: unknown = JSON.parse(raw);
    const bundle = parseKnowledgeBundle(
      decoded && typeof decoded === 'object' && 'bundle' in decoded ? decoded.bundle : decoded,
    );
    if (v.apply && !/^[a-f0-9]{64}$/.test(v['expected-project-id'] ?? ''))
      throw Error('EXPECTED_DESTINATION_REQUIRED');
    const result = v.apply
      ? await brokerRequest(loadBrokerClient(v['client-config'] ?? ''), 'agent', {
          schema_version: 1,
          op: 'knowledge_import',
          input: { bundle, expected_project_id: v['expected-project-id'] },
        })
      : {
          dry_run: true,
          items: bundle.items.map((i) => ({ kind: i.kind, source_ref: i.source_ref })),
          trust: 'UNVERIFIED_LEGACY_CLAIMS',
          requires: 'Explicit --apply under the enrolled runner UID; no approval transfer.',
        };
    console.log(diagnosticText(result, false));
  } else throw Error('UNKNOWN_ACTION');
}
main().catch(() => {
  console.error(
    'KNOWLEDGE_MIGRATION_DENIED: invalid, unsafe or unavailable input. No lifecycle state was imported.',
  );
  process.exitCode = 1;
});
