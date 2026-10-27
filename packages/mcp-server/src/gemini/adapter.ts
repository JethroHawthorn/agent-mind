#!/usr/bin/env node
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AgentMindError, enrollmentSchema, safeError } from '@agentmind/core';
import { DAILY_TOOLS } from '../codex/configuration.js';
import { assertCallerProject, rejectLinks } from '../codex/project.js';
import { readConfig } from '../config.js';
import { startServer } from '../runtime.js';

export function loadGeminiEnrollment(path: string, cwd = process.cwd()) {
  if (!isAbsolute(path))
    throw new AgentMindError('GEMINI_ENROLLMENT_INVALID', 'Use an absolute enrollment.');
  const root = realpathSync(dirname(dirname(dirname(path))));
  const expected = rejectLinks(root, '.agentmind/gemini/enrollment.json');
  if (realpathSync(path) !== expected)
    throw new AgentMindError('GEMINI_ENROLLMENT_INVALID', 'Invalid enrollment location.');
  const stat = lstatSync(expected);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096)
    throw new AgentMindError('GEMINI_ENROLLMENT_INVALID', 'Unsafe enrollment.');
  const input = JSON.parse(readFileSync(expected, 'utf8'));
  if (input.integration !== 'agentmind-gemini-v1')
    throw new AgentMindError('GEMINI_ENROLLMENT_INVALID', 'Wrong integration.');
  // Reuse the existing strict contract without broadening Codex enrollment compatibility.
  const record = enrollmentSchema.parse({ ...input, integration: 'agentmind-codex-v1' });
  const scope = assertCallerProject(record.project_root, cwd);
  if (root !== record.project_root || scope.id !== record.project_id)
    throw new AgentMindError(
      'GEMINI_SCOPE_DENIED',
      'Enrollment moved or caller project differs; re-enroll explicitly.',
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
    throw new AgentMindError('GEMINI_ENROLLMENT_INVALID', 'Explicit enrollment is required.');
  const record = loadGeminiEnrollment(values.enrollment);
  await startServer(
    readConfig([
      '--project-root',
      record.project_root,
      '--db',
      record.database,
      '--source-agent',
      'gemini',
      '--enable-learning',
      '--enable-authoring',
      '--enable-retrieval',
    ]),
    true,
    DAILY_TOOLS,
  );
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((e) => {
    const f = safeError(e);
    console.error(`[agentmind] ${f.code}: ${f.message}`);
    process.exitCode = 1;
  });
