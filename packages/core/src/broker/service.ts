import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { SkillAuthoringService } from '../authoring/service.js';
import { RecommendationService } from '../curator/service.js';
import { ExperienceService } from '../experience.js';
import { experienceReviewSchema } from '../experience-schemas.js';
import { LearningSignalService } from '../learning/service.js';
import { LearningReviewDecisions, LearningReviewService } from '../learning-review/service.js';
import { MemoryService } from '../memory.js';
import { issueBrokerGrant, reviewDigest } from '../operator-confirmation.js';
import { assertSafeSummary } from '../privacy.js';
import { resolveProject } from '../project.js';
import { distributionRequestSchema } from '../skill-distribution-model.js';
import { SkillEvaluationService } from '../skill-evaluation.js';
import { SkillOperatorService, skillOperatorActionSchema } from '../skill-operator.js';
import { SkillProposalService } from '../skill-proposal.js';
import { skillSearchSchema } from '../skill-requests.js';
import { SkillReviewService } from '../skill-review.js';
import { SkillStore } from '../skill-store.js';
import { SkillUsageService } from '../skill-usage.js';
import {
  type BrokerConfig,
  denied,
  type Peer,
  principal,
  required,
  validateBrokerConfig,
} from './policy.js';
import { publicationService } from './publication.js';

const requestSchema = z.strictObject({
  schema_version: z.literal(1),
  op: z.string().min(1).max(64),
  project: z.string().max(64).optional(),
  input: z.unknown().optional(),
});
const operationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('skill'), request: skillOperatorActionSchema }),
  z.strictObject({
    kind: z.literal('experience'),
    request: experienceReviewSchema.omit({ reviewer: true }),
  }),
  z.strictObject({ kind: z.literal('distribution'), request: distributionRequestSchema }),
]);
const commitSchema = z.strictObject({
  challenge_id: z.uuid(),
  review_digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const agentOperations = [
  'review_queue',
  'review_get',
  'review_evidence',
  'review_diff',
  'memory_save',
  'memory_search',
  'experience_record',
  'experience_search',
  'skill_propose',
  'skill_authoring_context',
  'skill_authoring_submit',
  'skill_authoring_get',
  'skill_authoring_list',
  'skill_authoring_diff',
  'skill_authoring_evaluate',
  'skill_get',
  'skill_list',
  'skill_search',
  'skill_validate',
  'skill_evaluate',
  'skill_pending',
  'skill_review',
  'skill_diff',
  'skill_evaluation',
  'skill_usage_record',
  'skill_usage_query',
  'skill_usage_summary',
  'curator_analyze',
  'learning_signal_record',
  'learning_signal_get',
  'learning_signals',
  'learning_signal_detect',
  'learning_signal_refresh',
  'learning_signal_recommend',
  'curator_duplicates',
  'curator_recommendations',
  'curator_recommendation_get',
  'curator_compare',
] as const;

export const operatorQueryOperations = [
  'review_handoff',
  'review_queue',
  'review_get',
  'review_evidence',
  'review_diff',
  'memory_search',
  'experience_search',
  'skill_get',
  'skill_list',
  'skill_search',
  'skill_pending',
  'skill_authoring_get',
  'skill_authoring_list',
  'skill_authoring_diff',
  'skill_review',
  'skill_diff',
  'skill_evaluation',
  'skill_usage_query',
  'skill_usage_summary',
  'learning_signal_get',
  'learning_signals',
  'curator_recommendations',
  'curator_recommendation_get',
  'curator_compare',
] as const;

/** Broker extension schema v2 lives in the SAME registry transaction domain; core schema stays v9. */
export function migrateBroker(db: Database.Database) {
  db.transaction(() => {
    const exists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='broker_schema'")
      .get();
    if (exists) {
      const rows = db.prepare('SELECT version FROM broker_schema').all() as Array<{
        version: number;
      }>;
      if (rows.length !== 1 || ![1, 2].includes(rows[0]?.version ?? 0))
        denied('Unsupported broker extension schema.');
      if (rows[0]?.version === 1) {
        db.exec(`DELETE FROM broker_challenges;
          ALTER TABLE broker_challenges RENAME COLUMN confirmation_hash TO review_binding;
          ALTER TABLE broker_challenges ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 2;
          ALTER TABLE broker_schema RENAME TO broker_schema_v1;
          CREATE TABLE broker_schema(version INTEGER PRIMARY KEY CHECK(version=2));
          INSERT INTO broker_schema VALUES(2);DROP TABLE broker_schema_v1;`);
      }
      return;
    }
    db.exec(`CREATE TABLE broker_schema(version INTEGER PRIMARY KEY CHECK(version=2));
      INSERT INTO broker_schema VALUES(2);
      CREATE TABLE broker_challenges(id TEXT PRIMARY KEY,uid INTEGER NOT NULL,project TEXT NOT NULL,input_json TEXT NOT NULL,
        digest TEXT NOT NULL,review_binding TEXT NOT NULL,protocol_version INTEGER NOT NULL DEFAULT 2,expires INTEGER NOT NULL,consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)));
      CREATE TABLE broker_audit(id TEXT PRIMARY KEY,uid INTEGER NOT NULL,gid INTEGER NOT NULL,project TEXT NOT NULL,operation TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TRIGGER broker_audit_no_update BEFORE UPDATE ON broker_audit BEGIN SELECT RAISE(ABORT,'immutable broker audit');END;
      CREATE TRIGGER broker_audit_no_delete BEFORE DELETE ON broker_audit BEGIN SELECT RAISE(ABORT,'immutable broker audit');END;
      CREATE TRIGGER broker_audit_no_replace BEFORE INSERT ON broker_audit WHEN EXISTS(SELECT 1 FROM broker_audit WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'immutable broker audit');END;`);
  }).immediate();
}
export class BrokerService {
  private readonly authoringSession = randomUUID();
  private readonly scopes;
  constructor(
    private readonly db: Database.Database,
    private readonly config: BrokerConfig,
    private readonly nativeHelper?: string,
  ) {
    validateBrokerConfig(config);
    migrateBroker(db);
    this.scopes = new Map(
      config.projects.map((p) => {
        const scope = resolveProject(p.root, p.root, p.project_key);
        if (p.scope_id) {
          const prior = db
            .prepare('SELECT canonical_path FROM projects WHERE id=?')
            .get(p.scope_id) as { canonical_path: string } | undefined;
          if (!prior || prior.canonical_path !== scope.root)
            denied('Existing scope must match the administrator-reviewed canonical root.');
          return [p.name, Object.freeze({ ...scope, id: p.scope_id })] as const;
        }
        const existing = db
          .prepare('SELECT canonical_path FROM projects WHERE id=?')
          .get(scope.id) as { canonical_path: string } | undefined;
        if (existing && existing.canonical_path !== scope.root)
          denied('Existing keyed scope maps to a different canonical root.');
        return [p.name, scope] as const;
      }),
    );
    if (new Set([...this.scopes.values()].map((s) => s.id)).size !== config.projects.length)
      denied('Project mappings must not alias one scope.');
  }
  handle(channel: 'agent' | 'operator', peer: Peer, input: unknown): unknown {
    try {
      return this.dispatch(channel, peer, input);
    } catch (error) {
      try {
        this.audit(peer, '<denied>', 'request', 'denied');
      } catch {}
      throw error;
    }
  }
  private dispatch(channel: 'agent' | 'operator', peer: Peer, input: unknown): unknown {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success || Buffer.byteLength(JSON.stringify(input)) > 131072)
      denied('Invalid broker request.');
    const p = parsed.data;
    const auth = principal(this.config, channel, peer, p.project);
    const scope = required(this.scopes.get(auth.project.name));
    if (['review_queue', 'review_get', 'review_evidence', 'review_diff'].includes(p.op)) {
      const queue = new LearningReviewService(this.db, scope);
      if (p.op === 'review_queue') return queue.list(p.input ?? {});
      if (p.op === 'review_get') return queue.get(p.input);
      if (p.op === 'review_evidence') return queue.evidence(p.input);
      return queue.diff(p.input);
    }
    if (p.op === 'review_handoff') {
      if (channel !== 'operator') denied('Handoff is an operator diagnostic.');
      return new LearningReviewService(this.db, scope).handoff(p.input);
    }
    if (p.op === 'review_decide') {
      if (channel !== 'operator')
        denied('Review decisions require the independently authenticated operator channel.');
      return this.db
        .transaction(() => {
          const result = new LearningReviewDecisions(this.db, scope, {
            method: 'broker-peer-review-v1',
            uid: peer.uid,
            gid: peer.gid,
          }).decide(p.input);
          this.audit(peer, auth.project.name, 'review_decide', 'advisory-only');
          return result;
        })
        .immediate();
    }
    if (p.op === 'broker_health')
      return {
        schema_version: 1,
        project_id: scope.id,
        peer_uid: peer.uid,
        broker_uid: process.getuid?.(),
        authorization: 'os-peer-operator-v2',
        deployment_acceptance: 'NOT VERIFIED',
      };
    if (
      [
        'skill_authoring_context',
        'skill_authoring_submit',
        'skill_authoring_get',
        'skill_authoring_list',
        'skill_authoring_diff',
        'skill_authoring_evaluate',
      ].includes(p.op)
    ) {
      const authoring = new SkillAuthoringService(
        this.db,
        scope,
        auth.source,
        true,
        `${this.authoringSession}:${peer.uid}`,
      );
      if (p.op === 'skill_authoring_context') return authoring.context(p.input);
      if (p.op === 'skill_authoring_submit') return authoring.submit(p.input);
      if (p.op === 'skill_authoring_get') return authoring.get(p.input);
      if (p.op === 'skill_authoring_list') return authoring.list(p.input ?? {});
      if (p.op === 'skill_authoring_diff') return authoring.diff(p.input);
      return authoring.evaluate(p.input);
    }
    if (
      [
        'learning_signal_record',
        'learning_signal_get',
        'learning_signals',
        'learning_signal_detect',
        'learning_signal_refresh',
        'learning_signal_recommend',
      ].includes(p.op)
    ) {
      const learning = new LearningSignalService(this.db, scope, auth.source);
      if (p.op === 'learning_signal_record') return learning.record(p.input);
      if (p.op === 'learning_signal_get') return learning.get(p.input);
      if (p.op === 'learning_signals') return learning.list(p.input ?? {});
      if (p.op === 'learning_signal_detect') return learning.detect(p.input ?? {});
      if (p.op === 'learning_signal_refresh') return learning.refresh(p.input);
      return learning.recommend(p.input);
    }
    if (
      [
        'curator_analyze',
        'curator_recommendations',
        'curator_recommendation_get',
        'curator_duplicates',
        'curator_compare',
      ].includes(p.op)
    ) {
      const curator = new RecommendationService(this.db, scope);
      if (p.op === 'curator_duplicates') return curator.analyzeDuplicates(p.input ?? {});
      if (p.op === 'curator_compare') return curator.compare(p.input);
      if (p.op === 'curator_analyze') return curator.analyze(p.input ?? {});
      if (p.op === 'curator_recommendations') return curator.list(p.input ?? {});
      return curator.get(p.input);
    }
    const memory = new MemoryService(this.db, scope, auth.source);
    const experiences = new ExperienceService(this.db, scope, auth.source);
    const store = new SkillStore(this.db, scope);
    const review = new SkillReviewService(this.db, scope);
    const usage = new SkillUsageService(this.db, scope, auth.source);
    // Explicit dispatch: no object-property invocation or arbitrary service/SQL/file selectors.
    if (channel === 'agent' || operatorQueryOperations.some((op) => op === p.op)) {
      if (!agentOperations.some((name) => name === p.op))
        denied('Operation is unavailable to agents.');
      return this.db
        .transaction(() => {
          let result: unknown;
          switch (p.op) {
            case 'memory_save':
              result = { memory: memory.save(p.input) };
              break;
            case 'memory_search':
              result = { memories: memory.search(p.input) };
              break;
            case 'experience_record':
              result = experiences.record(p.input);
              break;
            case 'experience_search':
              result = experiences.search(p.input);
              break;
            case 'skill_propose':
              result = new SkillProposalService(this.db, scope, auth.source).propose(p.input);
              break;
            case 'skill_get':
              result = store.get(p.input);
              break;
            case 'skill_list':
              result = store.list(p.input);
              break;
            case 'skill_search': {
              const s = skillSearchSchema.parse(p.input);
              const { query, ...options } = s;
              result = store.search(query, options);
              break;
            }
            case 'skill_validate':
              result = store.validate(p.input);
              break;
            case 'skill_evaluate':
              result = new SkillEvaluationService(this.db, scope).evaluate(p.input);
              break;
            case 'skill_pending':
              result = review.pending(p.input);
              break;
            case 'skill_review':
              result = review.review(p.input);
              break;
            case 'skill_diff':
              result = review.diff(p.input);
              break;
            case 'skill_evaluation':
              result = review.evaluation(p.input);
              break;
            case 'skill_usage_record':
              result = usage.record(p.input);
              break;
            case 'skill_usage_query':
              result = usage.query(p.input);
              break;
            case 'skill_usage_summary':
              result = usage.summary(p.input);
              break;
          }
          this.audit(peer, auth.project.name, p.op, 'completed');
          return result;
        })
        .immediate();
    }
    if (p.op === 'distribution_plan' || p.op === 'distribution_verify') {
      const request = distributionRequestSchema.parse(p.input);
      if (request.scope !== 'project')
        denied('Protected distribution supports configured project publication only.');
      const service = publicationService(
        this.db,
        this.config,
        auth.project,
        scope,
        this.nativeHelper,
      );
      return p.op === 'distribution_plan' ? service.plan(request) : service.verify(request);
    }
    if (p.op === 'operator_prepare') {
      const operation = operationSchema.parse(p.input);
      const preview = this.preview(auth.project.name, operation);
      const digest = reviewDigest(preview);
      const id = randomUUID();
      const binding = reviewDigest({ id, uid: peer.uid, project: auth.project.name, digest });
      this.db
        .transaction(() => {
          // Outstanding challenges are bounded; no periodic jobs or credential persistence.
          this.db
            .prepare('DELETE FROM broker_challenges WHERE consumed=1 OR expires<?')
            .run(Date.now());
          const n = this.db
            .prepare('SELECT COUNT(*) AS n FROM broker_challenges WHERE uid=?')
            .get(peer.uid) as { n: number };
          if (n.n >= 32) denied('Too many outstanding operator reviews.');
          this.db
            .prepare(
              'INSERT INTO broker_challenges(id,uid,project,input_json,digest,review_binding,expires) VALUES(?,?,?,?,?,?,?)',
            )
            .run(
              id,
              peer.uid,
              auth.project.name,
              JSON.stringify(operation),
              digest,
              binding,
              Date.now() + 300000,
            );
          this.audit(peer, auth.project.name, 'operator_prepare', 'prepared');
        })
        .immediate();
      return {
        challenge_id: id,
        preview,
        digest,
        authorization: 'os-peer-operator-v2',
        expires_in_seconds: 300,
        boundary: 'distinct-os-uid-required',
        consumption: 'published copies remain untrusted',
      };
    }
    if (p.op !== 'operator_commit') denied('Unknown operator operation.');
    const commit = commitSchema.parse(p.input);
    // Durable one-use claim BEFORE applying effects. A crash requires a new review, never nonce replay.
    const saved = this.db
      .transaction(() => {
        const row = this.db
          .prepare(
            'SELECT * FROM broker_challenges WHERE id=? AND uid=? AND project=? AND consumed=0 AND protocol_version=2 AND expires>=?',
          )
          .get(commit.challenge_id, peer.uid, auth.project.name, Date.now()) as
          | { input_json: string; digest: string; review_binding: string }
          | undefined;
        if (!row) denied('Unknown, expired, consumed or unauthorized review.');
        if (
          row.digest !== commit.review_digest ||
          row.review_binding !==
            reviewDigest({
              id: commit.challenge_id,
              uid: peer.uid,
              project: auth.project.name,
              digest: row.digest,
            })
        )
          denied('Review does not match this authenticated request.');
        this.db
          .prepare('UPDATE broker_challenges SET consumed=1 WHERE id=?')
          .run(commit.challenge_id);
        this.audit(peer, auth.project.name, 'operator_commit', 'claimed');
        return row;
      })
      .immediate();
    const operation = operationSchema.parse(JSON.parse(saved.input_json));
    const apply = () => {
      const preview = this.preview(auth.project.name, operation);
      if (reviewDigest(preview) !== saved.digest)
        denied('Review became stale; obtain a fresh confirmation.');
      const grant = issueBrokerGrant(reviewDigest(preview), peer);
      let result: unknown;
      if (operation.kind === 'skill')
        result = new SkillOperatorService(this.db, scope).commit(operation.request, grant);
      else if (operation.kind === 'experience')
        result = experiences.review({
          ...operation.request,
          reviewer: `uid:${peer.uid}:broker-operator`,
        });
      else
        result = publicationService(
          this.db,
          this.config,
          auth.project,
          scope,
          this.nativeHelper,
        ).commit(operation.request, grant);
      this.audit(peer, auth.project.name, operation.kind, 'applied');
      return result;
    };
    return operation.kind === 'distribution' ? apply() : this.db.transaction(apply).immediate();
  }
  private preview(project: string, input: z.infer<typeof operationSchema>) {
    const scope = required(this.scopes.get(project));
    if (input.kind === 'experience') {
      assertSafeSummary(input.request.reason);
      return {
        kind: input.kind,
        request: input.request,
        current: new ExperienceService(this.db, scope).inspect(input.request.id),
      };
    }
    if (input.kind === 'skill') {
      if (['promote', 'rollback'].includes(input.request.action))
        this.protectedApproval(project, input.request.version_id);
      return new SkillOperatorService(this.db, scope).prepare(input.request);
    }
    const projectConfig = required(this.config.projects.find((p) => p.name === project));
    if (input.request.scope !== 'project')
      denied('Protected publication supports project scope only.');
    const plan = publicationService(
      this.db,
      this.config,
      projectConfig,
      scope,
      this.nativeHelper,
    ).plan(input.request);
    for (const entry of plan.entries)
      if (entry.version_id) this.protectedApproval(project, entry.version_id);
    return plan;
  }

  private protectedApproval(project: string, version: string) {
    const scope = required(this.scopes.get(project));
    const r = new SkillReviewService(this.db, scope).review({ version_id: version });
    const event = this.db
      .prepare(
        "SELECT metadata_json FROM skill_operator_events WHERE project_id=? AND version_id=? AND review_id=? AND action='approve'",
      )
      .get(scope.id, version, r.state.review_id) as { metadata_json: string } | undefined;
    if (!event)
      denied(
        'A protected broker approval is required. Legacy approvals are not upgraded automatically.',
      );
    const meta = JSON.parse(event.metadata_json) as { boundary?: string; broker_peer?: Peer };
    if (
      meta.boundary !== 'os-peer-v1' ||
      !this.config.operators.some(
        (o) => o.uid === meta.broker_peer?.uid && o.projects.includes(project),
      )
    )
      denied('Approval lacks protected operator provenance.');
  }
  private audit(peer: Peer, project: string, operation: string, result: string) {
    this.db
      .prepare('INSERT INTO broker_audit VALUES(?,?,?,?,?,?,?)')
      .run(randomUUID(), peer.uid, peer.gid, project, operation, result, new Date().toISOString());
  }
}
