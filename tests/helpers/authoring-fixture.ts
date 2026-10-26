import { randomUUID } from 'node:crypto';
import type { PatchOperation } from '../../packages/core/src/authoring/model.js';

type TestDraft = {
  schema_version: number;
  request_id: string;
  context_id: string;
  context_digest: string;
  name: string;
  description: string;
  rationale: string;
  expected_improvement: string;
  known_limitations: string[];
  type: string;
  files?: { path: string; content: string }[];
  operations?: PatchOperation[];
  [key: string]: unknown;
};

import { fileDigest } from '../../packages/core/src/authoring/patch.js';
import { LearningSignalService, SkillAuthoringService } from '../../packages/core/src/index.js';
import { distributionFixture } from './distribution-fixture.js';
import { skillFixture } from './skill-fixture.js';
export function authoringFixture(existing = false) {
  const f = existing ? distributionFixture(true, 'sqlite-startup') : skillFixture();
  let authoringSource = f.approvedSource;
  if (!existing) {
    const e = f.experiences.record({
      problem: 'Shader geometry adjacency drops vertex zero from shared mesh edges',
      solution:
        'Preserve numeric vertex index zero and filter only null references when rebuilding mesh adjacency.',
      outcome: {
        status: 'unknown',
        summary: 'Synthetic reviewed fixture; no independent task-success claim.',
      },
    }).experience;
    authoringSource = f.experiences.review({
      id: e.id,
      decision: 'approved',
      expected_updated_at: e.updated_at,
      reviewer: 'synthetic fixture reviewer',
      reason: 'Disposable source approval fixture, not real human evidence.',
    });
  }
  const learning = new LearningSignalService(f.db, f.scope, 'codex');
  const signal = learning.record({
    schema_version: 1,
    type: 'NEW_PATTERN',
    title: existing ? 'SQLite startup guardrail' : 'Shader geometry adjacency',
    summary: existing
      ? 'A reusable startup guardrail should inspect bounded retry exhaustion before reconnecting to SQLite and reporting success.'
      : 'A reusable geometry adjacency contract should preserve shared mesh edges when computing curved surface tessellation across rendering passes.',
    reusability: 'potentially_reusable',
    experience_ids: [authoringSource.id],
    supporting_evidence: [
      {
        kind: 'test',
        reference: 'controlled-test-fixture',
        summary: 'Unverified reference; no code is executed.',
      },
    ],
  });
  if (!('id' in signal)) throw Error('fixture signal ignored');
  const service = new SkillAuthoringService(f.db, f.scope, 'codex');
  const base = existing
    ? f.store.getIdentity((f as ReturnType<typeof distributionFixture>).candidate.identity.id)
        .active_version_id
    : null;
  const contextRequest = {
    signal_ids: [signal.id],
    experience_ids: [authoringSource.id],
    query: existing ? 'sqlite startup' : 'shader geometry adjacency',
    ...(base ? { target_version_id: base } : {}),
  };
  const context = service.context(contextRequest);
  const draft = (patch: Record<string, unknown> = {}): TestDraft => ({
    schema_version: 1,
    request_id: randomUUID(),
    context_id: context.id,
    context_digest: context.context_digest,
    name: 'shader-adjacency',
    description: 'Use shared mesh adjacency before recalculating curved surface tessellation.',
    rationale:
      'The recorded reusable geometry lesson should be available for separately reviewed future rendering tasks.',
    expected_improvement: 'Explicit edge adjacency checks may reduce missed shared-boundary cases.',
    known_limitations: ['Agent-authored; static checks do not verify behavior.'],
    type: 'CREATE_NEW',
    files: [
      {
        path: 'SKILL.md',
        content:
          '---\nname: shader-adjacency\ndescription: Use shared mesh adjacency before recalculating curved surface tessellation.\n---\n# Goal\nPreserve common mesh boundaries.\n# When to use\nWhen recalculating adjacent curved surfaces.\n# Procedure\nPreserve vertex index zero and filter only null references before recalculating shared mesh adjacency.\n# Verification\nCheck boundary continuity and document unresolved cases.\n',
      },
    ],
    ...patch,
  });
  const patch = () => {
    if (!base) throw Error('no base');
    const b = f.store.getVersion(base);
    const md = b.version.files.find((f) => f.path === 'SKILL.md');
    if (!md) throw Error('no markdown');
    const request = draft({
      type: 'PATCH_EXISTING',
      name: 'sqlite-startup',
      description: b.version.description,
      target_skill_id: b.version.skill_id,
      target_version_id: base,
      expected_base_digest: b.version.content_hash,
      operations: [
        {
          op: 'replace',
          path: 'SKILL.md',
          expected_file_digest: fileDigest(md.content),
          old_text: 'Report the marker AGENTMIND_DISTRIBUTION_DEMO and observed version.',
          new_text:
            'Check bounded retry exhaustion, then report the marker AGENTMIND_DISTRIBUTION_DEMO and observed version.',
        },
      ],
    });
    delete request.files;
    return request;
  };
  return {
    ...f,
    approvedSource: authoringSource,
    learning,
    signal,
    service,
    base,
    contextRequest,
    context,
    draft,
    patch,
  };
}
