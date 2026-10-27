// Explicit administrator-run acceptance, never an installer. No account/daemon/live-registry mutation.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { rootOwnedPath, validateBrokerConfig, verifyPaths } from '../packages/core/dist/index.js';

const { values } = parseArgs({
  options: {
    'runtime-root': { type: 'string' },
    'authorize-disposable-os-tests': { type: 'boolean' },
    'test-parent': { type: 'string' },
    'broker-uid': { type: 'string' },
    'operator-uid': { type: 'string' },
    'agent-uid': { type: 'string' },
    'other-agent-uid': { type: 'string' },
    'operator-gid': { type: 'string' },
    'project-gid': { type: 'string' },
    'other-project-gid': { type: 'string' },
  },
  strict: true,
  allowPositionals: false,
});
if (
  !values['authorize-disposable-os-tests'] ||
  process.platform !== 'darwin' ||
  process.getuid?.() !== 0
) {
  console.log(
    JSON.stringify({
      overall: 'NOT VERIFIED',
      reason:
        'Requires explicit --authorize-disposable-os-tests and an administrator-run macOS session with existing dedicated identities and protected runtime. No changes performed.',
    }),
  );
  process.exit(2);
}
process.umask(0o022);
const number = (name) => {
  const n = Number(values[name]);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`Invalid ${name}`);
  return n;
};
const broker = number('broker-uid'),
  operator = number('operator-uid'),
  agent = number('agent-uid'),
  other = number('other-agent-uid');
const opgid = number('operator-gid'),
  gid = number('project-gid'),
  othergid = number('other-project-gid');
const runtime = realpathSync(values['runtime-root'] ?? '');
const parent = realpathSync(values['test-parent'] ?? '');
if (
  realpathSync(process.execPath) !== join(runtime, 'bin/node') ||
  !realpathSync(import.meta.filename).startsWith(`${runtime}/`)
)
  throw new Error('Use the administrator-installed runtime and harness.');
// Check every ancestor before the first privileged mkdir/chown. Checking only
// test-parent's leaf would permit replacement through an attacker-writable parent.
const protectedInputs = [
  runtime,
  parent,
  process.execPath,
  import.meta.filename,
  join(runtime, 'native/bin/agentmind-peer'),
];
const inspected = [];
for (const path of protectedInputs) {
  if (/[\r\n\0]/.test(path)) throw new Error('Invalid protected path');
  rootOwnedPath(path);
  for (let ancestor = path; ; ancestor = dirname(ancestor)) {
    inspected.push(ancestor);
    if (ancestor === dirname(ancestor)) break;
  }
}
verifyPaths(join(runtime, 'native/bin/agentmind-peer'), [...new Set(inspected)]);
const pstat = lstatSync(parent);
if (!pstat.isDirectory() || pstat.uid !== 0 || pstat.mode & 0o022)
  throw new Error('Test parent must already be root-owned and non-writable by service identities.');
const account = (id) => {
  const r = spawnSync('/usr/bin/id', ['-G', String(id)], { encoding: 'utf8', env: {} });
  if (r.status !== 0) throw new Error('Existing OS account required.');
  return r.stdout.trim().split(/\s+/).map(Number);
};
const primary = (id) => {
  const r = spawnSync('/usr/bin/id', ['-g', String(id)], { encoding: 'utf8', env: {} });
  if (r.status !== 0) throw new Error('Invalid account');
  return Number(r.stdout.trim());
};
for (const id of [broker, operator, agent, other]) account(id);
const root = mkdtempSync(join(parent, 'agentmind-sec01-os-'));
chmodSync(root, 0o711);
const results = [];
const workerEvidence = [];
let server;
let passed = false;
const workspaces = [];
const folder = (name, uid, gid, mode) => {
  const path = join(root, name);
  mkdirSync(path);
  chownSync(path, uid, gid);
  chmodSync(path, mode);
  return path;
};
const drop = (id) =>
  `process.setgroups(${JSON.stringify(account(id))});process.setgid(${primary(id)});process.setuid(${id});`;
const worker = join(runtime, 'tests/os/broker-os-worker.mjs');
const job = (uid, input) => {
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `${drop(uid)}await import(${JSON.stringify(worker)});`],
    {
      input: JSON.stringify(input),
      encoding: 'utf8',
      timeout: 25000,
      maxBuffer: 1048576,
      env: {},
      cwd: runtime,
    },
  );
  if (child.status !== 0) throw new Error('Isolated OS worker failed.');
  const result = JSON.parse(child.stdout);
  if (result.executing_uid !== uid || result.executing_euid !== uid)
    throw new Error('Worker OS identity mismatch');
  workerEvidence.push({
    uid: result.executing_uid,
    euid: result.executing_euid,
    kind: result.operation,
    target: input.path?.split('/').pop() ?? input.request?.op ?? null,
    rejection_layer: result.rejection_layer ?? null,
    error_code: result.error_code ?? null,
    denied: result.denied ?? null,
    rpc_ok: result.ok ?? null,
  });
  return result;
};
const assert = (name, value) => {
  const osDenial =
    /write denied|replacement.*denied|content write denied|read denied|unreadable|connect denied by OS|creation denied by OS/.test(
      name,
    );
  results.push({
    name,
    status: value ? 'PASS' : 'FAIL',
    layer: osDenial ? 'C_OS_PERMISSION' : 'B_OS_PRINCIPALS_WITH_APPLICATION_CHECK',
    scenario_principals: { broker, operator, agent, other },
    identity_evidence:
      'Exact invoking UID/EUID and OS/application rejection category are recorded per call in worker_evidence.',
    expected: 'Specified assertion holds',
    actual: value ? 'Assertion observed' : 'Assertion failed',
    verification_scope: 'DISPOSABLE_ONLY; not actual human presence or live deployment',
  });
  if (!value) throw new Error(`Assertion failed: ${name}`);
};
let client;
const rpc = (uid, channel, op, input = {}, project = undefined) =>
  job(uid, {
    kind: 'rpc',
    client,
    channel,
    request: { schema_version: 1, op, input, ...(project ? { project } : {}) },
  });
const approved = (input) => {
  const p = rpc(operator, 'operator', 'operator_prepare', input, 'a');
  if (!p.ok) throw new Error('Operator prepare denied');
  if ('confirmation' in p.result) throw new Error('Unexpected returned confirmation credential');
  const result = rpc(
    operator,
    'operator',
    'operator_commit',
    { challenge_id: p.result.challenge_id, review_digest: p.result.digest },
    'a',
  );
  if (!result.ok) throw new Error('Operator commit denied');
  return result.result;
};
const start = async (config) => {
  server = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `${drop(broker)}process.argv=[process.execPath,${JSON.stringify(join(runtime, 'packages/mcp-server/dist/broker.js'))},'--config',${JSON.stringify(config)}];await import(${JSON.stringify(join(runtime, 'packages/mcp-server/dist/broker.js'))});`,
    ],
    { env: {}, cwd: runtime, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let ready = 0;
  server.stderr.on('data', (b) => {
    ready += (String(b).match(/BROKER_(AGENT|OPERATOR)_READY/g) ?? []).length;
  });
  for (let i = 0; i < 100 && ready < 2; i++) {
    if (server.exitCode !== null) throw new Error('Protected broker startup failed.');
    await delay(100);
  }
  if (ready !== 2) throw new Error('Protected broker readiness timeout');
};
try {
  const data = folder('data', broker, primary(broker), 0o700);
  const sockets = folder('run', broker, primary(broker), 0o711);
  const projects = [
    ['a', agent, gid],
    ['b', other, othergid],
  ].map(([name, uid, group]) => {
    const publication = folder(`publication-${name}`, broker, group, 0o750);
    const work = join(publication, 'workspace');
    mkdirSync(work);
    chownSync(work, uid, group);
    chmodSync(work, 0o750);
    workspaces.push(work);
    return {
      name,
      root: work,
      project_key: `sec01-disposable-${name}`,
      distribution_home: publication,
      distribution: 'protected',
      publication: { root: publication, gid: group },
    };
  });
  const config = join(root, 'broker.json');
  writeFileSync(
    config,
    JSON.stringify(
      validateBrokerConfig({
        schema_version: 1,
        deployment_id: randomUUID(),
        broker_uid: broker,
        operator_gid: opgid,
        runtime_root: runtime,
        registry_directory: data,
        socket_directory: sockets,
        projects,
        agents: [
          { uid: agent, project: 'a', source: 'codex' },
          { uid: other, project: 'b', source: 'claude' },
        ],
        operators: [{ uid: operator, projects: ['a'] }],
      }),
    ),
    { mode: 0o644 },
  );
  client = join(root, 'client.json');
  writeFileSync(
    client,
    JSON.stringify({
      schema_version: 1,
      broker_uid: broker,
      helper: join(runtime, 'native/bin/agentmind-peer'),
      socket_directory: sockets,
    }),
    { mode: 0o644 },
  );
  const invalid = join(root, 'same-uid.json');
  const invalidConfig = JSON.parse(readFileSync(config, 'utf8'));
  invalidConfig.agents[0].uid = operator;
  writeFileSync(invalid, JSON.stringify(invalidConfig), { mode: 0o644 });
  const rejected = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `${drop(broker)}process.argv=[process.execPath,${JSON.stringify(join(runtime, 'packages/mcp-server/dist/broker.js'))},'--config',${JSON.stringify(invalid)}];await import(${JSON.stringify(join(runtime, 'packages/mcp-server/dist/broker.js'))});`,
    ],
    { env: {}, cwd: runtime, encoding: 'utf8', timeout: 5000, maxBuffer: 8192 },
  );
  assert(
    'same-UID deployment fails closed without a protected-ready label',
    rejected.status === 1 &&
      rejected.stderr.includes('PROTECTED_BROKER_STARTUP_DENIED') &&
      !rejected.stderr.includes('_READY'),
  );
  await start(config);
  const health = rpc(agent, 'agent', 'broker_health');
  assert(
    'kernel-authenticated agent and non-root broker identities',
    health.ok && health.result.peer_uid === agent && health.result.broker_uid === broker,
  );
  for (const path of [
    join(data, 'registry.db'),
    join(data, 'registry.db-wal'),
    join(data, 'registry.db-shm'),
    config,
    join(runtime, 'native/bin/agentmind-peer'),
  ])
    assert(
      `agent write denied: ${path.includes('registry.db') ? path.slice(path.lastIndexOf('/') + 1) : path === config ? 'configuration' : 'helper'}`,
      job(agent, { kind: 'deny-write', path }).denied,
    );
  assert(
    'private authorization state unreadable by agent',
    job(agent, { kind: 'deny-read', path: join(data, 'registry.db') }).denied,
  );
  assert(
    'operator socket connect denied by OS',
    job(agent, { kind: 'deny-connect', path: join(sockets, 'operator/operator.sock') }).denied,
  );
  for (const [name, path] of [
    ['registry parent replacement', data],
    ['broker configuration replacement', config],
    ['broker executable replacement', join(runtime, 'packages/mcp-server/dist/broker.js')],
    ['helper replacement', join(runtime, 'native/bin/agentmind-peer')],
  ])
    assert(`${name} denied`, job(agent, { kind: 'deny-replace', path }).denied);
  assert(
    'journal path creation denied by OS',
    job(agent, { kind: 'deny-symlink', path: join(data, 'registry.db-journal') }).denied,
  );

  assert(
    'privileged distribution denied to agent',
    !rpc(agent, 'agent', 'distribution_plan', { target: 'all' }).ok,
  );
  assert(
    'unauthorized rollback denied',
    !rpc(agent, 'agent', 'operator_prepare', {
      kind: 'skill',
      request: { action: 'rollback', version_id: '00000000-0000-4000-8000-000000000000' },
    }).ok,
  );
  assert(
    'forged peer metadata denied',
    !job(agent, {
      kind: 'rpc',
      client,
      channel: 'agent',
      request: { schema_version: 1, op: 'operator_commit', uid: operator, input: {} },
    }).ok,
  );
  const e = rpc(agent, 'agent', 'experience_record', {
    problem: 'Clamp lower bound',
    solution: 'Apply both bounds',
    outcome: { status: 'succeeded', summary: 'Disposable OS fixture, not real CLI use' },
  }).result.experience;
  approved({
    kind: 'experience',
    request: {
      id: e.id,
      decision: 'approved',
      expected_updated_at: e.updated_at,
      reason: 'Isolated OS authorization fixture',
    },
  });
  const skill = rpc(agent, 'agent', 'skill_propose', {
    name: 'sec01-harmless',
    description: 'Harmless clamp guidance',
    source_experience_ids: [e.id],
    files: [
      {
        path: 'SKILL.md',
        content:
          '---\nname: sec01-harmless\ndescription: Harmless clamp guidance\n---\n# Goal\nClamp a number.\n# When to use\nBounded arithmetic.\n# Procedure\nApply both bounds.\n# Verification\nCheck edge cases.\n',
      },
    ],
  }).result;
  assert(
    'evaluation persists',
    rpc(agent, 'agent', 'skill_evaluate', {
      version_id: skill.version.id,
      expected_content_hash: skill.version.content_hash,
      expected_state_revision: skill.state.revision,
    }).ok,
  );
  const review = rpc(
    operator,
    'operator',
    'operator_prepare',
    { kind: 'skill', request: { action: 'approve', version_id: skill.version.id } },
    'a',
  ).result;
  assert('no confirmation credential returned', !('confirmation' in review));
  assert(
    'public review ticket cannot authorize agent',
    !rpc(agent, 'agent', 'operator_commit', {
      challenge_id: review.challenge_id,
      review_digest: review.digest,
    }).ok,
  );
  const requestFile = join(root, 'approval.json');
  writeFileSync(
    requestFile,
    JSON.stringify({ kind: 'skill', request: { action: 'approve', version_id: skill.version.id } }),
    { mode: 0o644 },
  );
  assert(
    'agent-controlled PTY cannot approve',
    job(agent, {
      kind: 'pty',
      client,
      operator: join(runtime, 'packages/mcp-server/dist/broker-operator.js'),
      requestFile,
    }).denied,
  );
  assert(
    'candidate unchanged by agent attacks',
    rpc(agent, 'agent', 'skill_get', { version_id: skill.version.id }).result.state.status ===
      'candidate',
  );
  assert(
    'operator approval accepted',
    rpc(
      operator,
      'operator',
      'operator_commit',
      { challenge_id: review.challenge_id, review_digest: review.digest },
      'a',
    ).ok,
  );
  assert(
    'approval replay denied',
    !rpc(
      operator,
      'operator',
      'operator_commit',
      { challenge_id: review.challenge_id, review_digest: review.digest },
      'a',
    ).ok,
  );
  approved({ kind: 'skill', request: { action: 'promote', version_id: skill.version.id } });
  approved({
    kind: 'distribution',
    request: { skill_id: skill.identity.id, target: 'all', scope: 'project' },
  });
  for (const target of ['.agents', '.claude']) {
    const path = join(projects[0].publication.root, target, 'skills', 'sec01-harmless', 'SKILL.md');
    assert(
      `${target} approved bytes readable`,
      job(agent, { kind: 'read-copy', path }).text === skill.version.files[0].content,
    );
    assert(`${target} content write denied`, job(agent, { kind: 'deny-write', path }).denied);
    assert(`${target} replacement denied`, job(agent, { kind: 'deny-replace', path }).denied);
    assert(`${target} other project read denied`, job(other, { kind: 'deny-read', path }).denied);
  }
  assert(
    'cross-project registry reads denied',
    !rpc(other, 'agent', 'skill_get', { version_id: skill.version.id }).ok,
  );
  const plan = rpc(
    operator,
    'operator',
    'distribution_plan',
    { skill_id: skill.identity.id, target: 'all', scope: 'project' },
    'a',
  );
  assert(
    'reconciliation idempotent',
    plan.ok && plan.result.entries.every((e) => e.action === 'SKIP'),
  );
  const old = server;
  old.kill('SIGKILL');
  await new Promise((resolve) => old.once('exit', resolve));
  await delay(500);
  await start(config);
  assert(
    'crash restart preserves approval and active pointer',
    rpc(agent, 'agent', 'skill_get', { name: 'sec01-harmless' }).result.version.id ===
      skill.version.id,
  );
  approved({ kind: 'skill', request: { action: 'deactivate', version_id: skill.version.id } });
  approved({ kind: 'skill', request: { action: 'rollback', version_id: skill.version.id } });
  assert(
    'authorized rollback persists',
    rpc(agent, 'agent', 'skill_get', { name: 'sec01-harmless' }).result.version.id ===
      skill.version.id,
  );
  passed = true;
  console.log(
    JSON.stringify({
      overall: 'DISPOSABLE_OS_ACCEPTANCE_PASSED',
      deployment_verification: 'NOT_VERIFIED',
      disposable: true,
      actual_human_presence: 'NOT VERIFIED (isolated operator-process fixtures)',
      native_cli_discovery: 'NOT VERIFIED',
      deployed_on_actual_host: false,
      results,
      worker_evidence: workerEvidence,
    }),
  );
} catch {
  console.log(
    JSON.stringify({
      overall: 'FAIL',
      reason: 'Disposable verification failed; administrator inspection required.',
      results,
      worker_evidence: workerEvidence,
    }),
  );
  process.exitCode = 1;
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => server.once('exit', resolve)), delay(3000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  // Never recursively clean agent-owned workspace contents as root. Empty directories only.
  if (passed && resolve(root).startsWith(`${parent}/agentmind-sec01-os-`)) {
    try {
      for (const workspace of workspaces) rmdirSync(workspace);
      rmSync(root, { recursive: true, force: false });
    } catch {
      console.error(
        JSON.stringify({ cleanup: 'REQUIRES ADMINISTRATOR INSPECTION', fixture: root }),
      );
      process.exitCode = 1;
    }
  } else
    console.error(
      JSON.stringify({ cleanup: 'RETAINED FOR ADMINISTRATOR INSPECTION', fixture: root }),
    );
}
