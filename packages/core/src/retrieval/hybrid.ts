import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { AgentMindError } from '../errors.js';
import type { ProjectScope } from '../project.js';
import {
  DISCOVERY_FEATURE_POLICY,
  type DiscoveryFeatures,
  discoveryFeatures,
  HYBRID_POLICY,
} from './features.js';
import { type HybridCandidate, hybridCandidates } from './hybrid-query.js';
import { parseRetrieval, RETRIEVAL_WARNING } from './model.js';
import { queryTerms } from './ranking.js';
import { normalizeTask, type RoutingMetadata } from './routing.js';
import { RoutingCache } from './routing-cache.js';
import { routingConfigSchema, skillRouteSchema } from './routing-model.js';
export type HybridArtifact = RoutingMetadata & { main: string };
const norm = (s: string) => queryTerms(s).terms.join(' ');
const words = (s: string) =>
  new Set(
    s
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [],
  );
// Object nouns alone do not identify a reusable task. Keep them searchable, but
// require another signal before showing a card for a multiword task description.
const genericObjects = new Set([
  'data',
  'record',
  'records',
  'field',
  'fields',
  'task',
  'tasks',
  'workflow',
  'workflows',
  'procedure',
  'procedures',
  'content',
  'file',
  'files',
  'input',
  'inputs',
  'output',
  'outputs',
]);
const hintName = (s: string) => {
  const n = s
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
  return ({ ts: 'typescript', js: 'javascript', next: 'nextjs' } as Record<string, string>)[n] ?? n;
};
const overlaps = (a: string[], b: string[]) =>
  a.some((x) => b.some((y) => hintName(x) === hintName(y)));
const errors: Readonly<Record<string, string[]>> = {
  SQLITE_BUSY: ['sqlite', 'busy', 'retry'],
  EADDRINUSE: ['port', 'address', 'collision'],
  TS2322: ['typescript', 'type', 'assignment'],
};
export class HybridSkillRouter {
  readonly #scope: ProjectScope;
  readonly #config;
  readonly #cache: RoutingCache<HybridCandidate[]>;
  #generation = '';
  constructor(
    private readonly db: Database.Database,
    scope: ProjectScope,
    private readonly limit: number,
    private readonly resolve: (id: string) => HybridArtifact,
    config: unknown = {},
  ) {
    this.#scope = Object.freeze({ ...scope });
    this.#config = Object.freeze(routingConfigSchema.parse(config));
    this.#cache = new RoutingCache(
      this.#config.cache_entries,
      this.#config.cache_bytes,
      this.#config.cache_ttl_ms,
    );
  }
  route(input: unknown) {
    const p = parseRetrieval(skillRouteSchema, input),
      n = normalizeTask(p.context),
      top = p.limit ?? this.#config.top_k;
    const expansion = p.expand
      ? (errors[p.context.diagnostic?.trim().toUpperCase() ?? ''] ?? [])
      : [];
    const terms = [...new Set([...n.summary.terms, ...expansion, ...n.hintTerms])].slice(0, 24);
    return this.db.transaction(() => {
      const generation = JSON.stringify([
        this.db.pragma('data_version', { simple: true }),
        this.db.pragma('schema_version', { simple: true }),
        this.db.prepare('SELECT total_changes() n').get(),
      ]);
      if (generation !== this.#generation) {
        this.#cache.clear();
        this.#generation = generation;
      }
      const key = createHash('sha256')
        .update(
          JSON.stringify([
            HYBRID_POLICY,
            DISCOVERY_FEATURE_POLICY,
            this.#scope,
            n.key,
            terms,
            p.expand,
            top,
            this.limit,
            this.#config,
            generation,
          ]),
        )
        .digest('hex');
      let candidates = this.#cache.get(key);
      const hit = candidates !== undefined;
      if (!candidates) {
        candidates = hybridCandidates(
          this.db,
          this.#scope,
          terms,
          n.summary.normalized,
          this.limit,
        );
        this.#cache.set(key, candidates);
      }
      const task = norm([p.context.summary, ...n.hintTerms].join(' '));
      let incomplete = false;
      const ranked: Array<{
        a: HybridArtifact;
        f: DiscoveryFeatures;
        matched: string[];
        expanded: string[];
        hints: string[];
        stemmed: boolean;
        alias: boolean;
        exact: boolean;
      }> = [];
      for (const row of candidates) {
        let a: HybridArtifact;
        try {
          a = this.resolve(row.skill_id);
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
        if (
          a.active_version_id !== row.version_id ||
          a.content_digest !== row.content_hash ||
          a.name !== row.name ||
          a.description !== row.description
        )
          continue;
        const f = discoveryFeatures(a.main, a.description);
        if (row.metadata !== undefined && row.metadata !== f.prefix) continue;
        if (f.invalid || !f.complete) {
          incomplete = true;
          continue;
        }
        if (
          p.context.languages.length &&
          f.languages.length &&
          !overlaps(p.context.languages, f.languages)
        )
          continue;
        if (
          p.context.frameworks.length &&
          f.frameworks.length &&
          !overlaps(p.context.frameworks, f.frameworks)
        )
          continue;
        if (
          f.not_for.some((text) => {
            const phrase = norm(text);
            return phrase && ` ${task} `.includes(` ${phrase} `);
          })
        )
          continue;
        const text = words(
          [a.name, a.description, f.purpose, ...f.aliases, ...f.triggers, f.when_to_use].join(' '),
        );
        if (n.excluded.some((t) => text.has(t))) continue;
        const matched = n.summary.terms.filter((t) => text.has(t));
        const expanded = expansion.filter((t) => text.has(t));
        const hints = [
          ...p.context.languages.filter((x) => overlaps([x], f.languages)),
          ...p.context.frameworks.filter((x) => overlaps([x], f.frameworks)),
        ];
        let stemmed = false;
        if (!matched.length && !expanded.length && !hints.length && n.summary.terms.length) {
          const match = n.summary.terms.map((t) => `"${t}"`).join(' AND ');
          stemmed = !!this.db
            .prepare(
              'SELECT 1 FROM skill_version_retrieval_fts WHERE skill_version_retrieval_fts MATCH ? AND project_id=? AND version_id=? AND name=? AND description=? LIMIT 1',
            )
            .get(match, this.#scope.id, a.active_version_id, a.name, a.description);
        }
        const alias = f.aliases.some((x) => norm(x) === norm(p.context.summary));
        const exact = a.name === n.summary.normalized;
        const declaredPhrase = [...f.aliases, ...f.triggers].some((text) => {
          const phrase = norm(text);
          return phrase && ` ${task} `.includes(` ${phrase} `);
        });
        if (!matched.length && !expanded.length && !hints.length && !stemmed) continue;
        if (
          n.summary.terms.length > 1 &&
          !exact &&
          !declaredPhrase &&
          !expanded.length &&
          !hints.length &&
          !stemmed &&
          !matched.some((term) => !genericObjects.has(term))
        )
          continue;
        ranked.push({ a, f, matched, expanded, hints, stemmed, alias, exact });
      }
      ranked.sort(
        (a, b) =>
          Number(b.exact) - Number(a.exact) ||
          Number(b.alias) - Number(a.alias) ||
          b.matched.length - a.matched.length ||
          b.hints.length - a.hints.length ||
          b.expanded.length - a.expanded.length ||
          (a.a.name < b.a.name
            ? -1
            : a.a.name > b.a.name
              ? 1
              : a.a.skill_id.localeCompare(b.a.skill_id)),
      );
      const skills: Array<{
        skill_id: string;
        name: string;
        purpose: string;
        purpose_truncated: boolean;
        when_to_use: string;
        when_not_to_use: string[];
        preconditions: string[];
        languages: string[];
        frameworks: string[];
        distinguishes: string;
        active_version_id: string;
        content_digest: string;
        scope: string;
        match: {
          exact_name: boolean;
          exact_alias: boolean;
          terms: string[];
          expanded_terms: string[];
          explicit_hints: string[];
          stemmed_task: boolean;
        };
      }> = [];
      const result = () => ({
        outcome: skills.length
          ? ranked[0]?.exact &&
            skills.length === 1 &&
            !incomplete &&
            !ranked[0].f.preconditions.length &&
            !ranked[0].f.not_for.length
            ? 'RECOMMEND_ONE'
            : 'SHORTLIST'
          : incomplete || n.summary.terms.length < 2
            ? 'INSUFFICIENT_CONTEXT'
            : 'NO_MATCH',
        skills,
        selection_required: skills.length > 0,
        selection_method: 'IN_SESSION_AGENT; not deterministic semantic verification',
        incomplete,
        truncated: incomplete,
        search_complete: false,
        continuation: incomplete
          ? 'Some eligible cards cannot be represented completely. Narrow the task or use bounded legacy discovery and exact content inspection; do not assume omitted constraints are absent.'
          : p.expand
            ? 'Expansion used; request more context or abstain.'
            : 'If inadequate, request limit up to 10 and expand:true once; otherwise abstain.',
        scope: 'project',
        project_id: this.#scope.id,
        diagnostics: {
          policy: HYBRID_POLICY,
          metadata_policy: DISCOVERY_FEATURE_POLICY,
          metadata_provenance: 'IMMUTABLE_PACKAGE; declared fields only',
          semantic_search: false,
          cache_hit: hit,
          search_bounded: true,
          expansion_used: p.expand,
          telemetry_recorded: false,
        },
        warning: RETRIEVAL_WARNING,
        untrusted_data: true,
      });
      for (const r of ranked) {
        if (skills.length >= top) {
          incomplete = true;
          break;
        }
        const { a, f } = r;
        if (f.purpose.length > this.#config.description_chars) incomplete = true;
        const card = {
          skill_id: a.skill_id,
          name: a.name,
          purpose: f.purpose.slice(0, this.#config.description_chars),
          purpose_truncated: f.purpose.length > this.#config.description_chars,
          when_to_use: f.when_to_use,
          when_not_to_use: f.not_for,
          preconditions: f.preconditions,
          languages: f.languages,
          frameworks: f.frameworks,
          distinguishes: f.distinguishes,
          active_version_id: a.active_version_id,
          content_digest: a.content_digest,
          scope: 'project',
          match: {
            exact_name: r.exact,
            exact_alias: r.alias,
            terms: r.matched.slice(0, 12),
            expanded_terms: r.expanded,
            explicit_hints: r.hints.slice(0, 6),
            stemmed_task: r.stemmed,
          },
        };
        skills.push(card);
        if (Buffer.byteLength(JSON.stringify(result())) > this.#config.response_bytes) {
          skills.pop();
          incomplete = true;
          break;
        }
      }
      while (
        skills.length &&
        Buffer.byteLength(JSON.stringify(result())) > this.#config.response_bytes
      ) {
        skills.pop();
        incomplete = true;
      }
      const response = result();
      if (Buffer.byteLength(JSON.stringify(response)) > this.#config.response_bytes)
        throw new AgentMindError(
          'RETRIEVAL_OUTPUT_LIMIT',
          'Selection-card envelope exceeds the trusted budget.',
        );
      return response;
    })();
  }
}
