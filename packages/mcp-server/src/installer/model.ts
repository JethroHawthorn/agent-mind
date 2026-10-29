export const PROVIDERS = ['codex', 'claude', 'gemini'] as const;
export type Provider = (typeof PROVIDERS)[number];
export type Action = 'setup' | 'repair' | 'update' | 'uninstall';
export type CheckStatus = 'PASS' | 'FAIL' | 'WARNING' | 'NOT_VERIFIED' | 'NOT_APPLICABLE' | 'SKIP';
export type Diagnostic = {
  id: string;
  component: string;
  cli?: Provider;
  severity: 'info' | 'warning' | 'error';
  status: CheckStatus;
  message: string;
  evidence: 'INSPECTION' | 'OFFLINE_RUNTIME' | 'NATIVE_AUTHENTICATED';
  remediation: string;
  auto_repair: boolean;
  privileged_authorization_required: boolean;
};
export type Detection = {
  id: Provider;
  executable: string | null;
  version: string | null;
  state: 'NOT_INSTALLED' | 'DETECTED' | 'UNSUPPORTED_VERSION' | 'CONFIG_ERROR';
  stdio: boolean | 'NOT_VERIFIED';
  capabilities_verified: boolean;
  authentication: 'NOT_VERIFIED';
  native_discovery: 'NOT_VERIFIED';
};
export type FileOperation = {
  path: string;
  operation:
    | 'CREATE'
    | 'REPLACE_MANAGED'
    | 'MERGE_MANAGED_ENTRY'
    | 'REMOVE_MANAGED'
    | 'VERIFY_REUSED'
    | 'SKIP';
  ownership: 'MANAGED' | 'USER_CONTENT_PRESERVED' | 'REUSED_READ_ONLY' | 'UNOWNED_ABSENT';
  before_digest: string | null;
  after_digest: string | null;
};
export type InstallPlan = {
  schema_version: 1;
  id: string;
  cli: Provider;
  scope: 'project' | 'user';
  action: Action;
  disposition: 'INSTALL' | 'REPAIR' | 'UPDATE' | 'REMOVE' | 'SKIP' | 'CONFLICT';
  operations: FileOperation[];
  preconditions_digest: string;
  journal_paths: string[];
  native_operations: {
    kind: 'OFFICIAL_CLI_UPSERT' | 'OFFICIAL_CLI_REMOVE';
    server_name: string;
    scope: 'user';
    entry_digest: string;
    before_state: 'OPAQUE_IDENTITY_AND_AT_APPLY_CHECK';
  }[];
  backup: string;
  rollback: string;
  postcondition: string;
  risks: string[];
  diagnostics: Diagnostic[];
};
export type Inspection = {
  cli: Provider;
  detection: Detection;
  state:
    | 'NOT_INSTALLED'
    | 'DETECTED'
    | 'PARTIALLY_CONFIGURED'
    | 'CONFIGURED'
    | 'CONFIG_ERROR'
    | 'POLICY_BLOCKED'
    | 'UNSUPPORTED_VERSION';
  scope: 'project' | 'user';
  managed: boolean;
  router:
    | 'MANAGED_CURRENT'
    | 'MANAGED_OUTDATED'
    | 'MISSING'
    | 'UNOWNED_OR_CONFLICT'
    | 'REUSED_READ_ONLY';
  mcp: 'REGISTERED' | 'MISSING' | 'CONFLICT' | 'NOT_VERIFIED';
  hooks: 'NOT_MANAGED_PRESERVED';
  hooks_present: boolean;
  router_candidates: number;
  hook_validation: 'NOT_VERIFIED' | 'NOT_APPLICABLE';
  diagnostics: Diagnostic[];
};
export interface CliIntegrationAdapter {
  readonly id: Provider;
  detect(): Detection;
  inspect(): Inspection;
  plan(action: Action): InstallPlan;
  validate(plan: InstallPlan): void;
  apply(plan: InstallPlan): void;
}
export function diagnostic(
  id: string,
  status: CheckStatus,
  message: string,
  cli?: Provider,
): Diagnostic {
  return {
    id,
    component: cli ?? 'agentmind',
    cli,
    status,
    severity:
      status === 'FAIL'
        ? 'error'
        : status === 'WARNING' || status === 'NOT_VERIFIED'
          ? 'warning'
          : 'info',
    message,
    evidence: 'INSPECTION',
    remediation:
      status === 'PASS'
        ? 'None.'
        : 'Inspect ownership, prerequisites and scope; use a dry-run before changes.',
    auto_repair: false,
    privileged_authorization_required: false,
  };
}
/** Exit categories are deliberately distinct from P2 lifecycle/authorization outcomes. */
export const EXIT = {
  success: 0,
  incomplete: 2,
  conflict: 3,
  invalid: 4,
  dependency: 5,
  permission: 6,
  verification: 7,
  internal: 1,
} as const;
