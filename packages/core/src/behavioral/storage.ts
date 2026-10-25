import type Database from 'better-sqlite3';
import { AgentMindError } from '../errors.js';
import type { ProjectScope } from '../project.js';
import { hashSkillFiles, type SkillEvaluation } from '../skill-model.js';
import {
  behavioralDigest,
  behavioralEvidenceSchema,
  behavioralSuiteSchema,
  resolveBehavioralSuite,
} from './model.js';

/** Versioned additive extension in the core registry transaction domain; no destructive core migration. */
export function migrateBehavioral(db: Database.Database) {
  db.transaction(() => {
    const exists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='behavioral_schema'")
      .get();
    if (exists) {
      const rows = db.prepare('SELECT version FROM behavioral_schema').all() as Array<{
        version: number;
      }>;
      if (rows.length !== 1 || rows[0]?.version !== 1)
        throw new AgentMindError(
          'BEHAVIORAL_SCHEMA_UNSUPPORTED',
          'Unknown behavioral extension schema.',
        );
      return;
    }
    db.exec(`CREATE TABLE behavioral_schema(version INTEGER PRIMARY KEY CHECK(version=1));INSERT INTO behavioral_schema VALUES(1);
      CREATE TABLE behavioral_suites(project_id TEXT NOT NULL REFERENCES projects(id),suite_id TEXT NOT NULL,version INTEGER NOT NULL,
        digest TEXT NOT NULL,definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),PRIMARY KEY(project_id,suite_id,version));
      CREATE TABLE behavioral_evidence(evaluation_id TEXT PRIMARY KEY,version_id TEXT NOT NULL,skill_id TEXT NOT NULL,project_id TEXT NOT NULL,
        evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND length(evidence_json)<=32768),evidence_digest TEXT NOT NULL,
        FOREIGN KEY(evaluation_id,version_id,skill_id,project_id) REFERENCES skill_evaluations(id,version_id,skill_id,project_id));
      CREATE INDEX behavioral_evidence_scope ON behavioral_evidence(project_id,version_id);`);
    for (const table of ['behavioral_suites', 'behavioral_evidence']) {
      db.exec(`CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable behavioral evidence');END;
        CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable behavioral evidence');END;`);
      const condition =
        table === 'behavioral_suites'
          ? 'project_id=NEW.project_id AND suite_id=NEW.suite_id AND version=NEW.version'
          : 'evaluation_id=NEW.evaluation_id';
      db.exec(
        `CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${condition}) BEGIN SELECT RAISE(ABORT,'immutable behavioral evidence');END;`,
      );
    }
  }).immediate();
}
export function persistBehavioralEvidence(
  db: Database.Database,
  evaluation: SkillEvaluation,
  input: unknown,
) {
  const evidence = behavioralEvidenceSchema.parse(input);
  const suite = resolveBehavioralSuite(evidence.selector);
  if (suite) {
    const prior = db
      .prepare(
        'SELECT digest,definition_json FROM behavioral_suites WHERE project_id=? AND suite_id=? AND version=?',
      )
      .get(evaluation.project_id, suite.definition.id, suite.definition.version) as
      | { digest: string; definition_json: string }
      | undefined;
    if (prior) {
      if (
        prior.digest !== suite.digest ||
        behavioralDigest(JSON.parse(prior.definition_json)) !== suite.digest
      )
        throw new AgentMindError(
          'BEHAVIORAL_SUITE_INTEGRITY',
          'Persisted trusted suite was modified.',
        );
    } else
      db.prepare('INSERT INTO behavioral_suites VALUES(?,?,?,?,?)').run(
        evaluation.project_id,
        suite.definition.id,
        suite.definition.version,
        suite.digest,
        JSON.stringify(suite.definition),
      );
  }
  db.prepare('INSERT INTO behavioral_evidence VALUES(?,?,?,?,?,?)').run(
    evaluation.id,
    evaluation.version_id,
    evaluation.skill_id,
    evaluation.project_id,
    JSON.stringify(evidence),
    behavioralDigest(evidence),
  );
}
export function readBehavioralEvidence(
  db: Database.Database,
  scope: ProjectScope,
  evaluation: SkillEvaluation,
) {
  if (evaluation.project_id !== scope.id)
    throw new AgentMindError(
      'BEHAVIORAL_EVIDENCE_UNAVAILABLE',
      'Behavioral evidence is unavailable in this scope.',
    );
  const meta = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='behavioral_schema'")
    .get();
  if (!meta)
    throw new AgentMindError(
      'BEHAVIORAL_EVIDENCE_UNAVAILABLE',
      'Behavioral evidence schema is missing.',
    );
  if (meta) {
    const versions = db.prepare('SELECT version FROM behavioral_schema').all() as Array<{
      version: number;
    }>;
    if (versions.length !== 1 || versions[0]?.version !== 1)
      throw new AgentMindError(
        'BEHAVIORAL_SCHEMA_UNSUPPORTED',
        'Unknown behavioral evidence schema.',
      );
  }
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='behavioral_evidence'")
    .get();
  const row = exists
    ? (db
        .prepare(
          'SELECT evidence_json,evidence_digest FROM behavioral_evidence WHERE evaluation_id=? AND version_id=? AND project_id=?',
        )
        .get(evaluation.id, evaluation.version_id, scope.id) as
        | { evidence_json: string; evidence_digest: string }
        | undefined)
    : undefined;
  if (!row)
    throw new AgentMindError(
      'BEHAVIORAL_EVIDENCE_UNAVAILABLE',
      'Required behavioral evidence is missing.',
    );
  try {
    const evidence = behavioralEvidenceSchema.parse(JSON.parse(row.evidence_json));
    if (
      evaluation.result === 'PASS' ||
      evaluation.regression_result === 'PASS' ||
      evaluation.checks.find((c) => c.name === 'execution.behavioral')?.result !== 'NOT_VERIFIED'
    )
      throw new Error('Disabled execution cannot attest a behavioral PASS.');
    if (
      behavioralDigest(evidence) !== row.evidence_digest ||
      evidence.evaluation_digest !== behavioralDigest(evaluation) ||
      evidence.evaluation_id !== evaluation.id ||
      evidence.candidate.version_id !== evaluation.version_id ||
      evidence.candidate.digest !== evaluation.content_hash ||
      evidence.project_id !== scope.id ||
      evidence.baseline?.version_id !== (evaluation.baseline_version_id ?? undefined)
    )
      throw new Error('binding');
    for (const artifact of [
      evidence.candidate,
      ...(evidence.baseline ? [evidence.baseline] : []),
    ]) {
      const stored = db
        .prepare('SELECT content_hash,files_json FROM skill_versions WHERE id=? AND project_id=?')
        .get(artifact.version_id, scope.id) as
        | { content_hash: string; files_json: string }
        | undefined;
      if (
        !stored ||
        stored.content_hash !== artifact.digest ||
        hashSkillFiles(JSON.parse(stored.files_json)) !== artifact.digest
      )
        throw new Error('artifact');
    }
    const snapshot = JSON.parse(
      evaluation.checks.find((c) => c.name === 'baseline.snapshot')?.details ?? 'null',
    ) as {
      version_id: string | null;
      content_hash: string | null;
      identity_revision: number;
    } | null;
    if (
      !snapshot ||
      snapshot.version_id !== evaluation.baseline_version_id ||
      snapshot.content_hash !== (evidence.baseline?.digest ?? null) ||
      (evidence.baseline && snapshot.identity_revision !== evidence.baseline.identity_revision)
    )
      throw new Error('baseline');
    const suite = resolveBehavioralSuite(evidence.selector);
    if (suite) {
      const stored = db
        .prepare(
          'SELECT digest,definition_json FROM behavioral_suites WHERE project_id=? AND suite_id=? AND version=?',
        )
        .get(scope.id, suite.definition.id, suite.definition.version) as
        | { digest: string; definition_json: string }
        | undefined;
      if (
        !stored ||
        stored.digest !== suite.digest ||
        behavioralDigest(behavioralSuiteSchema.parse(JSON.parse(stored.definition_json))) !==
          suite.digest ||
        evidence.suite?.digest !== suite.digest
      )
        throw new Error('suite');
    } else if (evidence.suite !== null) throw new Error('unknown suite');
    return {
      ...evidence,
      suite_definition: suite?.definition ?? null,
      evidence_reference: `agentmind://behavioral/${evaluation.id}`,
      execution_verified: false as const,
    };
  } catch {
    throw new AgentMindError(
      'BEHAVIORAL_EVIDENCE_INTEGRITY',
      'Behavioral evidence or suite binding failed verification.',
    );
  }
}
/** Recognized policy, no accepted executor today. Forged PASS rows cannot activate this lane. */
export function assertBehavioralApproval(
  db: Database.Database,
  scope: ProjectScope,
  evaluation: SkillEvaluation,
): never {
  readBehavioralEvidence(db, scope, evaluation);
  throw new AgentMindError(
    'EVALUATION_NOT_ELIGIBLE',
    'No accepted isolated execution evidence exists. Behavioral approval cannot be authorized.',
  );
}
