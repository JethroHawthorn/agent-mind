/** Code-owned acceptance policy. Untrusted logs never select profiles or verification layers. */
export const POLICY = 'p6-001-offline-acceptance-v1';
const scenario = (
  id,
  requirement,
  files,
  boundary,
  classification = 'HOST_OBSERVED_OFFLINE_TESTS',
) => ({ id, profile: 'A', requirement, files, boundary, classification });
export const SCENARIOS = [
  scenario(
    'P6-A-FIXTURE',
    'Disposable setup, ownership, idempotence, doctor and safe uninstall; provider contract doubles, not clean host provisioning.',
    ['tests/unit/installer.test.ts', 'tests/integration/installer.test.ts'],
    'managed configuration / fixture homes',
    'CONTRACT_DOUBLES_AND_REAL_MCP',
  ),
  scenario(
    'P6-B-MEMORY',
    'Authorized shared memory over independent SDK/server processes and three adapter fixtures; restart persistence.',
    [
      'tests/integration/mcp.test.ts',
      'tests/integration/codex-daily.test.ts',
      'tests/integration/claude-daily.test.ts',
      'tests/integration/gemini-daily.test.ts',
    ],
    'trusted startup project / shared SQLite',
    'GENERIC_MCP_AND_ADAPTER_FIXTURES',
  ),
  scenario(
    'P6-C-EXPERIENCE',
    'Structured successful/unsuccessful experience claims, provenance and cross-client visibility without verified-outcome fabrication.',
    ['tests/integration/experience-mcp.test.ts', 'tests/unit/experience.test.ts'],
    'project evidence / reported versus verified',
  ),
  scenario(
    'P6-D-LEARNING',
    'Experience-linked signals, matching, deduplication and immutable CREATE_NEW/PATCH_EXISTING/REWRITE_EXISTING proposals.',
    [
      'tests/integration/continuous-learning.test.ts',
      'tests/unit/authoring.test.ts',
      'tests/integration/authoring.test.ts',
    ],
    'untrusted candidates / immutable versions',
    'SCRIPTED_LEARNING_WITH_FIXTURE_APPROVAL',
  ),
  scenario(
    'P6-E-DISCOVERY',
    'Fixed labeled retrieval, negative applicability, ambiguity, no-match and large catalog budgets; no model selection claim.',
    [
      'tests/unit/routing-quality.test.ts',
      'tests/unit/hybrid.test.ts',
      'tests/unit/hybrid-selection.test.ts',
      'tests/performance/hybrid-scale.test.ts',
      'tests/acceptance/release-workflow.test.ts',
    ],
    'approved-active scope / bounded cards',
  ),
  scenario(
    'P6-G-REVIEW',
    'Inbox/diff/evidence/evaluation and advisory defer/dismiss; stale decisions cannot activate a version.',
    [
      'tests/unit/learning-review.test.ts',
      'tests/integration/learning-review.test.ts',
      'tests/integration/privacy-boundaries.test.ts',
    ],
    'advisory review versus privileged approval',
  ),
  scenario(
    'P6-H-REFUSAL',
    'Static evaluation and exact candidate/suite/policy bindings; unavailable backend refuses execution and verified PASS.',
    [
      'tests/unit/behavioral.test.ts',
      'tests/unit/behavioral-no-execution.test.ts',
      'tests/unit/sandbox-assurance.test.ts',
      'tests/integration/behavioral.test.ts',
      'tests/integration/sandbox-evaluation.test.ts',
    ],
    'evaluation authority / no host fallback',
  ),
  scenario(
    'P6-I-APP',
    'Broker application peer/grant/replay tests; not actual OS-separated human authorization.',
    [
      'tests/unit/broker.test.ts',
      'tests/unit/broker-publication.test.ts',
      'tests/unit/protected-runner.test.ts',
    ],
    'allowlists / exact grant / fixture principals',
    'SIMULATED_PEERS_APPLICATION_POLICY',
  ),
  scenario(
    'P6-J-FIXTURE',
    'Experience-derived scripted loop and seeded approved-version transfer; independent code-owned task assertions.',
    [
      'tests/integration/continuous-learning.test.ts',
      'tests/integration/retrieval.test.ts',
      'tests/acceptance/release-workflow.test.ts',
    ],
    'fixture publication / reusable instruction identity',
    'SCRIPTED_TASK_AND_SEEDED_TRANSFER_NOT_NATIVE_LEARNING',
  ),
  scenario(
    'P6-K-DISTRIBUTION',
    'Exact-package staged publication, rollback/revocation and fault recovery under synthetic fixture authorization.',
    [
      'tests/integration/skill-distribution.test.ts',
      'tests/integration/distribution-reliability.test.ts',
      'tests/unit/distribution-reliability.test.ts',
      'tests/unit/distribution-broker-review.test.ts',
    ],
    'owned destinations / journal / approval bindings',
    'HOST_OBSERVED_FIXTURE_APPROVAL',
  ),
  scenario(
    'P6-L-DATABASE',
    'Historical migration, real concurrent processes, FTS, WAL backup/offline restore, corruption and process-kill recovery.',
    [
      'tests/unit/database-reliability.test.ts',
      'tests/integration/database-reliability.test.ts',
      'tests/integration/database-cli.test.ts',
      'tests/unit/gemini-migration.test.ts',
    ],
    'SQLite / inline packages / offline restore',
  ),
  scenario(
    'P6-M-ISOLATION',
    'Two-project memory, experience, signal, proposal, resources, review and scope-filtered output isolation.',
    [
      'tests/integration/privacy-boundaries.test.ts',
      'tests/unit/retrieval.test.ts',
      'tests/unit/skill-usage.test.ts',
      'tests/unit/learning-review.test.ts',
    ],
    'trusted service scope / no caller project override',
  ),
  scenario(
    'P6-N-SECURITY',
    'Direct forbidden MCP calls, forged authority, unsafe paths, redaction, protected ordinary-writer refusal and stale cache.',
    [
      'tests/unit/privacy-hardening.test.ts',
      'tests/integration/privacy-boundaries.test.ts',
      'tests/unit/distribution-broker-review.test.ts',
    ],
    'agent tools versus operator / privacy',
  ),
  scenario(
    'P6-O-RECOVERY',
    'Interrupted candidate/review/distribution/DB workflows preserve evidence and never invent approval; process crashes are not power loss.',
    [
      'tests/integration/learning-e2e.test.ts',
      'tests/integration/database-reliability.test.ts',
      'tests/integration/distribution-reliability.test.ts',
      'tests/unit/learning-review.test.ts',
    ],
    'transaction / journal / exact retry authorization',
  ),
  {
    ...scenario(
      'P6-P-DAILY',
      'Terminal and JSON daily workflows, safe ownership-preserving removal and honest unavailable-state guidance.',
      ['tests/integration/daily-workflow.test.ts', 'tests/integration/installer.test.ts'],
      'supervised user workflow / explicit consent',
    ),
    profile: 'C',
  },
];
export const UNAVAILABLE = [
  {
    id: 'P6-A-CLEAN-HOST',
    profile: 'A',
    requirement:
      'Install/build/test on a newly provisioned supported host with independently obtained dependencies.',
    reason:
      'Existing development checkout/dependencies; disposable setup is not clean-machine provisioning.',
  },
  {
    id: 'P6-F-CODEX',
    profile: 'B',
    requirement: 'Native Codex discovers/selects/retrieves/applies skills and captures learning.',
    reason: 'USER_AUTHORIZED_OFFLINE_AND_VERSION_CHECKS_ONLY',
  },
  {
    id: 'P6-F-CLAUDE',
    profile: 'B',
    requirement: 'Native Claude discovers/selects/retrieves/applies skills and captures learning.',
    reason: 'USER_AUTHORIZED_OFFLINE_AND_VERSION_CHECKS_ONLY',
  },
  {
    id: 'P6-F-GEMINI',
    profile: 'B',
    requirement:
      'Native Gemini discovers/activates/retrieves/applies skills and captures learning.',
    reason: 'USER_AUTHORIZED_OFFLINE_AND_VERSION_CHECKS_ONLY',
  },
  {
    id: 'P6-I-OS',
    profile: 'D',
    requirement:
      'Actual isolated runner/operator, protected storage, human authorization and OS denial.',
    reason: 'NO_AUTHORIZED_PROVISIONED_MULTI_UID_DEPLOYMENT',
  },
  {
    id: 'P6-H-SANDBOX',
    profile: 'E',
    requirement:
      'Actual verified sandbox behavioral PASS/FAIL, timeouts/resources/cancellation and protected evidence.',
    reason: 'NO_QUALIFIED_EXECUTION_BACKEND; REFUSAL_ONLY',
  },
  {
    id: 'P6-J-NATIVE',
    profile: 'F',
    requirement:
      'Real native source-agent authorship, trusted approval/evaluation and independently tested receiving-agent application in every direction.',
    reason: 'NATIVE_MODEL_AND_PROTECTED_OS_SANDBOX_GATES_UNVERIFIED',
  },
  {
    id: 'P6-O-PROTECTED',
    profile: 'F',
    requirement:
      'Interrupted real protected promotion/rollback/evaluation and live recovery under distinct principals.',
    reason: 'REAL_DEPLOYMENT_UNAVAILABLE; FIXTURE_RECOVERY_IS_SEPARATE',
  },
];
export const suiteFiles = () => [...new Set(SCENARIOS.flatMap((s) => s.files))].sort();
export function normalizeStatus(status) {
  return status === 'NOT_VERIFIED' ? 'NOT VERIFIED' : status;
}
/** Require a successful observed process AND complete trusted test-runner assertions.
 * Test logs/fixture payloads cannot supply profile/authority or override an exit failure.
 */
export function classifySuite(report, exitCode, files) {
  const suites = Array.isArray(report?.testResults) ? report.testResults : [];
  const selected = files.map((file) =>
    suites.find(
      (s) => typeof s.name === 'string' && s.name.replaceAll('\\', '/').endsWith(`/${file}`),
    ),
  );
  if (selected.some((s) => !s))
    return { status: 'FAIL', reason: 'MISSING_EXPECTED_SUITE', assertions: 0 };
  const assertions = selected.flatMap((s) => s.assertionResults ?? []);
  if (exitCode === null)
    return { status: 'FAIL', reason: 'PROCESS_INTERRUPTED', assertions: assertions.length };
  if (selected.some((s) => s.status !== 'passed') || assertions.some((a) => a.status === 'failed'))
    return { status: 'FAIL', reason: 'ASSERTION_OR_SUITE_FAILED', assertions: assertions.length };
  if (!assertions.length || assertions.some((a) => a.status !== 'passed'))
    return {
      status: 'NOT VERIFIED',
      reason: 'EMPTY_OR_SKIPPED_ASSERTIONS',
      assertions: assertions.length,
    };
  // A global nonzero exit is retained even if this selected subset appears green.
  if (exitCode !== 0)
    return { status: 'FAIL', reason: 'NONZERO_TEST_PROCESS_EXIT', assertions: assertions.length };
  return { status: 'PASS', reason: 'OBSERVED_COMPLETE_ASSERTIONS', assertions: assertions.length };
}
const aggregate = (values) =>
  values.includes('FAIL')
    ? 'FAIL'
    : values.length && values.every((v) => v === 'PASS')
      ? 'PASS'
      : 'NOT VERIFIED';
export function acceptanceGates(results) {
  const byId = (id) => results.filter((s) => s.id === id).map((s) => s.status);
  const ids = (...names) =>
    names.some((name) => byId(name).length === 0) ? 'NOT VERIFIED' : aggregate(names.flatMap(byId));
  const gates = {
    A: {
      status: ids('P6-B-MEMORY', 'P6-C-EXPERIENCE', 'P6-D-LEARNING', 'P6-G-REVIEW', 'P6-J-FIXTURE'),
      scope: 'Offline trusted fixtures and generic MCP, never native learning.',
    },
    B: { status: 'NOT VERIFIED', scope: 'Native model execution not authorized.' },
    C: { status: 'NOT VERIFIED', scope: 'Real source and receiving agents were not executed.' },
    D: { status: 'NOT VERIFIED', scope: 'OS-protected human authority not established.' },
    E: { status: 'NOT VERIFIED', scope: 'Executable sandbox isolation/evidence not established.' },
    F: {
      status: ids('P6-K-DISTRIBUTION'),
      scope:
        'Application/disposable synthetic-authority distribution only; protected deployment separately unverified.',
    },
    G: {
      status: ids('P6-L-DATABASE'),
      scope: 'Disposable SQLite process-crash reliability; no power-loss claim.',
    },
    H: {
      status: ids('P6-M-ISOLATION', 'P6-N-SECURITY'),
      scope: 'Application scope/privacy, not arbitrary same-UID isolation.',
    },
    I: {
      status: ids('P6-A-FIXTURE', 'P6-E-DISCOVERY', 'P6-E-NO-MATCH', 'P6-P-DAILY'),
      scope: 'Offline fixture UX and bounded payload assertions; no production/native SLA.',
    },
    J: {
      status: 'FAIL',
      scope:
        'Required native, clean-host, protected and sandbox evidence remains unavailable; no V1 release certification.',
    },
  };
  return gates;
}
export function releaseProfiles(gates) {
  return {
    offline_functional: {
      status: gates.A.status,
      scope: 'Trusted repository fixture acceptance only.',
    },
    supervised_local_v1: {
      status: gates.A.status === 'FAIL' ? 'FAIL' : 'NOT VERIFIED',
      scope:
        'Offline candidate demonstrated; clean-host and native/manual acceptance incomplete. Not publication approval.',
    },
    protected_operator_v1: {
      status: 'NOT VERIFIED',
      scope: 'Requires real OS deployment and operator evidence.',
    },
    behavioral_verified_v1: {
      status: 'NOT VERIFIED',
      scope: 'Requires qualified sandbox and trusted results.',
    },
    full_protected_v1: {
      status: 'NOT VERIFIED',
      scope: 'Cannot be promoted from offline fixture results.',
    },
  };
}
