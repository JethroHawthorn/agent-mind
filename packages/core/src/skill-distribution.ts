import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { AgentMindError } from './errors.js';
import { localOperatorIdentity } from './local-operator.js';
import { consumeOperatorGrant, reviewDigest } from './operator-confirmation.js';
import type { ProjectScope } from './project.js';
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
type Auth = { operator: string; session: string; digest: string };

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
        const eligible = new SkillOperatorService(this.db, this.#scope).prepare({
          action: 'promote',
          version_id: identity.active_version_id,
        });
        artifact = {
          review: {
            ...eligible.review,
            warning: 'Registry provenance only; distribution entries govern filesystem changes.',
          },
        };
        const event = this.db
          .prepare(
            `SELECT id FROM skill_operator_events WHERE project_id=? AND version_id=? AND promotion_id=? AND action IN ('promote','rollback') AND content_hash=? AND authorization_method='local-tty-confirmation-v1'`,
          )
          .get(
            this.#scope.id,
            identity.active_version_id,
            identity.last_transition_id,
            artifact.review.version.content_hash,
          );
        if (!event)
          throw new AgentMindError(
            'OPERATOR_APPROVAL_REQUIRED',
            'Active transition lacks operator provenance.',
          );
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
          return { entry, intent };
        });
        return { plan, operations, authorized };
      })
      .immediate();
    const authorized = prepared.authorized;
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
    return { results, warning: WARNING, untrusted_data: true as const };
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
      intent.skill_id !== entry.skill_id
    )
      throw new Error('foreign intent');
    const work = join(target.base, '.agentmind', 'distribution-v1');
    return {
      ...target,
      work,
      stage: join(work, `${intent.id}.stage`),
      backup: join(work, `${intent.id}.backup`),
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
      m.scope !== intent.scope
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
    const paths = this.paths(entry, intent);
    createSafeDirectories(paths.base, paths.work, this.publicationPermissions);
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
      intent.stage_identity = staged.identity;
      const saved = this.db
        .prepare(
          "UPDATE skill_distribution_intents SET stage_identity=? WHERE id=? AND status='pending' AND worker_id=?",
        )
        .run(staged.identity, intent.id, intent.worker_id);
      if (saved.changes !== 1) throw new Error('operation ownership changed');
      newRecord.root_identity = staged.identity;
    }
    return this.db
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
          moveChecked(paths.base, paths.destination, paths.backup);
          if (!matchesRecord(inspectPackage(paths.backup), entry.record))
            throw new Error('backup changed');
        }
        if (newRecord) {
          moveChecked(paths.base, paths.stage, paths.destination);
          if (!matchesRecord(inspectPackage(paths.destination), newRecord))
            throw new Error('published integrity');
          this.store(newRecord);
        } else if (entry.record)
          this.db
            .prepare(
              "UPDATE skill_installations SET status='removed',updated_at=? WHERE id=? AND project_id=?",
            )
            .run(nextTimestamp(entry.record.updated_at), entry.record.id, this.#scope.id);
        const retained = this.cleanup(entry, intent);
        if (retained)
          this.event(
            entry,
            intent.id,
            'CLEANUP',
            'UNPROVEN_PRIVATE_WORK_RETAINED',
            entry.version_id,
            entry.content_digest,
            auth,
          );
        this.db
          .prepare(
            "UPDATE skill_distribution_intents SET status='completed' WHERE id=? AND status='pending'",
          )
          .run(intent.id);
        this.event(
          entry,
          intent.id,
          entry.action,
          'COMPLETED',
          newRecord?.version_id ?? entry.record?.version_id ?? null,
          newRecord?.installed_digest ?? entry.record?.installed_digest ?? null,
          auth,
        );
        return {
          target: entry.target,
          status: entry.action,
          intent_id: intent.id,
          retained_work: retained,
        };
      })
      .immediate();
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
    return this.db
      .transaction(() => {
        let retainedWork = false;
        this.assertWorker(intent);
        if (fileIdentity(paths.base) !== this.#roots.get(paths.base))
          throw new Error('root changed');
        inspectPath(paths.base, paths.parent);
        inspectPath(paths.base, paths.work);
        const current = inspectPackage(paths.destination);
        const ownedNext = next && matchesRecord(current, next);
        const ownedOld = old && matchesRecord(current, old);
        if (current.status !== 'missing' && !ownedNext && !ownedOld)
          throw new Error('unowned recovery destination');
        if (ownedNext) {
          this.store(next);
          retainedWork = this.finishRecovery(entry, intent, auth, 'RECOVERED_PUBLISHED', next);
        } else if (ownedOld) {
          retainedWork = this.finishRecovery(entry, intent, auth, 'ABORTED_UNPUBLISHED', old);
        } else if (intent.action === 'REMOVE' || !next) {
          if (old)
            this.db
              .prepare(
                "UPDATE skill_installations SET status='removed',updated_at=? WHERE id=? AND project_id=?",
              )
              .run(nextTimestamp(old.updated_at), old.id, this.#scope.id);
          retainedWork = this.finishRecovery(entry, intent, auth, 'RECOVERED_REMOVAL', old);
        } else {
          const fresh = this.registry(request);
          if (
            !fresh.error &&
            request.operation === 'sync' &&
            fresh.identity.active_version_id === next.version_id &&
            intent.stage_identity &&
            matchesRecord(inspectPackage(paths.stage), next)
          ) {
            createSafeDirectories(paths.base, paths.parent, this.publicationPermissions);
            moveChecked(paths.base, paths.stage, paths.destination);
            if (!matchesRecord(inspectPackage(paths.destination), next))
              throw new Error('recovery integrity');
            this.store(next);
            retainedWork = this.finishRecovery(entry, intent, auth, 'RECOVERED_INSTALL', next);
          } else {
            if (old)
              this.db
                .prepare(
                  "UPDATE skill_installations SET status='removed',updated_at=? WHERE id=? AND project_id=?",
                )
                .run(nextTimestamp(old.updated_at), old.id, this.#scope.id);
            retainedWork = this.finishRecovery(entry, intent, auth, 'ABORTED_UNPUBLISHED', old);
          }
        }
        return {
          target: entry.target,
          status: 'REPAIR',
          intent_id: intent.id,
          replan_required: true,
          retained_work: retainedWork,
        };
      })
      .immediate();
  }
  private cleanup(entry: DistributionPlanEntry, intent: DistributionIntent) {
    const paths = this.paths(entry, intent);
    const old = intent.old_record_json
      ? (JSON.parse(intent.old_record_json) as InstallationRecord)
      : null;
    const next = this.newRecord(intent);
    let retained = false;
    for (const [path, record] of [
      [paths.backup, old],
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
  ) {
    const retained = this.cleanup(entry, intent);
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
      'REPAIR',
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
    method = 'local-tty-confirmation-v1',
  ) {
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
