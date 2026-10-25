import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type Database from 'better-sqlite3';
import {
  type Experience,
  openDatabase,
  type ProjectScope,
  resolveProject,
  type SkillEvaluationService,
  type SkillProposalService,
  SkillStore,
} from '../../packages/core/src/index.js';
import {
  cleanupLearningFixture,
  createLearningFixture,
  loadLearningFixture,
  runLearningTest,
  skillFixtureFiles,
} from '../../scripts/learning-fixture.mjs';
import { operatorTTY } from './operator-pty.js';

type Reply = Awaited<ReturnType<typeof operatorTTY>['exit']>;
type Proposal = ReturnType<SkillProposalService['propose']>;
export type LearningE2E = {
  fixture: ReturnType<typeof createLearningFixture>;
  root: string;
  path: string;
  home: string;
  db: Database.Database;
  scope: ProjectScope;
  store: SkillStore;
  connect: (agent: 'codex' | 'claude', other?: boolean) => Promise<Client>;
  close: (client: Client) => Promise<void>;
  call: (
    client: Client,
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<ReturnType<typeof JSON.parse>>;
  command: (script: string, args: string[], respond?: boolean) => Promise<Reply>;
  prompt: (script: string, args: string[], entry?: string) => ReturnType<typeof operatorTTY>;
  operator: (action: string, version: string) => Promise<Reply>;
  sync: (skill: string, target?: string, remove?: boolean) => Promise<Reply>;
  capture: () => Promise<Experience>;
  approveExperience: (experience: Pick<Experience, 'id' | 'updated_at'>) => Promise<Reply>;
  propose: (source: string, revision?: number) => Promise<Proposal>;
  evaluate: (version: string) => Promise<ReturnType<SkillEvaluationService['evaluate']>>;
  approved: () => Promise<{ experience: Experience; candidate: Proposal }>;
  test: (fixed?: boolean) => ReturnType<typeof runLearningTest>;
  event: () => string;
  cleanup: () => Promise<void>;
};
export async function learningE2E(): Promise<LearningE2E> {
  const fixture = createLearningFixture();
  const root = fixture.root;
  const path = join(root, 'registry.db');
  const home = join(root, 'fake-home');
  const db: Database.Database = openDatabase(path);
  const scope = resolveProject(root, root);
  const clients = new Set<Client>();
  async function connect(agent: 'codex' | 'claude', other = false) {
    const client = new Client({ name: `SIMULATED-${agent}-e2e`, version: '1' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        cwd: other ? join(root, 'other-project') : root,
        stderr: 'pipe',
        args: [
          resolve('packages/mcp-server/dist/index.js'),
          '--project-root',
          other ? join(root, 'other-project') : root,
          '--db',
          path,
          '--source-agent',
          agent,
        ],
      }),
    );
    clients.add(client);
    return client;
  }
  async function close(client: Client) {
    await client.close();
    clients.delete(client);
  }
  async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    const reply = await client.callTool({ name, arguments: args });
    const content = reply.content as Array<{ type: string; text: string }>;
    if (reply.isError) throw new Error(`MCP ${name}: ${content[0]?.text}`);
    return JSON.parse(content[0]?.text ?? 'null');
  }
  function prompt(
    script: string,
    args: string[],
    entry = resolve(`packages/mcp-server/dist/${script}.js`),
  ) {
    // Explicit automated TEST-ONLY terminal driver, never imported by the real CLI verifier.
    loadLearningFixture(root);
    return operatorTTY(root, ['--project-root', root, '--db', path, ...args], entry);
  }
  async function command(script: string, args: string[], respond = true) {
    const p = prompt(script, args);
    const ready = await p.ready;
    if (ready.event === 'ready' && respond) p.respond();
    return p.exit;
  }
  async function operator(action: string, version: string) {
    return command('skill-operator', [
      `--${action}`,
      version,
      '--reason',
      'AUTOMATED DISPOSABLE E2E TEST ONLY; not human consent.',
    ]);
  }
  async function sync(skill: string, target = 'all', remove = false) {
    return command('skill-distribute', [
      '--home-root',
      home,
      '--skill-id',
      skill,
      '--target',
      target,
      '--scope',
      'project',
      remove ? '--remove' : '--sync',
    ]);
  }
  async function capture() {
    const codex = await connect('codex');
    const result = await call(codex, 'experience_record', {
      problem: 'Clamp regression: a negative input ignores the lower bound',
      solution: 'Bound below with Math.max before bounding above with Math.min',
      outcome: {
        status: 'succeeded',
        summary:
          'Only the deterministic lower/upper/zero/in-range fixture passed; broader behavior is not verified.',
      },
      evidence: [
        {
          kind: 'test',
          reference: 'clamp.test.mjs',
          summary: 'Code-owned disposable fixture; actual test run is verified separately.',
        },
      ],
      provenance: { task_ref: 'p2-008-clamp' },
    });
    await close(codex);
    return result.experience;
  }
  async function approveExperience(experience: { id: string; updated_at: string }) {
    return command('review', [
      '--id',
      experience.id,
      '--decision',
      'approved',
      '--expected-updated-at',
      experience.updated_at,
      '--reviewer',
      'AUTOMATED E2E TEST FIXTURE',
      '--reason',
      'Disposable fixture tests only; not native human acceptance.',
    ]);
  }
  async function propose(source: string, revision = 1) {
    const client = await connect('codex');
    try {
      return await call(client, 'skill_propose', {
        name: fixture.name,
        description: 'Check lower and upper bounds in a numeric clamp utility',
        source_experience_ids: [source],
        files: skillFixtureFiles(fixture, revision),
        expected_latest_version: revision - 1,
      });
    } finally {
      await close(client);
    }
  }
  async function evaluate(version: string) {
    const r = new SkillStore(db, scope).getVersion(version);
    const reply = await command('skill-evaluate', [
      '--version-id',
      version,
      '--expected-content-hash',
      r.version.content_hash,
      '--expected-state-revision',
      String(r.state.revision),
    ]);
    if (reply.status !== 0) throw new Error(reply.output.slice(-1000));
    return JSON.parse(reply.output.trim());
  }
  async function approved() {
    const experience = await capture();
    const review = await approveExperience(experience);
    if (review.status !== 0) throw new Error('Test experience review failed');
    const candidate = await propose(experience.id);
    await evaluate(candidate.version.id);
    for (const action of ['approve', 'promote']) {
      const reply = await operator(action, candidate.version.id);
      if (reply.status !== 0) throw new Error(reply.output.slice(-1000));
    }
    return { experience, candidate };
  }
  return {
    fixture,
    root,
    path,
    home,
    db,
    scope,
    store: new SkillStore(db, scope),
    connect,
    close,
    call,
    command,
    prompt,
    operator,
    sync,
    capture,
    approveExperience,
    propose,
    evaluate,
    approved,
    test: (fixed = false) => runLearningTest(root, fixed),
    event: () => randomUUID(),
    cleanup: async () => {
      for (const client of clients) await client.close();
      if (db.open) db.close();
      cleanupLearningFixture(root);
    },
  };
}
