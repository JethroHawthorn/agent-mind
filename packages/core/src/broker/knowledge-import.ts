import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { AgentMindError } from '../errors.js';
import { ExperienceService } from '../experience.js';
import { experienceRecordSchema } from '../experience-schemas.js';
import { MemoryService } from '../memory.js';
import type { ProjectScope } from '../project.js';
import { saveSchema } from '../schemas.js';
import type { SourceAgent } from '../source-agent.js';
export const knowledgeBundleSchema = z.strictObject({
  schema_version: z.literal(1),
  source_namespace: z.string().regex(/^[a-f0-9]{64}$/),
  items: z
    .array(
      z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('memory'), source_ref: z.uuid(), data: saveSchema }),
        z.strictObject({
          kind: z.literal('experience'),
          source_ref: z.uuid(),
          data: experienceRecordSchema,
        }),
      ]),
    )
    .min(1)
    .max(10),
});
export function parseKnowledgeBundle(input: unknown) {
  try {
    if (Buffer.byteLength(JSON.stringify(input)) > 65536) throw Error();
    return knowledgeBundleSchema.parse(input);
  } catch {
    throw new AgentMindError(
      'KNOWLEDGE_IMPORT_INVALID',
      'Invalid or oversized logical knowledge bundle; lifecycle and verified fields are forbidden.',
    );
  }
}
export function migrateKnowledgeImport(db: Database.Database) {
  db.transaction(() =>
    db.exec(`CREATE TABLE IF NOT EXISTS broker_knowledge_imports(
 project_id TEXT NOT NULL,source_namespace TEXT NOT NULL,kind TEXT NOT NULL,source_ref TEXT NOT NULL,digest TEXT NOT NULL,target_id TEXT NOT NULL,source_uid INTEGER NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(project_id,source_namespace,kind,source_ref));
 CREATE TRIGGER IF NOT EXISTS knowledge_import_no_update BEFORE UPDATE ON broker_knowledge_imports BEGIN SELECT RAISE(ABORT,'immutable import provenance');END;
 CREATE TRIGGER IF NOT EXISTS knowledge_import_no_delete BEFORE DELETE ON broker_knowledge_imports BEGIN SELECT RAISE(ABORT,'immutable import provenance');END;
 CREATE TRIGGER IF NOT EXISTS knowledge_import_no_replace BEFORE INSERT ON broker_knowledge_imports WHEN EXISTS(SELECT 1 FROM broker_knowledge_imports WHERE project_id=NEW.project_id AND source_namespace=NEW.source_namespace AND kind=NEW.kind AND source_ref=NEW.source_ref) BEGIN SELECT RAISE(ABORT,'immutable import provenance');END;`),
  ).immediate();
}
/** Only nonprivileged content is imported. Legacy IDs are opaque claims, never grants. */
export function importKnowledge(
  db: Database.Database,
  scope: ProjectScope,
  source: SourceAgent,
  uid: number,
  input: unknown,
) {
  const request = z
    .strictObject({
      expected_project_id: z.string().regex(/^[a-f0-9]{64}$/),
      bundle: knowledgeBundleSchema,
    })
    .safeParse(input);
  if (!request.success)
    throw new AgentMindError(
      'KNOWLEDGE_IMPORT_INVALID',
      'Expected an exact destination guard and bounded unverified bundle.',
    );
  if (request.data.expected_project_id !== scope.id)
    throw new AgentMindError(
      'KNOWLEDGE_IMPORT_SCOPE_CHANGED',
      'Destination does not match the authenticated runner scope.',
    );
  const p = parseKnowledgeBundle(request.data.bundle);
  return db
    .transaction(() => {
      const memory = new MemoryService(db, scope, source),
        experience = new ExperienceService(db, scope, source);
      const items = p.items.map((item) => {
        const digest = createHash('sha256').update(JSON.stringify(item)).digest('hex');
        const prior = db
          .prepare(
            'SELECT digest,target_id FROM broker_knowledge_imports WHERE project_id=? AND source_namespace=? AND kind=? AND source_ref=?',
          )
          .get(scope.id, p.source_namespace, item.kind, item.source_ref) as
          | { digest: string; target_id: string }
          | undefined;
        if (prior) {
          if (prior.digest !== digest)
            throw new AgentMindError(
              'KNOWLEDGE_IMPORT_CONFLICT',
              'Source claim changed after import; prior record was preserved.',
            );
          return {
            kind: item.kind,
            source_ref: item.source_ref,
            target_id: prior.target_id,
            duplicate: true,
          };
        }
        const record =
          item.kind === 'memory'
            ? memory.save(item.data)
            : experience.record({
                ...item.data,
                provenance: {
                  ...item.data.provenance,
                  task_ref: `legacy-unverified:${item.source_ref}`,
                },
              }).experience;
        db.prepare('INSERT INTO broker_knowledge_imports VALUES(?,?,?,?,?,?,?,?)').run(
          scope.id,
          p.source_namespace,
          item.kind,
          item.source_ref,
          digest,
          record.id,
          uid,
          new Date().toISOString(),
        );
        return {
          kind: item.kind,
          source_ref: item.source_ref,
          target_id: record.id,
          duplicate: false,
        };
      });
      return {
        schema_version: 1,
        items,
        trust: 'UNVERIFIED_LEGACY_CLAIMS',
        approval_transferred: false,
        evaluation_transferred: false,
        active_state_changed: false,
      };
    })
    .immediate();
}
