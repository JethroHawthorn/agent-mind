/** Code-owned V1 surface. Diagnostic data is never an authorization grant.
 * No environment, agent metadata, config path or caller assurance flag can enable
 * a protected release profile. Existing broker/sandbox authorities remain separate.
 */
export function releaseBoundaryStatus() {
  return {
    schema_version: 1,
    policy: 'v1-supervised-boundaries-v1',
    profile: 'SUPERVISED_LOCAL_CANDIDATE',
    release_approved: false,
    configuration_verified: false,
    operator_authority: 'REQUIRED_PER_OPERATION_NOT_CONVEYED_BY_DIAGNOSTICS',
    capabilities: {
      project_memory: 'PERMITTED_BY_PROJECT_SERVICES',
      experiences_and_learning: 'PERMITTED_UNVERIFIED_AGENT_PROVENANCE',
      advisory_review: 'PERMITTED_NOT_APPROVAL',
      approved_retrieval: 'PERMITTED_AFTER_CURRENT_AUTHORIZATION_AND_DIGEST_CHECK',
      static_validation: 'PERMITTED_NOT_BEHAVIORAL_VERIFICATION',
      database_maintenance: 'SUPERVISED_ONLY_EXPLICIT_CONSENT_NOT_PROTECTED',
      protected_approval_promotion: 'DISABLED_IN_V1_PROFILE_NOT_VERIFIED',
      protected_distribution_rollback: 'DISABLED_IN_V1_PROFILE_NOT_VERIFIED',
      sandbox_execution: 'DISABLED_NO_QUALIFIED_BACKEND',
      autonomous_activation: 'DISABLED',
      legacy_local_lifecycle: 'EXPERIMENTAL_COMPATIBILITY_OUTSIDE_V1_PROFILE',
    },
    deployment: {
      protected_operator: 'NOT_VERIFIED',
      behavioral_isolation: 'NOT_VERIFIED',
      native_model_use: 'NOT_VERIFIED',
    },
    warning:
      'Application services enforce project policy, not same-UID OS isolation. Legacy terminal workflows cannot operate on protected registries. Availability/configuration is not authorization, deployment verification or V1 publication approval.',
  } as const;
}
