import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabaseReadOnly } from '../database.js';
import { loadProtectedConfig, validateBrokerConfig } from './policy.js';
import { verifyProtectedRegistry } from './registry.js';
import { rootOwnedPath } from './runner.js';

type Status = 'PASS' | 'FAIL' | 'NOT_VERIFIED' | 'NOT_APPLICABLE';
/** Read-only inspection, never starts a broker/model or attempts a negative filesystem test. */
export function inspectProtectedDeployment(path: string) {
  const checks: { id: string; status: Status; layer: string; message: string }[] = [];
  const add = (id: string, status: Status, message: string, layer = 'DEPLOYMENT_INSPECTION') =>
    checks.push({ id, status, layer, message });
  add(
    'broker.code',
    process.platform === 'darwin' ? 'PASS' : 'FAIL',
    'Source available; protected transport is macOS-only.',
    'SOURCE',
  );
  try {
    rootOwnedPath(path);
    if (lstatSync(path).size > 32768) throw Error();
    const c = validateBrokerConfig(JSON.parse(readFileSync(path, 'utf8')));
    add(
      'identities.configured',
      'PASS',
      'Configuration names distinct non-root broker/operator/runner UIDs. This does not prove runner execution.',
      'CONFIGURATION',
    );
    const observed = process.geteuid?.();
    add(
      'observer.role',
      'NOT_VERIFIED',
      observed === c.broker_uid
        ? 'Observer matches broker UID; not runner denial evidence.'
        : 'Observer is not the configured broker; ordinary developer/operator inspection may lack registry access.',
    );
    try {
      loadProtectedConfig(path, 'preflight');
      const registry = join(c.registry_directory, 'registry.db');
      if (existsSync(registry)) {
        const prior = openDatabaseReadOnly(registry);
        try {
          verifyProtectedRegistry(prior, c.deployment_id as string);
          add(
            'registry.origin',
            'PASS',
            'Existing private registry checkpoint matches root-owned deployment identity; this is not OS write-denial evidence.',
          );
        } finally {
          prior.close();
        }
      } else
        add(
          'registry.origin',
          'NOT_VERIFIED',
          'No registry exists; protected startup must create a fresh trusted database/checkpoint.',
        );
      add(
        'deployment.preflight',
        'PASS',
        'Installed runtime, accounts/groups and protected storage passed read-only startup policy checks. No service started; no write denial tested.',
      );
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      add(
        'deployment.preflight',
        code === 'EACCES' || code === 'EPERM' ? 'NOT_VERIFIED' : 'FAIL',
        'Protected startup preflight did not complete; use the protected Node/runtime and an authorized inspection identity. No fallback or repair performed.',
      );
    }
  } catch {
    add(
      'deployment.configuration',
      'FAIL',
      'Missing, malformed or unprotected configuration; protected mode unavailable. No raw configuration or credentials are emitted.',
    );
  }
  for (const [id, message] of Object.entries({
    'broker.running': 'No service start or IPC probe performed.',
    'ipc.peer': 'Kernel peer authentication requires an actual separate-identity endpoint test.',
    'runner.execution': 'Configured numbers are not evidence of an isolated coding session.',
    'agent.write_denial': 'Requires explicitly authorized disposable OS negative tests.',
    'operator.approval':
      'Requires the separate trusted operator account/session; a PTY prompt is not isolation.',
    'credentials.delegation':
      'Administrator audit of sudo, remote-control, SSH/agent forwarding and inherited authority is still required.',
    'deployment.acceptance':
      'No layer C/D acceptance result is inferred from source/configuration/preflight.',
    'be001.sandbox': 'No behavioral execution backend is enabled or exercised here.',
  }))
    add(id, 'NOT_VERIFIED', message);
  return {
    schema_version: 1,
    mode: 'READ_ONLY_SECURITY_DIAGNOSTIC',
    observed_uid: process.getuid?.() ?? null,
    observed_euid: process.geteuid?.() ?? null,
    checks,
    protected_deployment: 'NOT_VERIFIED',
    autonomous_activation: 'DISABLED',
    mutations_performed: false,
  };
}
