// Read-only release rehearsal. This module contains no tag/push/upload/publish executor.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { inspectArtifact } from './rc-validation.mjs';

const repository = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const hash = (b) => createHash('sha256').update(b).digest('hex');
export const PROPOSED_VERSION = '1.0.0';
const PRIOR_RC = 'fad3c213c7ee619eedbe107ce0a7e60400de7859729255e1dadbb2617c4bc7af';
const gitRead = (root, args) => {
  const r = spawnSync(
    'git',
    ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1048576,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    },
  );
  return r.status === 0 ? r.stdout.trim() : null;
};
export function releaseAssessment({ artifact, sha256, root = repository }) {
  const inspected = inspectArtifact(readFileSync(artifact), sha256),
    manifest = inspected.manifest;
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const reviewPath = join(root, 'docs/reviews/P6-004_REVIEW.md'),
    review = existsSync(reviewPath) ? readFileSync(reviewPath) : null;
  const source = gitRead(root, ['rev-parse', 'HEAD']),
    status = gitRead(root, ['status', '--porcelain']),
    tags = gitRead(root, ['tag', '--list', 'v1.0.0']);
  const remote = gitRead(root, ['remote', 'get-url', 'origin']),
    match = remote?.match(/^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\.git$/);
  const workspaceVersions = ['packages/core/package.json', 'packages/mcp-server/package.json'].map(
    (p) => ({ path: p, version: JSON.parse(readFileSync(join(root, p), 'utf8')).version }),
  );
  const blockers = [
    {
      id: 'P6-004-E01',
      class: 'B1',
      status: 'NOT VERIFIED',
      requirement: 'Genuine clean supported target',
    },
    {
      id: 'P6-004-INSTALL',
      class: 'B1',
      status: 'NOT VERIFIED',
      requirement: 'Fresh dependency installation and trusted native provenance',
    },
    {
      id: 'P6-004-LICENSE',
      class: 'B1',
      status: 'FAIL',
      requirement: 'Declared license metadata and exact license notice included in the artifact',
    },
    {
      id: 'P6-002-AUDIT',
      class: 'B1',
      status: 'NOT VERIFIED',
      requirement: 'Separate architecture/security review',
    },
    {
      id: 'P6-005-VERSION',
      class: 'B1',
      status: 'FAIL',
      requirement:
        'Reviewed consistent V1.0.0 runtime/package/CLI version finalization and recertification',
    },
    {
      id: 'P6-005-CERTIFICATION',
      class: 'B1',
      status: 'NOT VERIFIED',
      requirement: 'Independent review of the exact final artifact/source/profile',
    },
    {
      id: 'P6-004-N01',
      class: 'B2',
      status: 'NOT VERIFIED',
      requirement: 'Actual authorized native provider use',
    },
    {
      id: 'P6-004-S01',
      class: 'B2',
      status: 'NOT VERIFIED',
      requirement: 'Actual separated operator/OS authority',
    },
    {
      id: 'P6-004-S02',
      class: 'B2',
      status: 'NOT VERIFIED',
      requirement: 'Actual qualified behavioral execution and protected evidence',
    },
  ];
  const licenseBytes = inspected.entries.get(`${inspected.root}LICENSE`);
  const hasLicense = !!licenseBytes;
  const noticePath = join(root, 'LICENSE');
  const licenseMatches =
    pkg.license === 'MIT' &&
    manifest.license === 'MIT' &&
    hasLicense &&
    existsSync(noticePath) &&
    licenseBytes.equals(readFileSync(noticePath));
  blockers.find((b) => b.id === 'P6-004-LICENSE').status = licenseMatches ? 'PASS' : 'FAIL';
  // Artifact notice/metadata consistency is separate from release authorization.
  const consistent =
    pkg.version === PROPOSED_VERSION &&
    manifest.version === PROPOSED_VERSION &&
    workspaceVersions.every((p) => p.version === PROPOSED_VERSION);
  if (consistent) blockers.find((b) => b.id === 'P6-005-VERSION').status = 'NOT VERIFIED'; // Version equality is not reviewed certification.
  const base = [
    'P6-004-E01',
    'P6-004-INSTALL',
    'P6-004-LICENSE',
    'P6-002-AUDIT',
    'P6-005-VERSION',
    'P6-005-CERTIFICATION',
  ];
  const profiles = Object.fromEntries(
    Object.entries({
      supervised_local: base,
      native_integration: [...base, 'P6-004-N01'],
      protected_operator: [...base, 'P6-004-S01'],
      behavioral_verified: [...base, 'P6-004-S02'],
      full_protected: blockers.map((b) => b.id),
    }).map(([id, required]) => [
      id,
      {
        decision: 'NO-GO',
        required_blockers: required,
        feature_scope:
          'Existing frozen profile boundaries; no privileged capability enabled by this report.',
      },
    ]),
  );
  return {
    schema_version: 1,
    mode: 'PREPARATION_ONLY',
    proposed_version: PROPOSED_VERSION,
    effective_package_version: pkg.version,
    workspace_versions: workspaceVersions,
    version_consistent_for_v1: consistent,
    version_finalization: 'BLOCKED_PENDING_MANDATORY_GATES_AND_REVIEWED_CONTRACT_VERSION_CHANGE',
    source_revision: source,
    source_clean: status === null ? null : status === '',
    source_status: status === null ? 'NOT VERIFIED' : status.split('\n').filter(Boolean),
    lockfile_sha256: hash(readFileSync(join(root, 'pnpm-lock.yaml'))),
    contract_sha256: hash(readFileSync(join(root, 'contracts/v1.json'))),
    artifact: {
      filename: artifact.split('/').at(-1),
      version: manifest.version,
      sha256: inspected.sha256,
      source_identity: manifest.source_identity,
      bytes: readFileSync(artifact).length,
      kind: 'LOCAL_SOURCE_PREPARATION_NOT_ELIGIBLE_V1_RELEASE',
    },
    p6_004_review: {
      available: !!review,
      sha256: review ? hash(review) : null,
      authority: 'PRIOR_REVIEW_PROVENANCE_NOT_AUTOMATIC_FINAL_CERTIFICATION',
    },
    prior_validation: {
      artifact_sha256: PRIOR_RC,
      same_artifact: inspected.sha256 === PRIOR_RC,
      certification_inherited: false,
      requires_independent_recertification: true,
    },
    license_file_present: hasLicense,
    license: manifest.license ?? null,
    license_notice_matches_source: licenseMatches,
    profiles,
    blockers,
    overall_decision: 'NO-GO',
    eligible_v1_artifact: null,
    publication: {
      authorized: false,
      authorization: 'NOT_REQUESTED_OR_GRANTED',
      executor_available: false,
      proposed_tag: 'v1.0.0',
      local_tag_conflict: tags === null ? 'NOT VERIFIED' : !!tags,
      remote_publication_state: 'NOT VERIFIED_NO_NETWORK_QUERY',
      configured_github_repository: match ? match[1] : null,
      destination_verified: !!match,
      permissions_verified: false,
      npm_channel: 'UNSUPPORTED_PRIVATE_SOURCE_WORKSPACE',
    },
    post_release_checks: 'NOT EXECUTED_NO_PUBLICATION',
    signing: 'UNSIGNED_NO_SIGNING_AUTHORITY_PROVISIONED',
    limitations: [
      'Checksums are not signatures or operator authority.',
      'This agent cannot independently certify or authorize its own release.',
      'Environment flags, review PASS text, candidate stdout or a generic confirmation cannot enable publication.',
    ],
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({
      strict: true,
      allowPositionals: true,
      options: { artifact: { type: 'string' }, sha256: { type: 'string' } },
    });
    if (
      positionals.length !== 1 ||
      !['plan', 'rehearse'].includes(positionals[0]) ||
      !values.artifact ||
      !values.sha256
    )
      throw Error('ARGUMENTS');
    console.log(JSON.stringify(releaseAssessment(values), null, 2));
    process.exitCode = 2;
  } catch {
    console.error(
      'Release preparation refused. Use plan|rehearse --artifact LOCAL_SOURCE_RC --sha256 TRUSTED_SHA256. No mutation, authorization, signing or publication is available.',
    );
    process.exitCode = 1;
  }
}
