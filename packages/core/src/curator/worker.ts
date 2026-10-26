// Code-owned one-shot SELECT-only analysis. This process is a resource governor, not a sandbox.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { openDatabaseReadOnly } from '../database.js';
import { collectCuratorEvidence } from './data.js';
import { curatorDigest, curatorPolicySchema, workerResultSchema } from './model.js';
import { generateCuratorRecommendations } from './rules.js';
import { duplicatePolicySchema } from './similarity/model.js';
import { runSimilarity } from './similarity/pipeline.js';

try {
  const input = readFileSync(0, 'utf8');
  if (Buffer.byteLength(input) > 16384) throw new Error('input bound');
  const p = z
    .strictObject({
      database: z.string().startsWith('/'),
      scope: z.strictObject({ id: z.string().regex(/^[a-f0-9]{64}$/), root: z.string().max(4096) }),
      policy: curatorPolicySchema,
      as_of: z.iso.datetime(),
      similarity: z
        .strictObject({ policy: duplicatePolicySchema, input: z.unknown(), compare: z.boolean() })
        .optional(),
    })
    .parse(JSON.parse(input));
  const db = openDatabaseReadOnly(p.database);
  db.pragma('busy_timeout=150');
  db.pragma('cache_size=-2048');
  db.pragma('mmap_size=0');
  try {
    const result = db.transaction(() => {
      if (p.similarity)
        return runSimilarity(
          db,
          p.scope,
          p.similarity.policy,
          p.similarity.input,
          p.similarity.compare,
        );
      const collection = collectCuratorEvidence(db, p.scope, p.policy);
      const source_digest = curatorDigest(collection);
      const drafts = generateCuratorRecommendations(collection, p.policy, p.as_of);
      return workerResultSchema.parse({ drafts, source_digest, coverage: collection.coverage });
    })();
    process.stdout.write(JSON.stringify(result));
  } finally {
    db.close();
  }
} catch {
  process.stderr.write('[agentmind] CURATOR_WORKER_FAILED\n');
  process.exitCode = 1;
}
