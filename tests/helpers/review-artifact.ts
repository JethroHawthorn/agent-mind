import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/** Explicit opt-in only; routine tests never overwrite review evidence. */
export function writeReviewArtifact(name: string, value: unknown) {
  if (!/^(?:P5-003_(?:FAULT_TRACES|PERFORMANCE)|P5-002_PERFORMANCE)\.json$/.test(name))
    throw Error('Unsupported test artifact');
  const enabled = process.env.AGENTMIND_WRITE_REVIEW_ARTIFACTS === '1';
  const root = enabled
    ? (process.env.AGENTMIND_REVIEW_ARTIFACT_DIR ?? 'docs/reviews')
    : mkdtempSync(join(tmpdir(), 'agentmind-review-'));
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, name), JSON.stringify(value, null, 2), { mode: 0o600 });
  } finally {
    if (!enabled) rmSync(root, { recursive: true, force: true });
  }
}
