import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { AgentMindError } from '../errors.js';
import type { ProjectScope } from '../project.js';
import { parseRetrieval, RETRIEVAL_WARNING } from './model.js';
import { queryTerms, type RankedCandidate, retrieveCandidates } from './ranking.js';
import { RoutingCache } from './routing-cache.js';
import {
  ROUTING_POLICY,
  routingConfigSchema,
  skillRouteSchema,
  type TaskContext,
} from './routing-model.js';

type Found = ReturnType<typeof retrieveCandidates> & { stemmed_ids: string[] };
export type RoutingMetadata = {
  skill_id: string;
  name: string;
  description: string;
  active_version_id: string;
  content_digest: string;
};
const lexical = (s: string) => queryTerms(s).terms;
const tokens = (s: string) => new Set(lexical(s));
const hits = (words: string[], text: Set<string>) => words.filter((w) => text.has(w));
export function normalizeTask(context: TaskContext) {
  const summary = queryTerms(context.summary);
  const hintGroups = [
    context.languages,
    context.frameworks,
    context.file_types,
    [context.diagnostic ?? ''],
    [context.intent ?? ''],
    [context.phase ?? ''],
  ].map((a) => [...new Set(a.flatMap(lexical))].sort());
  const hintTerms = [...new Set(hintGroups.flat())];
  const terms = [...new Set([...hintTerms, ...summary.terms])];
  return {
    summary,
    hintGroups,
    hintTerms,
    terms,
    query: terms.join(' '),
    excluded: [...new Set(context.exclude_terms.flatMap(lexical))].sort(),
    key: {
      summary: [...summary.terms].sort(),
      hints: hintGroups,
      excluded: [...new Set(context.exclude_terms.flatMap(lexical))].sort(),
    },
  };
}
/** Extends the existing candidate query and artifact resolver. Never caches an authorization decision. */
export class SkillRouter {
  readonly #config;
  readonly #scope: ProjectScope;
  readonly #cache: RoutingCache<Found>;
  #generation = '';
  constructor(
    private readonly db: Database.Database,
    scope: ProjectScope,
    private readonly candidateLimit: number,
    private readonly resolve: (id: string) => RoutingMetadata,
    config: unknown = {},
  ) {
    const parsed = routingConfigSchema.safeParse(config);
    if (!parsed.success)
      throw new AgentMindError('RETRIEVAL_INVALID_CONFIG', 'Invalid trusted routing limits.');
    this.#config = Object.freeze(parsed.data);
    this.#scope = Object.freeze({ ...scope });
    this.#cache = new RoutingCache(
      this.#config.cache_entries,
      this.#config.cache_bytes,
      this.#config.cache_ttl_ms,
    );
  }
  route(input: unknown) {
    const p = parseRetrieval(skillRouteSchema, input),
      n = normalizeTask(p.context),
      limit = p.limit ?? this.#config.top_k;
    return this.db.transaction(() => {
      // Broad invalidation is intentional: includes evaluation/source/audit changes, not just pointers.
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
            ROUTING_POLICY,
            this.#scope,
            n.key,
            n.query,
            this.#config,
            this.candidateLimit,
            limit,
            generation,
          ]),
        )
        .digest('hex');
      let found = this.#cache.get(key);
      const cacheHit = found !== undefined;
      if (!found) {
        const candidates = retrieveCandidates(this.db, this.#scope, n.query, this.candidateLimit);
        const stemOnly = candidates.rows.filter(
          (row) => scoreRoutingCandidate(row, n).summaryMatches.length === 0,
        );
        let stemmed_ids: string[] = [];
        if (stemOnly.length && n.summary.terms.length) {
          // Preserve complete Porter/Unicode matches while abstaining on isolated topic stems.
          const match = n.summary.terms.map((t) => `"${t}"`).join(' AND ');
          stemmed_ids = (
            this.db
              .prepare(
                `SELECT f.version_id FROM skill_version_retrieval_fts f JOIN skill_versions v ON v.rowid=f.rowid AND v.id=f.version_id AND v.project_id=f.project_id JOIN skills k ON k.id=v.skill_id AND k.project_id=v.project_id AND k.active_version_id=v.id WHERE skill_version_retrieval_fts MATCH ? AND f.project_id=? AND v.project_id=? AND f.name=k.name AND f.description=v.description AND v.id IN (${stemOnly.map(() => '?').join(',')})`,
              )
              .all(match, this.#scope.id, this.#scope.id, ...stemOnly.map((r) => r.version_id)) as {
              version_id: string;
            }[]
          ).map((r) => r.version_id);
        }
        found = { ...candidates, stemmed_ids };
        this.#cache.set(key, found);
      }
      const ranked = rankRoutingCandidates(found.rows, n, new Set(found.stemmed_ids));
      const skills: Array<
        RoutingMetadata & {
          description_truncated: boolean;
          matched: string[];
          hints: string[];
          stemmed_all_task_terms?: boolean;
        }
      > = [];
      let truncated = found.truncated || found.terms_truncated;
      const response = () => {
        const first = skills[0],
          second = skills[1];
        // Never infer semantic certainty. A clipped pool/shortlist cannot establish a unique choice.
        const single =
          !truncated &&
          first &&
          (!second ||
            first.matched.length - second.matched.length >= this.#config.single_min_gap) &&
          (first.name === n.summary.normalized ||
            (n.summary.terms.length >= this.#config.single_min_terms &&
              n.summary.terms.every((t) => first.matched.includes(t))));
        return {
          outcome: skills.length
            ? single
              ? 'RECOMMEND_ONE'
              : 'SHORTLIST'
            : truncated || n.terms.length < 2
              ? 'INSUFFICIENT_CONTEXT'
              : 'NO_MATCH',
          skills,
          selection_required: skills.length > 0,
          truncated,
          continuation: truncated
            ? 'Narrow context/exclusions or ask the operator to increase the routing budget, then select and pin skill_load.'
            : null,
          scope: 'project',
          project_id: this.#scope.id,
          diagnostics: {
            policy: ROUTING_POLICY,
            matching: 'LEXICAL_METADATA_AND_EXPLICIT_HINTS',
            semantic_search: false,
            cache_hit: cacheHit,
            candidate_count: found.rows.length,
            terms_truncated: found.terms_truncated,
            telemetry_recorded: false,
          },
          warning: RETRIEVAL_WARNING,
          untrusted_data: true,
        };
      };
      for (const r of ranked) {
        if (skills.length >= limit) {
          truncated = true;
          break;
        }
        let verified: RoutingMetadata;
        try {
          verified = this.resolve(r.row.skill_id);
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
        // Stale or corrupt index/cache metadata cannot become returned text/ranking evidence.
        if (
          verified.active_version_id !== r.row.version_id ||
          verified.content_digest !== r.row.content_hash ||
          verified.name !== r.row.name ||
          verified.description !== r.row.description
        )
          continue;
        skills.push({
          ...verified,
          description: verified.description.slice(0, this.#config.description_chars),
          description_truncated: verified.description.length > this.#config.description_chars,
          matched: r.matched.slice(0, 12),
          hints: r.hints.slice(0, 6),
          ...(r.summaryMatches.length === 0 ? { stemmed_all_task_terms: true } : {}),
        });
        if (Buffer.byteLength(JSON.stringify(response())) > this.#config.response_bytes) {
          skills.pop();
          truncated = true;
          break;
        }
      }
      // Truncation adds continuation text; include that envelope cost before returning.
      while (
        skills.length &&
        Buffer.byteLength(JSON.stringify(response())) > this.#config.response_bytes
      ) {
        skills.pop();
        truncated = true;
      }
      const result = response();
      if (Buffer.byteLength(JSON.stringify(result)) > this.#config.response_bytes)
        throw new AgentMindError(
          'RETRIEVAL_OUTPUT_LIMIT',
          'Routing metadata exceeds the configured bound.',
        );
      return result;
    })();
  }
}

export function scoreRoutingCandidate(row: RankedCandidate, n: ReturnType<typeof normalizeTask>) {
  const text = tokens(`${row.name} ${row.description}`);
  return {
    row,
    exact: row.name === n.summary.normalized ? 1 : 0,
    hints: hits(n.hintTerms, text),
    matched: hits([...new Set([...n.summary.terms, ...n.hintTerms])], text),
    summaryMatches: hits(n.summary.terms, text),
    excluded: n.excluded.some((t) => text.has(t)),
  };
}

export function rankRoutingCandidates(
  rows: RankedCandidate[],
  n: ReturnType<typeof normalizeTask>,
  stemmedIds: ReadonlySet<string> = new Set(),
) {
  return rows
    .map((row) => scoreRoutingCandidate(row, n))
    .filter((r) => !r.excluded && (r.summaryMatches.length > 0 || stemmedIds.has(r.row.version_id)))
    .sort(
      (a, b) =>
        b.exact - a.exact ||
        b.hints.length - a.hints.length ||
        b.row.name_hits - a.row.name_hits ||
        b.row.description_hits - a.row.description_hits ||
        (a.row.name < b.row.name
          ? -1
          : a.row.name > b.row.name
            ? 1
            : a.row.skill_id.localeCompare(b.row.skill_id)),
    );
}
