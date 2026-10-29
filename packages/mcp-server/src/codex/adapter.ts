#!/usr/bin/env node
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { AgentMindError, enrollmentSchema, safeError } from '@agentmind/core';
import { readConfig } from '../config.js';
import { startServer } from '../runtime.js';
import { DAILY_TOOLS } from './configuration.js';
import { assertCallerProject, ENROLLMENT, rejectLinks } from './project.js';
export function loadEnrollment(path: string, cwd = process.cwd()) {
  if (!isAbsolute(path))
    throw new AgentMindError('CODEX_ENROLLMENT_INVALID', 'Enrollment must be absolute.');
  const root = realpathSync(dirname(dirname(dirname(path))));
  const expected = rejectLinks(root, ENROLLMENT);
  if (realpathSync(path) !== expected)
    throw new AgentMindError(
      'CODEX_ENROLLMENT_INVALID',
      'Enrollment location does not match the project.',
    );
  path = expected;
  const s = lstatSync(path);
  if (!s.isFile() || s.size > 4096)
    throw new AgentMindError('CODEX_ENROLLMENT_INVALID', 'Invalid enrollment file.');
  const record = enrollmentSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const scope = assertCallerProject(record.project_root, cwd);
  if (record.project_root !== root || record.project_id !== scope.id)
    throw new AgentMindError(
      'CODEX_SCOPE_DENIED',
      'Enrollment moved or project identity changed; explicit operator re-enrollment is required.',
    );
  return record;
}
async function main() {
  const { values } = parseArgs({
    options: { enrollment: { type: 'string' } },
    strict: true,
    allowPositionals: false,
  });
  if (!values.enrollment)
    throw new AgentMindError(
      'CODEX_ENROLLMENT_INVALID',
      'An explicit enrollment file is required.',
    );
  const record = loadEnrollment(values.enrollment);
  const config = readConfig([
    '--project-root',
    record.project_root,
    '--db',
    record.database,
    '--source-agent',
    'codex',
    '--enable-learning',
    '--enable-authoring',
    '--enable-retrieval',
  ]);
  await startServer(config, true, DAILY_TOOLS);
}

// Separate parser module is imported by the installer/tests; the entry guard never starts a server on import.
import { fileURLToPath } from 'node:url';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main().catch((e) => {
    const f = safeError(e);
    console.error(`[agentmind] ${f.code}: ${f.message}`);
    process.exitCode = 1;
  });
