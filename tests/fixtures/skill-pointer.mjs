// Raw SQL model concurrency fixture, not an application promotion command.
import { openDatabase } from '../../packages/core/dist/index.js';

const [path, payload] = process.argv.slice(2);
const db = openDatabase(path);
try {
  const params = JSON.parse(payload);
  db.prepare(`INSERT INTO skill_promotions (id, skill_id, project_id, from_version_id, to_version_id, approval_id,
    action, expected_revision, actor, reason, created_at) VALUES (@id, @skill_id, @project_id, @from_version_id,
    @to_version_id, @approval_id, 'promote', 0, 'fixture process', 'Synthetic concurrency test', @created_at)`).run(
    params,
  );
} catch {
  console.error('POINTER_CONFLICT');
  process.exitCode = 2;
} finally {
  db.close();
}
