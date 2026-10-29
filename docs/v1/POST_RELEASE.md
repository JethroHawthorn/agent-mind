# Post-release verification and incident plan — NOT EXECUTED

No release has been authorized or published by this milestone. Every check below is a future check, not PASS. This runbook does not grant network, credential, Git or registry mutation authority.

## After separately authorized publication

An authorized verifier checks that the published tag resolves to the approved full source commit; assets/filenames/SHA-256 match the independent approval record; release notes and runtime/package versions agree; downloads work from the actual approved channel; clean supported targets install/build from the downloaded archive; MCP handshake/memory persistence/project isolation/doctor and approved retrieval work; protected/behavioral features retain their required refusal or actual verified boundaries. Do not enable model/native/OS/sandbox probes without their separate usage/deployment authorization. Check upgrade data retention and uninstall/reinstall using disposable data before operational rollout.

Retain expected and observed remote digests, verification environment/toolchain/commands/exits and sanitized logs. Do not infer published bytes from a local artifact or merely matching filenames. Checksums are not signatures; verify any later signature against independently trusted keys, never keys shipped alongside untrusted bytes alone. No remote tag, release, download or post-release operation was queried/executed for P6-005.

## Partial publication

Stop on a tag/asset/notes/source mismatch or incomplete upload. Preserve the approved source, local manifests and actual remote state. A draft still creates remote artifacts and must not be created as an unauthorized rehearsal. Do not blindly retry `create`, clobber assets or retarget a published tag. Independent reviewers/approver must decide recovery within the separately authorized channel. If an approval covers only draft creation, final publication remains prohibited.

## Incident response and corrected versions

Stop further publication/rollout; identify affected exact versions/profiles/platforms and preserve evidence privately. Notify the repository owner/security approver using [security policy](../../SECURITY.md), avoiding real secrets/private memories in public issues. Where the actual distribution channel supports it, an authorized maintainer may mark a release unavailable, add an advisory or deprecate an affected artifact. Permissions and immutable-release constraints must be checked; no such remote action is automated here. npm deprecation is not planned because no npm channel is configured.

Do not overwrite/reuse an immutable published version/tag/artifact. Prepare a new corrected version with a new source revision, digest, independent review and authorization. Document impact and remediation honestly; do not silently delete audit history. Protect user memories/experiences/evidence/backups. Stop incompatible writers; preserve a verified SQLite-consistent backup and source before changes. No unsafe reverse migration or old-binary access to new schemas. Restore only to a new absent offline file under the existing authorized policy, then validate package/evaluation/approval/policy/distribution references before choosing state. Restoring records is not new approval authority. External artifacts and protected deployment require independent reconciliation.

## Ownership and boundaries

The release approver assigns a human incident owner and rollback authority before publication. An implementation agent may prepare fixes/evidence but cannot authorize its own release or public incident actions. Same-person role overlap is recorded, not claimed independent. A terminal prompt is not protected operator identity. [Upgrade](UPGRADE.md), [troubleshooting](TROUBLESHOOTING.md) and [security](SECURITY.md) remain the conservative local recovery guidance. No public rollback, Git deletion, registry mutation or live DB recovery is executed by this document.
