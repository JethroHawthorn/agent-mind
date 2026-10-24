import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import {
  type Experience,
  ExperienceService,
  hashSkillFiles,
  nextTimestamp,
  openDatabase,
  type ProjectScope,
  resolveProject,
  SkillStore,
  type SkillVersion,
} from '../../packages/core/src/index.js';

type SkillFixture = {
  db: Database.Database;
  path: string;
  root: string;
  scope: ProjectScope;
  otherScope: ProjectScope;
  experiences: ExperienceService;
  otherExperiences: ExperienceService;
  approvedSource: Experience;
  source: (other?: boolean, approve?: boolean) => Experience;
  now: (previous?: string) => string;
  identity: (name?: string, project?: ProjectScope) => string;
  version: (
    skillId: string,
    references?: Experience[],
    project?: ProjectScope,
    files?: SkillVersion['files'],
  ) => string;
  evaluation: (versionId: string, result?: string, patch?: Record<string, unknown>) => string;
  review: (versionId: string, decision?: string) => string;
  transition: (
    skillId: string,
    to: string | null,
    action?: string,
    patch?: Record<string, unknown>,
  ) => string;
  store: SkillStore;
  close: () => void;
};

/** Synthetic trusted SQL fixtures only. These are not application lifecycle APIs. */
export function skillFixture(): SkillFixture {
  const root = mkdtempSync(join(tmpdir(), 'agentmind-skill-model-'));
  const otherRoot = join(root, 'other');
  mkdirSync(otherRoot);
  const path = join(root, 'registry.db');
  const db: Database.Database = openDatabase(path);
  const scope = resolveProject(root, root);
  const otherScope = resolveProject(otherRoot, otherRoot);
  const experiences = new ExperienceService(db, scope, 'codex');
  const otherExperiences = new ExperienceService(db, otherScope, 'claude');
  let lastTimestamp: string | undefined;
  const now = (previous?: string) => {
    const prior = [lastTimestamp, previous]
      .filter((value): value is string => value !== undefined)
      .sort()
      .at(-1);
    lastTimestamp = nextTimestamp(prior);
    return lastTimestamp;
  };
  const source = (other = false, approve = true) => {
    const service = other ? otherExperiences : experiences;
    const record = service.record({
      problem: 'SQLite busy startup',
      solution: 'Retry startup with bounded backoff',
      outcome: {
        status: 'partial',
        summary: 'Synthetic fixture; no runtime behavior is certified.',
      },
    }).experience;
    return approve
      ? service.review({
          id: record.id,
          expected_updated_at: record.updated_at,
          decision: 'approved',
          reviewer: 'fixture reviewer',
          reason: 'Synthetic domain test only.',
        })
      : record;
  };
  const approvedSource = source();
  const identity = (name = 'retry-sqlite', project = scope) => {
    const id = randomUUID();
    const at = now();
    db.prepare(`INSERT INTO skills (id, project_id, name, description, created_at, updated_at)
      VALUES (?, ?, ?, 'Retry SQLite busy errors safely', ?, ?)`).run(id, project.id, name, at, at);
    return id;
  };
  const version = (
    skillId: string,
    references = [approvedSource],
    project = scope,
    snapshotFiles?: SkillVersion['files'],
  ) =>
    db
      .transaction(() => {
        const id = randomUUID();
        const at = now();
        const number =
          (
            db
              .prepare('SELECT COUNT(*) AS n FROM skill_versions WHERE skill_id = ?')
              .get(skillId) as { n: number }
          ).n + 1;
        const files = snapshotFiles ?? [
          {
            path: 'SKILL.md',
            content: `---\nname: retry-sqlite\ndescription: Retry SQLite busy errors safely\n---\n\n# Procedure\nUse bounded retry. Version ${number}.\n`,
          },
        ];
        const hash = hashSkillFiles(files);
        db.prepare(`INSERT INTO skill_versions (id, skill_id, project_id, version, description, files_json, content_hash, source_agent, created_at)
      VALUES (?, ?, ?, ?, 'Retry SQLite busy errors safely', ?, ?, 'codex', ?)`).run(
          id,
          skillId,
          project.id,
          number,
          JSON.stringify(files),
          hash,
          at,
        );
        for (const experience of references) {
          const review = db
            .prepare(
              "SELECT id FROM experience_reviews WHERE experience_id = ? AND created_at = ? AND decision = 'approved'",
            )
            .get(experience.id, experience.reviewed_at) as { id: string } | undefined;
          db.prepare(`INSERT INTO skill_version_sources (version_id, skill_id, project_id, experience_id, experience_review_id, experience_updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
            id,
            skillId,
            project.id,
            experience.id,
            review?.id ?? randomUUID(),
            experience.updated_at,
          );
        }
        db.prepare(
          'INSERT INTO skill_version_states (version_id, skill_id, project_id, updated_at) VALUES (?, ?, ?, ?)',
        ).run(id, skillId, project.id, at);
        return id;
      })
      .immediate();
  const evaluation = (versionId: string, result = 'PASS', patch: Record<string, unknown> = {}) => {
    const row = db
      .prepare(`SELECT v.*, s.updated_at FROM skill_versions v JOIN skill_version_states s
      ON s.version_id = v.id WHERE v.id = ?`)
      .get(versionId) as {
      skill_id: string;
      project_id: string;
      content_hash: string;
      updated_at: string;
    };
    const skill = db
      .prepare('SELECT active_version_id FROM skills WHERE id = ?')
      .get(row.skill_id) as { active_version_id: string | null };
    const params = {
      id: randomUUID(),
      version_id: versionId,
      skill_id: row.skill_id,
      project_id: row.project_id,
      evaluator: 'synthetic-domain-fixture',
      evaluator_version: '1',
      result,
      checks_json: JSON.stringify([
        {
          name: 'fixture-check',
          result,
          details: 'Model test record only; not an executed evaluation.',
        },
      ]),
      baseline_version_id: skill.active_version_id,
      regression_result: skill.active_version_id ? result : 'NOT_VERIFIED',
      content_hash: row.content_hash,
      created_at: now(row.updated_at),
      ...patch,
    };
    db.prepare(`INSERT INTO skill_evaluations (id, version_id, skill_id, project_id, evaluator, evaluator_version, result,
      checks_json, baseline_version_id, regression_result, content_hash, created_at)
      VALUES (@id, @version_id, @skill_id, @project_id, @evaluator, @evaluator_version, @result,
      @checks_json, @baseline_version_id, @regression_result, @content_hash, @created_at)`).run(
      params,
    );
    return params.id;
  };
  const review = (versionId: string, decision = 'approved') => {
    const row = db
      .prepare('SELECT * FROM skill_version_states WHERE version_id = ?')
      .get(versionId) as {
      skill_id: string;
      project_id: string;
      latest_evaluation_id: string | null;
      updated_at: string;
    };
    const id = randomUUID();
    db.prepare(`INSERT INTO skill_reviews (id, version_id, skill_id, project_id, decision, evaluation_id, reviewer, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'fixture reviewer', 'Synthetic model test only', ?)`).run(
      id,
      versionId,
      row.skill_id,
      row.project_id,
      decision,
      row.latest_evaluation_id,
      now(row.updated_at),
    );
    return id;
  };
  const transition = (
    skillId: string,
    to: string | null,
    action = 'promote',
    patch: Record<string, unknown> = {},
  ) => {
    const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(skillId) as {
      project_id: string;
      active_version_id: string | null;
      revision: number;
      updated_at: string;
    };
    const approval = to
      ? (db.prepare('SELECT review_id FROM skill_version_states WHERE version_id = ?').get(to) as {
          review_id: string | null;
        })
      : null;
    const params = {
      id: randomUUID(),
      skill_id: skillId,
      project_id: skill.project_id,
      from_version_id: skill.active_version_id,
      to_version_id: to,
      approval_id: approval?.review_id ?? null,
      action,
      expected_revision: skill.revision,
      actor: 'fixture operator',
      reason: 'Synthetic pointer transition only',
      created_at: now(skill.updated_at),
      ...patch,
    };
    db.prepare(`INSERT INTO skill_promotions (id, skill_id, project_id, from_version_id, to_version_id, approval_id,
      action, expected_revision, actor, reason, created_at) VALUES (@id, @skill_id, @project_id, @from_version_id,
      @to_version_id, @approval_id, @action, @expected_revision, @actor, @reason, @created_at)`).run(
      params,
    );
    return params.id;
  };
  return {
    db,
    path,
    root,
    scope,
    otherScope,
    experiences,
    otherExperiences,
    approvedSource,
    source,
    now,
    identity,
    version,
    evaluation,
    review,
    transition,
    store: new SkillStore(db, scope),
    close: () => {
      if (db.open) db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
