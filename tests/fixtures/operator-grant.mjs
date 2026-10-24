// Actual terminal-issued grants used only by adversarial tests. No production bypass.
import { parseArgs } from 'node:util';
import {
  confirmOperatorReview,
  openDatabase,
  resolveProject,
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
  const service = new SkillOperatorService(db, resolveProject(values['project-root']));
  const input = { action: 'approve', version_id: values.version };
  const grant = await confirmOperatorReview(service.prepare(input));
  let expected;
  if (values.scenario === 'replay') {
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
