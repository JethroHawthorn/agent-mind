import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  distributionCheckpoint,
  migrateDistributionReliability,
} from './distribution-reliability.js';
import { AgentMindError } from './errors.js';
import { localOperatorIdentity } from './local-operator.js';
import { consumeOperatorGrant, reviewDigest } from './operator-confirmation.js';
import type { ProjectScope } from './project.js';
import { resolveActiveArtifact } from './skill-active-artifact.js';
import {
  createSafeDirectories,
  deleteCheckedPackage,
  digestText,
  fileIdentity,
  inspectPackage,
  inspectPath,
  matchesRecord,
  materializePackage,
  moveChecked,
  type PublicationPermissions,
  pathExists,
} from './skill-distribution-files.js';
import {
  type DistributionIntent,
  type DistributionPlanEntry,
  type DistributionRequest,
  distributionRequestSchema,
  type InstallationRecord,
  installationManifestSchema,
} from './skill-distribution-model.js';
import {
  distributionAdapters,
  distributionDestination,
  trustedDistributionHome,
} from './skill-distribution-targets.js';
import { SkillOperatorService } from './skill-operator.js';
import { diffSkillFiles, type SkillReviewService } from './skill-review.js';
import { SkillStore } from './skill-store.js';
import { nextTimestamp } from './timestamp.js';

const WARNING =
  'Distribution changes CLI-discoverable files. Same-user PTY/SQLite/filesystem access defeats adversarial authorization and ownership proofs. Static PASS is not behavioral verification. User scope exposes this project skill to other local projects. SQLite and filesystem changes are not one atomic transaction.';
type Auth = {
  operator: string;
  session: string;
  digest: string;
  broker_peer?: { uid: number; gid: number };
};

export class SkillDistributionService {
  readonly #scope: ProjectScope;
  readonly #home: string;
  readonly #roots: Map<string, string>;
  constructor(
    private readonly db: Database.Database,
    scope: ProjectScope,
    homeRoot?: string,
    private readonly publicationPermissions?: PublicationPermissions,
  ) {
    this.#scope = Object.freeze({ ...scope });
    this.#home = trustedDistributionHome(homeRoot);
    this.#roots = new Map([scope.root, this.#home].map((root) => [root, fileIdentity(root)]));
  }
  private request(input: unknown) {
    const p = distributionRequestSchema.safeParse(input);
    if (!p.success)
      throw new AgentMindError(
        'INVALID_INPUT',
        'Select an exact project skill UUID, target codex|claude|all, scope project|user and sync|remove operation.',
      );
    return p.data;
  }
  private registry(request: DistributionRequest) {
    const store = new SkillStore(this.db, this.#scope);
    const identity = store.getIdentity(request.skill_id);
    let artifact: {
      review: Omit<ReturnType<SkillReviewService['review']>, 'warning'> & { warning: string };
    } | null = null;
    let error: string | null = null;
    if (identity.active_version_id) {
      try {
        const eligible = resolveActiveArtifact(this.db, this.#scope, identity.id);
        artifact = {
          review: {
            ...eligible.review,
            warning: 'Registry provenance only; distribution entries govern filesystem changes.',
          },
        };
      } catch (e) {
        artifact = null;
        error = e instanceof AgentMindError ? e.code : 'SKILL_INTEGRITY_ERROR';
      }
    }
    return { identity, artifact, error };
  }
  plan(input: unknown) {
    const request = this.request(input);
    return this.db.transaction(() => {
      const registry = this.registry(request);
      const targets = request.target === 'all' ? (['codex', 'claude'] as const) : [request.target];
      const entries = targets.map((target) => this.entry(request, target, registry));
      return { request, registry, entries, warning: WARNING, untrusted_data: true as const };
    })();
  }
  private entry(
    request: DistributionRequest,
    target: 'codex' | 'claude',
    registry: ReturnType<SkillDistributionService['registry']>,
  ): DistributionPlanEntry {
    const { base, parent, destination } = distributionDestination(
      this.#scope,
      this.#home,
      target,
      request.scope,
      registry.identity.name,
    );
    const artifact = registry.artifact?.review.version ?? null;
    const desired = request.operation === 'sync' ? artifact : null;
    const row = this.db
      .prepare('SELECT * FROM skill_installations WHERE destination=?')
      .get(destination) as InstallationRecord | undefined;
    const pending = this.db
      .prepare("SELECT * FROM skill_distribution_intents WHERE destination=? AND status='pending'")
      .get(destination) as DistributionIntent | undefined;
    const own =
      row?.project_id === this.#scope.id &&
      row.skill_id === request.skill_id &&
      row.target === target &&
      row.scope === request.scope;
    const entry: DistributionPlanEntry = {
      skill_id: request.skill_id,
      name: registry.identity.name,
      project_id: this.#scope.id,
      target,
      scope: request.scope,
      destination,
      version_id: desired?.id ?? null,
      version: desired?.version ?? null,
      content_digest: desired?.content_hash ?? null,
      action: 'SKIP',
      reason: 'No active artifact or managed installation.',
      current_status: 'absent',
      record: own ? (row ?? null) : null,
      filesystem: null,
      parents: null,
      pending: null,
      artifact_diff: [],
    };
    const conflict = (reason: string) => ({ ...entry, action: 'CONFLICT' as const, reason });
    try {
      if (fileIdentity(base) !== this.#roots.get(base))
        return conflict('Authorized root directory identity changed.');
      entry.parents = inspectPath(base, parent);
      // Check private work ancestry in planning too; no mkdir/write is performed.
      inspectPath(base, join(base, '.agentmind', 'distribution-v1'));
      if (distributionAdapters[target].reserved.includes(registry.identity.name as never))
        return conflict('Skill name is reserved by the target CLI.');
      if (row && !own)
        return conflict('Destination is reserved by a different project, skill or scope.');
      if (pending) {
        if (
          pending.project_id !== this.#scope.id ||
          pending.skill_id !== request.skill_id ||
          pending.target !== target ||
          pending.scope !== request.scope
        )
          return conflict('Destination has a foreign pending operation.');
        entry.pending = pending;
        const work = this.paths(entry, pending);
        entry.filesystem = {
          destination: inspectPackage(destination),
          stage: inspectPackage(work.stage),
          backup: inspectPackage(work.backup),
        };
        entry.current_status = 'pending-recovery';
        return {
          ...entry,
          action: 'REPAIR',
          reason:
            'Pending or interrupted operation: confirmed recovery takes over its worker. Re-plan afterward for current registry convergence.',
        };
      }
      if (registry.error && request.operation === 'sync')
        return conflict(`Active registry artifact is ineligible: ${registry.error}.`);
      if (!row && pathExists(destination))
        return conflict('Unowned destination exists; a manifest alone never proves ownership.');
      const observed =
        row && row.status === 'installed'
          ? inspectPackage(destination)
          : { status: pathExists(destination) ? 'unowned' : 'missing' };
      entry.filesystem = observed;
      entry.current_status = observed.status;
      if (row?.status === 'removed' && pathExists(destination))
        return conflict('Destination reappeared after removal; ownership is not established.');
      if (
        row?.status === 'installed' &&
        observed.status !== 'missing' &&
        !matchesRecord(observed as ReturnType<typeof inspectPackage>, row)
      )
        return conflict(
          'Managed content, manifest, directory identity or file inventory changed. Preserve local changes.',
        );
      if (row) {
        const old = new SkillStore(this.db, this.#scope).getVersion(row.version_id);
        if (
          old.version.skill_id !== request.skill_id ||
          old.version.content_hash !== row.installed_digest
        )
          return conflict('Installation record does not match the immutable registry snapshot.');
        entry.artifact_diff = diffSkillFiles(
          observed.status === 'missing' ? [] : old.version.files,
          desired?.files ?? [],
        );
      } else entry.artifact_diff = diffSkillFiles([], desired?.files ?? []);
      // Detect same-named opposite-scope copies which can shadow the selected target.
      if (desired) {
        const otherScope = request.scope === 'project' ? 'user' : 'project';
        const other = distributionDestination(
          this.#scope,
          this.#home,
          target,
          otherScope,
          registry.identity.name,
        );
        inspectPath(other.base, other.parent);
        if (other.destination !== destination && pathExists(other.destination)) {
          const record = this.db
            .prepare('SELECT * FROM skill_installations WHERE destination=?')
            .get(other.destination) as InstallationRecord | undefined;
          if (
            !record ||
            record.project_id !== this.#scope.id ||
            record.skill_id !== request.skill_id ||
            record.version_id !== desired.id ||
            !matchesRecord(inspectPackage(other.destination), record)
          )
            return conflict(
              'A same-named copy in the other scope can shadow this skill. Resolve it explicitly.',
            );
        }
      }
      if (!desired) {
        if (row?.status === 'installed' && observed.status !== 'missing')
          return {
            ...entry,
            action: 'REMOVE',
            reason:
              request.operation === 'remove'
                ? 'Explicit removal of verified managed content.'
                : 'Registry has no active version (possibly an activation gap); explicit sync will remove the managed copy.',
          };
        if (row?.status === 'installed')
          return {
            ...entry,
            action: 'REPAIR',
            reason: 'Managed copy is absent; reconcile removal without touching unrelated files.',
          };
        return entry;
      }
      if (observed.status === 'missing')
        return {
          ...entry,
          action: row?.status === 'installed' ? 'REPAIR' : 'INSTALL',
          reason:
            row?.status === 'installed'
              ? 'Reinstall an entirely missing managed copy.'
              : 'Install the exact approved active snapshot.',
        };
      if (row?.version_id === desired.id && row.installed_digest === desired.content_hash)
        return {
          ...entry,
          action: 'SKIP',
          reason: 'Exact managed active snapshot already installed.',
        };
      return {
        ...entry,
        action: 'UPDATE',
        reason:
          'Converge the verified managed copy to the active registry version, including rollback.',
      };
    } catch {
      return conflict(
        'Unsafe or unavailable destination ancestry, record or filesystem. No changes made.',
      );
    }
  }
  verify(input: unknown) {
    const plan = this.plan(input);
    const now = nextTimestamp();
    this.db
      .transaction(() => {
        for (const entry of plan.entries) {
          if (entry.record)
            this.db
              .prepare(
                'UPDATE skill_installations SET last_verified_at=? WHERE id=? AND project_id=?',
              )
              .run(now, entry.record.id, this.#scope.id);
          this.event(
            entry,
            null,
            'VERIFY',
            entry.action === 'SKIP' ? 'MATCH' : entry.action,
            entry.record?.version_id ?? null,
            entry.record?.installed_digest ?? null,
            { operator: localOperatorIdentity(), session: '', digest: reviewDigest(plan) },
            'local-observation-v1',
          );
        }
      })
      .immediate();
    return { ...plan, verified_at: now };
  }
  rollbackPlan(input: unknown, validateApproval?: (versionId: string) => void) {
    const parsed = z.strictObject({ skill_id: z.uuid() }).safeParse(input);
    if (!parsed.success)
      throw new AgentMindError('INVALID_INPUT', 'Expected an exact scoped skill UUID.');
    return this.db.transaction(() => {
      const identity = new SkillStore(this.db, this.#scope).getIdentity(parsed.data.skill_id);
      const rows = this.db
        .prepare(
          'SELECT to_version_id FROM skill_promotions WHERE project_id=? AND skill_id=? AND to_version_id IS NOT NULL AND to_version_id != ? GROUP BY to_version_id ORDER BY MAX(created_at) DESC,to_version_id DESC LIMIT 51',
        )
        .all(this.#scope.id, identity.id, identity.active_version_id ?? '') as {
        to_version_id: string;
      }[];
      const targets = rows.slice(0, 50).map((r) => {
        const v = new SkillStore(this.db, this.#scope).getVersion(r.to_version_id);
        let eligibility = 'ELIGIBLE';
        try {
          new SkillOperatorService(this.db, this.#scope).prepare({
            action: 'rollback',
            version_id: v.version.id,
          });
          validateApproval?.(v.version.id);
        } catch (e) {
          eligibility = e instanceof AgentMindError ? e.code : 'NOT_VERIFIED';
        }
        return { version_id: v.version.id, digest: v.version.content_hash, eligibility };
      });
      return {
        schema_version: 1,
        skill_id: identity.id,
        active_version_id: identity.active_version_id,
        targets,
        truncated: rows.length > 50,
        mutation_authorized: false,
        protected_deployment: 'NOT_VERIFIED',
      };
    })();
  }
  history(input: unknown) {
    const parsed = z
      .strictObject({
        skill_id: z.uuid(),
        limit: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().min(0).max(10000).default(0),
      })
      .safeParse(input);
    if (!parsed.success)
      throw new AgentMindError(
        'INVALID_INPUT',
        'Expected a skill UUID and bounded integer pagination.',
      );
    const p = parsed.data;
    return this.db.transaction(() => {
      new SkillStore(this.db, this.#scope).getIdentity(p.skill_id);
      const intents = this.db
        .prepare(
          'SELECT id,target,scope,status,stage_identity,created_at FROM skill_distribution_intents WHERE project_id=? AND skill_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?',
        )
        .all(this.#scope.id, p.skill_id, p.limit + 1, p.offset);
      const events = this.db
        .prepare(
          'SELECT id,intent_id,target,action,outcome,version_id,installed_digest,operator_id,authorization_method,context_digest,created_at FROM skill_distribution_events WHERE project_id=? AND skill_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?',
        )
        .all(this.#scope.id, p.skill_id, p.limit + 1, p.offset);
      return {
        schema_version: 1,
        project_id: this.#scope.id,
        skill_id: p.skill_id,
        intents: intents.slice(0, p.limit),
        events: events.slice(0, p.limit),
        next_offset:
          (intents.length > p.limit || events.length > p.limit) && p.offset + p.limit <= 10000
            ? p.offset + p.limit
            : null,
        truncated: intents.length > p.limit || events.length > p.limit,
        protected_deployment: 'NOT_VERIFIED',
        untrusted_data: true,
      };
    })();
  }
  commit(input: unknown, grant: unknown) {
    const prepared = this.db
      .transaction(() => {
        const plan = this.plan(input);
        const authorized = consumeOperatorGrant(grant, reviewDigest(plan));
        if (plan.entries.some((e) => e.action === 'CONFLICT'))
          throw new AgentMindError(
            'DISTRIBUTION_CONFLICT',
            'Plan contains a conflict; no installation files were changed.',
          );
        distributionCheckpoint('before_journal', '');
        migrateDistributionReliability(this.db);
        const operations = plan.entries.map((entry) => {
          if (entry.action === 'SKIP') return { entry, intent: null };
          if (entry.pending) {
            const intent = { ...entry.pending, worker_id: randomUUID() };
            const claimed = this.db
              .prepare(
                "UPDATE skill_distribution_intents SET worker_id=? WHERE id=? AND status='pending' AND worker_id=?",
              )
              .run(intent.worker_id, intent.id, entry.pending.worker_id);
            if (claimed.changes !== 1)
              throw new AgentMindError(
                'STALE_DISTRIBUTION',
                'Pending operation changed; inspect again.',
              );
            return { entry, intent };
          }
          const id = randomUUID();
          const at = nextTimestamp(entry.record?.updated_at);
          const manifest = entry.version_id
            ? installationManifestSchema.parse({
                schema_version: 1,
                agentmind_managed: true,
                registry_id: (
                  this.db
                    .prepare('SELECT id FROM skill_registry_identity WHERE singleton=1')
                    .get() as { id: string }
                ).id,
                installation_id: entry.record?.id ?? randomUUID(),
                skill_id: entry.skill_id,
                skill_name: entry.name,
                project_id: this.#scope.id,
                version_id: entry.version_id,
                version: entry.version,
                scope: entry.scope,
                target: entry.target,
                destination: entry.destination,
                registry_digest: entry.content_digest,
                installed_digest: entry.content_digest,
                installed_at: at,
              })
            : null;
          const intent: DistributionIntent = {
            id,
            project_id: this.#scope.id,
            skill_id: entry.skill_id,
            target: entry.target,
            scope: entry.scope,
            destination: entry.destination,
            action: entry.action,
            manifest_json: manifest ? JSON.stringify(manifest) : null,
            manifest_hash: manifest ? digestText(JSON.stringify(manifest)) : null,
            old_record_json: entry.record ? JSON.stringify(entry.record) : null,
            worker_id: randomUUID(),
            stage_identity: null,
            status: 'pending',
            operator_id: authorized.operator,
            session_id: authorized.session,
            context_digest: authorized.digest,
            created_at: at,
          };
          this.db
            .prepare(
              `INSERT INTO skill_distribution_intents (id,project_id,skill_id,target,scope,destination,action,manifest_json,manifest_hash,old_record_json,worker_id,stage_identity,status,operator_id,session_id,context_digest,created_at) VALUES (@id,@project_id,@skill_id,@target,@scope,@destination,@action,@manifest_json,@manifest_hash,@old_record_json,@worker_id,@stage_identity,@status,@operator_id,@session_id,@context_digest,@created_at)`,
            )
            .run(intent);
          this.event(
            entry,
            id,
            'PLANNED',
            'INTENT_DURABLE',
            entry.version_id,
            entry.content_digest,
            authorized,
          );
          return { entry, intent };
        });
        return { plan, operations, authorized };
      })
      .immediate();
    const authorized = prepared.authorized;
    distributionCheckpoint(
      'after_journal',
      prepared.operations.find((o) => o.intent)?.intent?.id ?? '',
    );
    const results = [];
    for (const { entry, intent } of prepared.operations) {
      if (!intent) {
        this.event(
          entry,
          null,
          'SKIP',
          'UNCHANGED',
          entry.version_id,
          entry.content_digest,
          authorized,
        );
        results.push({ target: entry.target, status: 'SKIP' });
        continue;
      }
      try {
        results.push(
          entry.pending
            ? this.recover(prepared.plan.request, entry, intent, authorized)
            : this.install(
                prepared.plan.request,
                entry,
                intent,
                authorized,
                reviewDigest(prepared.plan.registry),
              ),
        );
      } catch {
        try {
          this.event(
            entry,
            intent.id,
            entry.action,
            'RECOVERY_REQUIRED',
            entry.version_id,
            entry.content_digest,
            authorized,
          );
        } catch {
          /* Durable pending intent remains when storage is unavailable. */
        }
        throw new AgentMindError(
          'DISTRIBUTION_RECOVERY_REQUIRED',
          'Distribution did not finish. Preserve private work artifacts and run status/plan, then confirm recovery. Filesystem and SQLite are not one atomic transaction.',
        );
      }
    }
    return {
      results,
      outcome: prepared.operations.some((o) => o.entry.pending) ? 'REPLAN_REQUIRED' : 'COMPLETE',
      warning: WARNING,
      untrusted_data: true as const,
    };
  }
  private paths(entry: DistributionPlanEntry, intent: DistributionIntent) {
    z.uuid().parse(intent.id);
    const target = distributionDestination(
      this.#scope,
      this.#home,
      entry.target,
      entry.scope,
      entry.name,
    );
    if (
      intent.destination !== target.destination ||
      intent.project_id !== this.#scope.id ||
      intent.skill_id !== entry.skill_id ||
      intent.target !== entry.target ||
      intent.scope !== entry.scope
    )
      throw new Error('foreign intent');
    const work = join(target.base, '.agentmind', 'distribution-v1');
    return {
      ...target,
      work,
      stage: join(work, `${intent.id}.stage`),
      backup: join(work, `${intent.id}.backup`),
      quarantine: join(work, `${intent.id}.corrupt`),
      withdrawn: join(work, `${intent.id}.withdrawn`),
    };
  }
  private newRecord(intent: DistributionIntent): InstallationRecord | null {
    if (!intent.manifest_json) return null;
    const m = installationManifestSchema.parse(JSON.parse(intent.manifest_json));
    if (
      digestText(intent.manifest_json) !== intent.manifest_hash ||
      m.destination !== intent.destination ||
      m.project_id !== this.#scope.id ||
      m.skill_id !== intent.skill_id ||
      m.target !== intent.target ||
      m.scope !== intent.scope ||
      m.registry_digest !== m.installed_digest ||
      m.registry_id !==
        (
          this.db.prepare('SELECT id FROM skill_registry_identity WHERE singleton=1').get() as {
            id: string;
          }
        ).id
    )
      throw new Error('invalid intent');
    const old = intent.old_record_json
      ? (JSON.parse(intent.old_record_json) as InstallationRecord)
      : null;
    return {
      id: m.installation_id,
      project_id: m.project_id,
      skill_id: m.skill_id,
      version_id: m.version_id,
      target: m.target,
      scope: m.scope,
      destination: m.destination,
      installed_digest: m.installed_digest,
      manifest_json: intent.manifest_json,
      manifest_hash: intent.manifest_hash ?? '',
      root_identity: intent.stage_identity ?? '',
      status: 'installed',
      last_verified_at: null,
      created_at: old?.created_at ?? m.installed_at,
      updated_at: m.installed_at,
    };
  }
  private install(
    request: DistributionRequest,
    entry: DistributionPlanEntry,
    intent: DistributionIntent,
    auth: Auth,
    registryDigest: string,
  ) {
    distributionCheckpoint('before_staging', intent.id);
    const paths = this.paths(entry, intent);
    createSafeDirectories(paths.base, paths.work);
    createSafeDirectories(paths.base, paths.parent, this.publicationPermissions);
    const newRecord = this.newRecord(intent);
    if (newRecord) {
      const fresh = this.registry(request);
      if (fresh.artifact?.review.version.id !== entry.version_id)
        throw new Error('registry changed');
      const staged = materializePackage(
        paths.base,
        paths.stage,
        fresh.artifact.review.version.files,
        installationManifestSchema.parse(JSON.parse(intent.manifest_json ?? '')),
        this.publicationPermissions,
      );
      distributionCheckpoint('after_staging', intent.id);
      intent.stage_identity = staged.identity;
      const saved = this.db
        .prepare(
          "UPDATE skill_distribution_intents SET stage_identity=? WHERE id=? AND status='pending' AND worker_id=?",
        )
        .run(staged.identity, intent.id, intent.worker_id);
      if (saved.changes !== 1) throw new Error('operation ownership changed');
      newRecord.root_identity = staged.identity;
    }
    distributionCheckpoint('stage_recorded', intent.id);
    const published = this.db
      .transaction(() => {
        this.assertWorker(intent);
        const fresh = this.registry(request);
        if (
          reviewDigest(fresh) !== registryDigest ||
          (request.operation === 'sync' &&
            (fresh.error || fresh.identity.active_version_id !== entry.version_id))
        )
          throw new Error('registry changed');
        if (
          fileIdentity(paths.base) !== this.#roots.get(paths.base) ||
          lstatSync(paths.work).dev !== lstatSync(paths.parent).dev
        )
          throw new Error('root changed or cross-device move');
        inspectPath(paths.base, paths.parent);
        inspectPath(paths.base, paths.work);
        if (pathExists(paths.destination)) {
          if (!entry.record || !matchesRecord(inspectPackage(paths.destination), entry.record))
            throw new Error('local substitution');
          if (newRecord && !matchesRecord(inspectPackage(paths.stage), newRecord))
            throw new Error('stage integrity before backup');
          distributionCheckpoint('before_backup_rename', intent.id);
          moveChecked(paths.base, paths.destination, paths.backup);
          distributionCheckpoint('after_backup_rename', intent.id);
          if (!matchesRecord(inspectPackage(paths.backup), entry.record))
            throw new Error('backup changed');
        }
        if (newRecord) {
          distributionCheckpoint('before_publish_rename', intent.id);
          if (!matchesRecord(inspectPackage(paths.stage), newRecord))
            throw new Error('stage integrity before publication');
          moveChecked(paths.base, paths.stage, paths.destination);
          try {
            distributionCheckpoint('after_publish_rename', intent.id);
            if (!matchesRecord(inspectPackage(paths.destination), newRecord))
              throw new Error('published integrity');
          } catch (error) {
            this.quarantine(entry, intent);
            throw error;
          }
          this.store(newRecord);
        } else if (entry.record)
          this.db
            .prepare(
              "UPDATE skill_installations SET status='removed',updated_at=? WHERE id=? AND project_id=?",
            )
            .run(nextTimestamp(entry.record.updated_at), entry.record.id, this.#scope.id);
        distributionCheckpoint('before_registry_commit', intent.id);
        this.event(
          entry,
          intent.id,
          entry.action,
          'PUBLICATION_COMMITTED',
          newRecord?.version_id ?? entry.record?.version_id ?? null,
          newRecord?.installed_digest ?? entry.record?.installed_digest ?? null,
          auth,
        );
        return {
          target: entry.target,
          status: entry.action,
          intent_id: intent.id,
          retained_work: true,
        };
      })
      .immediate();
    distributionCheckpoint('after_registry_commit', intent.id);
    const retained = this.db
      .transaction(() => {
        this.assertWorker(intent);
        if (
          newRecord &&
          this.registry(request).artifact?.review.version.id !== newRecord.version_id
        )
          throw new Error('publication became stale');
        return this.finishRecovery(entry, intent, auth, 'COMPLETED', newRecord, entry.action);
      })
      .immediate();
    return { ...published, retained_work: retained };
  }
  private recover(
    request: DistributionRequest,
    entry: DistributionPlanEntry,
    intent: DistributionIntent,
    auth: Auth,
  ) {
    const paths = this.paths(entry, intent);
    inspectPath(paths.base, paths.parent);
    inspectPath(paths.base, paths.work);
    const old = intent.old_record_json
      ? (JSON.parse(intent.old_record_json) as InstallationRecord)
      : null;
    if (
      old &&
      (old.destination !== entry.destination ||
        old.project_id !== this.#scope.id ||
        old.skill_id !== entry.skill_id)
    )
      throw new Error('foreign old record');
    const next = this.newRecord(intent);
    const decision = this.db
      .prepare(
        'SELECT outcome,record_json FROM distribution_recovery_decisions WHERE intent_id=? AND project_id=?',
      )
      .get(intent.id, this.#scope.id) as
      | { outcome: string; record_json: string | null }
      | undefined;
    if (decision) {
      const record = decision.record_json
        ? (JSON.parse(decision.record_json) as InstallationRecord)
        : null;
      if (
        ![
          'ABORTED_UNPUBLISHED',
          'ABORTED_STALE_PUBLICATION',
          'RECOVERED_PUBLISHED',
          'RECOVERED_INSTALL',
          'RECOVERED_REMOVAL',
        ].includes(decision.outcome) ||
        (record && ![old, next].some((r) => r && reviewDigest(r) === reviewDigest(record)))
      )
        throw new Error('invalid recovery decision binding');
      let resolution = this.db
        .prepare(
          'SELECT outcome FROM distribution_recovery_resolutions WHERE intent_id=? AND project_id=?',
        )
        .get(intent.id, this.#scope.id) as { outcome: string } | undefined;
      let finalized: boolean | undefined;
      if (!resolution) {
        resolution = this.db
          .transaction(() => {
            this.assertWorker(intent);
            this.quarantine(entry, intent);
            const current = inspectPackage(paths.destination),
              fresh = this.registry(request);
            const matches = record && matchesRecord(current, record);
            const eligible =
              matches &&
              fresh.artifact?.review.version.id === record.version_id &&
              fresh.artifact.review.version.content_hash === record.installed_digest;
            const intendedRemoval = decision.outcome === 'RECOVERED_REMOVAL';
            const success = record && !decision.outcome.startsWith('ABORTED') && !intendedRemoval;
            // Unchanged valid success, or unchanged retained old copy after abort, can finalize.
            if (
              (eligible && !intendedRemoval) ||
              (current.status === 'missing' && !success && (!record || intendedRemoval))
            ) {
              // Keep the last eligibility check and normal finalization under one writer lock.
              finalized = this.finishRecovery(entry, intent, auth, decision.outcome, record);
              return undefined;
            }
            if (current.status !== 'missing') {
              if (!matches) throw new Error('unowned changed recovery destination');
              moveChecked(paths.base, paths.destination, paths.withdrawn);
            }
            const outcome =
              current.status === 'missing'
                ? pathExists(paths.quarantine)
                  ? 'ABORTED_CORRUPT_PUBLICATION'
                  : 'ABORTED_UNPUBLISHED'
                : 'ABORTED_STALE_PUBLICATION';
            this.db
              .prepare(
                "UPDATE skill_installations SET status='removed',updated_at=? WHERE destination=? AND project_id=? AND skill_id=?",
              )
              .run(nextTimestamp(), entry.destination, this.#scope.id, entry.skill_id);
            this.db
              .prepare('INSERT INTO distribution_recovery_resolutions VALUES(?,?,?)')
              .run(intent.id, this.#scope.id, outcome);
            this.event(entry, intent.id, 'REPAIR', outcome, null, null, auth);
            return { outcome };
          })
          .immediate();
      }
      if (finalized !== undefined)
        return {
          target: entry.target,
          status: 'REPAIR',
          intent_id: intent.id,
          replan_required: true,
          retained_work: finalized,
        };
      if (resolution) distributionCheckpoint('after_resolution_commit', intent.id);
      const retained = this.db
        .transaction(() => {
          this.assertWorker(intent);
          if (resolution && pathExists(paths.destination))
            throw new Error('resolved abort destination replaced');
          return this.finishRecovery(
            entry,
            intent,
            auth,
            resolution?.outcome ?? decision.outcome,
            resolution ? null : record,
          );
        })
        .immediate();
      return {
        target: entry.target,
        status: 'REPAIR',
        intent_id: intent.id,
        replan_required: true,
        retained_work: retained,
      };
    }
    let outcome = '';
    let record: InstallationRecord | null = null;
    const recovered = this.db
      .transaction(() => {
        const retainedWork = false;
        this.assertWorker(intent);
        if (fileIdentity(paths.base) !== this.#roots.get(paths.base))
          throw new Error('root changed');
        inspectPath(paths.base, paths.parent);
        inspectPath(paths.base, paths.work);
        this.quarantine(entry, intent);
        const current = inspectPackage(paths.destination);
        const ownedNext = next && matchesRecord(current, next);
        const ownedOld = old && matchesRecord(current, old);
        if (current.status !== 'missing' && !ownedNext && !ownedOld)
          throw new Error('unowned recovery destination');
        const fresh = this.registry(request);
        const eligibleNext =
          next &&
          !fresh.error &&
          fresh.artifact?.review.version.id === next.version_id &&
          fresh.artifact.review.version.content_hash === next.installed_digest;
        if (ownedNext && !eligibleNext) {
          if (pathExists(paths.stage)) throw new Error('stale publication work collision');
          moveChecked(paths.base, paths.destination, paths.stage);
          this.db
            .prepare(
              "UPDATE skill_installations SET status='removed',updated_at=? WHERE destination=? AND project_id=?",
            )
            .run(nextTimestamp(), entry.destination, this.#scope.id);
          outcome = 'ABORTED_STALE_PUBLICATION';
          record = old;
        } else if (ownedNext) {
          this.store(next);
          outcome = 'RECOVERED_PUBLISHED';
          record = next;
        } else if (ownedOld) {
          if (
            fresh.artifact?.review.version.id !== old.version_id ||
            fresh.artifact.review.version.content_hash !== old.installed_digest
          ) {
            moveChecked(paths.base, paths.destination, paths.backup);
            this.db
              .prepare(
                "UPDATE skill_installations SET status='removed',updated_at=? WHERE destination=? AND project_id=?",
              )
              .run(nextTimestamp(), entry.destination, this.#scope.id);
          }
          outcome = 'ABORTED_UNPUBLISHED';
          record = old;
        } else if (intent.action === 'REMOVE' || !next) {
          if (old)
            this.db
              .prepare(
                "UPDATE skill_installations SET status='removed',updated_at=? WHERE id=? AND project_id=?",
              )
              .run(nextTimestamp(old.updated_at), old.id, this.#scope.id);
          outcome = 'RECOVERED_REMOVAL';
          record = old;
        } else {
          if (
            eligibleNext &&
            request.operation === 'sync' &&
            intent.stage_identity &&
            matchesRecord(inspectPackage(paths.stage), next)
          ) {
            createSafeDirectories(paths.base, paths.parent, this.publicationPermissions);
            moveChecked(paths.base, paths.stage, paths.destination);
            if (!matchesRecord(inspectPackage(paths.destination), next)) {
              this.quarantine(entry, intent);
              throw new Error('recovery integrity');
            }
            this.store(next);
            outcome = 'RECOVERED_INSTALL';
            record = next;
          } else {
            if (old)
              this.db
                .prepare(
                  "UPDATE skill_installations SET status='removed',updated_at=? WHERE id=? AND project_id=?",
                )
                .run(nextTimestamp(old.updated_at), old.id, this.#scope.id);
            outcome = 'ABORTED_UNPUBLISHED';
            record = old;
          }
        }
        this.db
          .prepare('INSERT INTO distribution_recovery_decisions VALUES(?,?,?,?)')
          .run(intent.id, this.#scope.id, outcome, record ? JSON.stringify(record) : null);
        this.event(
          entry,
          intent.id,
          'REPAIR',
          'RECOVERY_STATE_COMMITTED',
          record?.version_id ?? null,
          record?.installed_digest ?? null,
          auth,
        );
        return {
          target: entry.target,
          status: 'REPAIR',
          intent_id: intent.id,
          replan_required: true,
          retained_work: retainedWork,
        };
      })
      .immediate();
    distributionCheckpoint('after_recovery_commit', intent.id);
    const retained = this.db
      .transaction(() => {
        this.assertWorker(intent);
        return this.finishRecovery(entry, intent, auth, outcome, record);
      })
      .immediate();
    return { ...recovered, retained_work: retained };
  }
  private quarantine(entry: DistributionPlanEntry, intent: DistributionIntent) {
    const paths = this.paths(entry, intent),
      next = this.newRecord(intent);
    if (
      next &&
      intent.stage_identity &&
      pathExists(paths.destination) &&
      fileIdentity(paths.destination) === intent.stage_identity &&
      !matchesRecord(inspectPackage(paths.destination), next)
    ) {
      if (
        !lstatSync(paths.destination).isDirectory() ||
        lstatSync(paths.destination).isSymbolicLink()
      )
        throw new Error('unsafe quarantine root');
      moveChecked(paths.base, paths.destination, paths.quarantine);
    }
  }
  private cleanup(entry: DistributionPlanEntry, intent: DistributionIntent) {
    const paths = this.paths(entry, intent);
    const old = intent.old_record_json
      ? (JSON.parse(intent.old_record_json) as InstallationRecord)
      : null;
    const next = this.newRecord(intent);
    let retained = pathExists(paths.quarantine);
    for (const [path, record] of [
      [paths.backup, old],
      [
        paths.withdrawn,
        [old, next].find((r) => r && matchesRecord(inspectPackage(paths.withdrawn), r)) ?? null,
      ],
      [paths.stage, intent.stage_identity ? next : null],
    ] as const) {
      if (!pathExists(path)) continue;
      if (record && matchesRecord(inspectPackage(path), record))
        deleteCheckedPackage(paths.base, path, record);
      else retained = true; // Crash before ownership stamp, or local edits: preserve for manual inspection.
    }
    return retained;
  }
  private assertWorker(intent: DistributionIntent) {
    const row = this.db
      .prepare(
        "SELECT id FROM skill_distribution_intents WHERE id=? AND status='pending' AND worker_id=?",
      )
      .get(intent.id, intent.worker_id);
    if (!row)
      throw new AgentMindError(
        'STALE_DISTRIBUTION',
        'Operation completed or another confirmed recovery took ownership.',
      );
  }
  private finishRecovery(
    entry: DistributionPlanEntry,
    intent: DistributionIntent,
    auth: Auth,
    outcome: string,
    record: InstallationRecord | null,
    eventAction: string = 'REPAIR',
  ) {
    distributionCheckpoint('before_cleanup', intent.id);
    const retained = this.cleanup(entry, intent);
    distributionCheckpoint('after_cleanup', intent.id);
    if (retained)
      this.event(
        entry,
        intent.id,
        'CLEANUP',
        'UNPROVEN_PRIVATE_WORK_RETAINED',
        record?.version_id ?? null,
        record?.installed_digest ?? null,
        auth,
      );
    this.db
      .prepare("UPDATE skill_distribution_intents SET status=? WHERE id=? AND status='pending'")
      .run(outcome.startsWith('ABORTED') ? 'aborted' : 'completed', intent.id);
    this.event(
      entry,
      intent.id,
      eventAction,
      outcome,
      record?.version_id ?? null,
      record?.installed_digest ?? null,
      auth,
    );
    return retained;
  }
  private store(record: InstallationRecord) {
    this.db
      .prepare(`INSERT INTO skill_installations (id,project_id,skill_id,version_id,target,scope,destination,installed_digest,manifest_json,manifest_hash,root_identity,status,last_verified_at,created_at,updated_at)
      VALUES (@id,@project_id,@skill_id,@version_id,@target,@scope,@destination,@installed_digest,@manifest_json,@manifest_hash,@root_identity,@status,@last_verified_at,@created_at,@updated_at)
      ON CONFLICT(destination) DO UPDATE SET version_id=excluded.version_id,installed_digest=excluded.installed_digest,manifest_json=excluded.manifest_json,manifest_hash=excluded.manifest_hash,root_identity=excluded.root_identity,status='installed',last_verified_at=excluded.last_verified_at,updated_at=excluded.updated_at`)
      .run(record);
  }
  private event(
    entry: DistributionPlanEntry,
    intent: string | null,
    action: string,
    outcome: string,
    version: string | null,
    digest: string | null,
    auth: Auth,
    method = auth.broker_peer ? 'kernel-peer-uid-v1' : 'local-tty-confirmation-v1',
  ) {
    distributionCheckpoint('before_audit', intent ?? '');
    this.db
      .prepare(
        `INSERT INTO skill_distribution_events (id,project_id,skill_id,destination,target,scope,intent_id,action,outcome,version_id,installed_digest,operator_id,authorization_method,session_id,context_digest,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        randomUUID(),
        this.#scope.id,
        entry.skill_id,
        entry.destination,
        entry.target,
        entry.scope,
        intent,
        action,
        outcome,
        version,
        digest,
        auth.operator,
        method,
        auth.session || null,
        auth.digest,
        nextTimestamp(),
      );
  }
}
