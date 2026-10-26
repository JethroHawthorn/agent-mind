import type Database from 'better-sqlite3';
import { AgentMindError } from '../errors.js';
import type { ProjectScope } from '../project.js';
import { resolveActiveArtifact } from '../skill-active-artifact.js';
import {
  parseRetrieval,
  RETRIEVAL_POLICY,
  RETRIEVAL_WARNING,
  type RetrievalConfig,
  retrievalConfigSchema,
  type Selection,
  skillDiscoverSchema,
  skillLoadSchema,
  skillResourceGetSchema,
  skillResourcesSchema,
} from './model.js';
import { contentPage, resourceDigest } from './projection.js';
import { retrieveCandidates } from './ranking.js';
import { SkillRouter } from './routing.js';

/** No migration, filesystem access, telemetry writes or lifecycle writes occur in this service. */
export class SkillRetrievalService {
  readonly #scope: ProjectScope;
  readonly #config: RetrievalConfig;
  readonly #router: SkillRouter;
  constructor(
    private readonly db: Database.Database,
    scope: ProjectScope,
    config: unknown = {},
    routingConfig: unknown = {},
  ) {
    this.#scope = Object.freeze({ ...scope });
    const parsed = retrievalConfigSchema.safeParse(config);
    if (!parsed.success)
      throw new AgentMindError(
        'RETRIEVAL_INVALID_CONFIG',
        'Invalid trusted retrieval output limits.',
      );
    this.#config = Object.freeze(parsed.data);
    this.#router = new SkillRouter(
      db,
      this.#scope,
      this.#config.candidate_limit,
      (id) => {
        const a = this.artifact({ skill_id: id, offset: 0 });
        return {
          skill_id: a.review.identity.id,
          name: a.review.identity.name,
          description: a.review.version.description,
          active_version_id: a.review.version.id,
          content_digest: a.review.version.content_hash,
        };
      },
      routingConfig,
    );
  }
  route(input: unknown) {
    return this.#router.route(input);
  }
  discover(input: unknown) {
    const p = parseRetrieval(skillDiscoverSchema, input),
      limit = p.limit ?? this.#config.top_k;
    return this.db.transaction(() => {
      const found = retrieveCandidates(this.db, this.#scope, p.query, this.#config.candidate_limit);
      const skills: Array<{
        skill_id: string;
        name: string;
        description: string;
        description_truncated: boolean;
        active_version_id: string;
        scope: 'project';
        project_id: string;
        content_digest: string;
        rationale: string[];
      }> = [];
      let truncated = found.truncated;
      const response = () => ({
        skills,
        selection_required: skills.length > 0,
        ambiguity:
          skills.length > 1
            ? 'MULTIPLE_LEXICAL_MATCHES'
            : skills.length === 1
              ? 'SINGLE_LEXICAL_MATCH'
              : 'NO_ELIGIBLE_MATCH',
        truncated,
        diagnostics: {
          policy: RETRIEVAL_POLICY,
          matching: 'LEXICAL_METADATA',
          semantic_search: false,
          candidate_verification_limit: this.#config.candidate_limit,
          ranking:
            'Exact name, name term hits, active description term hits, name and ID. Lexical relevance is not semantic certainty or effectiveness.',
          scope_policy: 'Trusted startup project only; no global visibility.',
          query_terms_truncated: found.terms_truncated,
          telemetry_recorded: false,
        },
        fallback:
          skills.length === 0
            ? 'No eligible lexical match was found in this bounded search; this does not prove that no relevant skill exists. Rephrase once with a concrete technology, workflow or skill name already known from the task. If uncertain, proceed without a guessed skill.'
            : 'Refine the task query or explicitly select an eligible skill; do not execute a guessed match.',
        warning: RETRIEVAL_WARNING,
        untrusted_data: true,
      });
      for (const row of found.rows) {
        let artifact: ReturnType<SkillRetrievalService['artifact']>;
        try {
          artifact = this.artifact({ skill_id: row.skill_id, offset: 0 });
        } catch (e) {
          if (
            e instanceof AgentMindError &&
            ['RETRIEVAL_NOT_FOUND', 'RETRIEVAL_UNAVAILABLE', 'RETRIEVAL_INTEGRITY_ERROR'].includes(
              e.code,
            )
          )
            continue;
          throw e;
        }
        if (skills.length === limit) {
          truncated = true;
          break;
        }
        const description = artifact.review.version.description;
        const rationale = [
          ...(row.exact_name ? ['Exact normalized name match.'] : []),
          ...(row.name_hits ? ['Name contains query terms.'] : []),
          ...(row.description_hits ? ['Active description contains query terms.'] : []),
          ...(!row.name_hits && !row.description_hits
            ? ['FTS5 normalized/stemmed metadata match.']
            : []),
        ];
        skills.push({
          skill_id: row.skill_id,
          name: artifact.review.identity.name,
          description: description.slice(0, this.#config.description_chars),
          description_truncated: description.length > this.#config.description_chars,
          active_version_id: artifact.review.version.id,
          scope: 'project',
          project_id: this.#scope.id,
          content_digest: artifact.review.version.content_hash,
          rationale,
        });
        if (Buffer.byteLength(JSON.stringify(response())) > this.#config.discovery_bytes) {
          skills.pop();
          truncated = true;
          break;
        }
      }
      const result = response();
      if (Buffer.byteLength(JSON.stringify(result)) > this.#config.discovery_bytes)
        throw new AgentMindError(
          'RETRIEVAL_OUTPUT_LIMIT',
          'Discovery metadata exceeds the configured output bound.',
        );
      return result;
    })();
  }
  load(input: unknown) {
    const p = parseRetrieval(skillLoadSchema, input);
    return this.db.transaction(() => {
      const artifact = this.artifact(p),
        file = artifact.review.version.files.find((f) => f.path === 'SKILL.md');
      if (!file)
        throw new AgentMindError(
          'RETRIEVAL_INTEGRITY_ERROR',
          'Canonical main skill content is missing.',
        );
      return contentPage(
        {
          ...this.identity(artifact),
          path: 'SKILL.md',
          file_digest: resourceDigest(file.content),
          telemetry_recorded: false,
          warning: RETRIEVAL_WARNING,
        },
        file.content,
        p.offset,
        this.#config.content_bytes,
      );
    })();
  }
  resources(input: unknown) {
    const p = parseRetrieval(skillResourcesSchema, input);
    return this.db.transaction(() => {
      const artifact = this.artifact({ ...p, offset: 0 }),
        files = artifact.review.version.files
          .filter((f) => f.path !== 'SKILL.md')
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const resources: Array<{
        path: string;
        bytes: number;
        chars: number;
        file_digest: string;
        format: string;
      }> = [];
      const response = () => ({
        ...this.identity(artifact),
        resources,
        next_offset:
          files.length > p.offset + resources.length ? p.offset + resources.length : null,
        truncated: files.length > p.offset + resources.length,
        warning: RETRIEVAL_WARNING,
        telemetry_recorded: false,
        untrusted_data: true,
      });
      for (const f of files.slice(p.offset, p.offset + p.limit)) {
        resources.push({
          path: f.path,
          bytes: Buffer.byteLength(f.content),
          chars: f.content.length,
          file_digest: resourceDigest(f.content),
          format: 'markdown-text',
        });
        if (Buffer.byteLength(JSON.stringify(response())) > this.#config.content_bytes) {
          resources.pop();
          break;
        }
      }
      return response();
    })();
  }
  resource(input: unknown) {
    const p = parseRetrieval(skillResourceGetSchema, input);
    return this.db.transaction(() => {
      const artifact = this.artifact(p);
      if (
        !/^references\/(?:[A-Za-z0-9][A-Za-z0-9_-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(p.path)
      )
        throw new AgentMindError(
          'RETRIEVAL_RESOURCE_UNSUPPORTED',
          'Only canonical packaged Markdown references are supported; binary and executable resources are unsupported.',
        );
      const file = artifact.review.version.files.find((f) => f.path === p.path);
      if (!file)
        throw new AgentMindError(
          'RETRIEVAL_RESOURCE_NOT_FOUND',
          'Resource unavailable in this verified package.',
        );
      return contentPage(
        {
          ...this.identity(artifact),
          path: file.path,
          file_digest: resourceDigest(file.content),
          telemetry_recorded: false,
          warning: RETRIEVAL_WARNING,
        },
        file.content,
        p.offset,
        this.#config.content_bytes,
      );
    })();
  }
  private artifact(p: Selection) {
    const active = this.db
      .prepare(
        `SELECT k.active_version_id FROM skills k JOIN skill_versions v ON v.id=k.active_version_id AND v.project_id=k.project_id JOIN skill_version_states s ON s.version_id=v.id AND s.project_id=v.project_id WHERE k.id=? AND k.project_id=? AND s.status='approved'`,
      )
      .get(p.skill_id, this.#scope.id);
    if (!active)
      throw new AgentMindError(
        'RETRIEVAL_NOT_FOUND',
        'Eligible skill unavailable in this project.',
      );
    let artifact: ReturnType<typeof resolveActiveArtifact>;
    try {
      artifact = resolveActiveArtifact(this.db, this.#scope, p.skill_id);
    } catch (e) {
      if (e instanceof AgentMindError && e.code === 'SKILL_INTEGRITY_ERROR')
        throw new AgentMindError(
          'RETRIEVAL_INTEGRITY_ERROR',
          'Canonical skill package integrity check failed.',
        );
      if (e instanceof AgentMindError)
        throw new AgentMindError(
          'RETRIEVAL_UNAVAILABLE',
          'Active artifact is not eligible under the existing evaluation, source approval and operator provenance policy.',
        );
      if ((e as { name?: string })?.name === 'ZodError')
        throw new AgentMindError(
          'RETRIEVAL_INTEGRITY_ERROR',
          'Canonical skill package integrity check failed.',
        );
      throw new AgentMindError(
        'RETRIEVAL_STORAGE_FAILED',
        'Cannot resolve the canonical active artifact.',
      );
    }
    const v = artifact.review.version;
    if (
      (p.expected_version_id && p.expected_version_id !== v.id) ||
      (p.expected_digest && p.expected_digest !== v.content_hash)
    )
      throw new AgentMindError(
        'RETRIEVAL_STALE',
        'Selected version or digest is no longer active. Refresh discovery; no alternate version was served.',
      );
    return artifact;
  }
  private identity(a: ReturnType<typeof resolveActiveArtifact>) {
    return {
      skill_id: a.review.identity.id,
      name: a.review.identity.name,
      version_id: a.review.version.id,
      content_digest: a.review.version.content_hash,
      scope: 'project',
      project_id: this.#scope.id,
      policy: RETRIEVAL_POLICY,
    };
  }
}
