// Actual terminal-issued grants used only by adversarial tests. No production bypass.

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  confirmOperatorReview,
  initializeProtectedRegistry,
  openDatabase,
  resolveProject,
  SkillDistributionService,
  SkillOperatorService,
} from '../../packages/core/dist/index.js';

const { values } = parseArgs({
  options: {
    'project-root': { type: 'string' },
    db: { type: 'string' },
    version: { type: 'string' },
    scenario: { type: 'string' },
  },
});
const db = openDatabase(values.db);
try {
  const operator = new SkillOperatorService(db, resolveProject(values['project-root']));
  const publication = values.scenario === 'protected-distribution';
  const service = publication
    ? new SkillDistributionService(
        db,
        resolveProject(values['project-root']),
        join(values['project-root'], 'fake-home'),
      )
    : operator;
  const input = publication
    ? {
        skill_id: operator.prepare({ action: 'promote', version_id: values.version }).review
          .identity.id,
        target: 'codex',
        scope: 'project',
      }
    : { action: 'approve', version_id: values.version };
  const preview = publication ? service.plan(input) : service.prepare(input);
  const grant = await confirmOperatorReview(preview);
  let expected;
  if (values.scenario?.startsWith('protected')) {
    initializeProtectedRegistry(db, randomUUID());
    expected = 'PROTECTED_OPERATOR_REQUIRED';
  } else if (values.scenario === 'replay') {
    service.commit(input, grant);
    expected = 'OPERATOR_AUTHORIZATION_REQUIRED';
  } else {
    expected = 'STALE_OPERATOR_REVIEW';
    if (values.scenario === 'expired') {
      const now = Date.now();
      Date.now = () => now + 300001;
    }
  }
  try {
    service.commit(values.scenario === 'mismatch' ? { ...input, action: 'reject' } : input, grant);
    throw new Error('Grant incorrectly accepted');
  } catch (error) {
    if (error.code !== expected) throw error;
    process.stdout.write(`${JSON.stringify({ denied: expected })}\n`);
  }
} finally {
  db.close();
}
