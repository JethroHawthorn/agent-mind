import { behavioralSandboxStatus } from '../packages/core/dist/index.js';

// Qualification inventory only. No alleged canary execution under an unavailable backend.
if (process.argv.length !== 2) {
  process.stderr.write(
    'Usage: pnpm verify:behavioral-isolation (read-only qualification; no execution flags supported)\n',
  );
  process.exitCode = 1;
} else {
  const cases = [
    'synthetic-host-secret-read',
    'protected-host-write',
    'operator-ipc',
    'external-tcp-dns',
    'host-loopback',
    'working-directory-escape',
    'neighbor-project',
    'resource-symlink',
    'inherited-secret-environment',
    'process-limit',
    'disk-quota',
    'output-limit',
    'artifact-limit',
    'cancellation',
    'timeout-process-tree',
    'trusted-suite-write',
    'policy-write',
    'stdout-pass-forgery',
    'artifact-substitution',
    'candidate-replay',
    'protected-sqlite',
    'sec01-broker',
    'candidate-toctou',
    'metadata-policy-override',
  ];
  console.log(
    JSON.stringify({
      schema_version: 1,
      status: 'NOT_VERIFIED',
      capability: behavioralSandboxStatus(),
      execution_started: false,
      canary_executions: 0,
      checks: cases.map((id) => ({
        id,
        status: 'NOT_VERIFIED',
        enforcement: 'NOT_EXECUTED',
        reason: 'NO_QUALIFIED_BACKEND',
      })),
      remediation:
        'Provision and independently review a VM-isolated executor and protected result authority before enabling canaries. This release has no execution toggle or host fallback.',
    }),
  );
  process.exitCode = 2;
}
