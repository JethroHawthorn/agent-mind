# Changelog

## 1.1.1 — Native discovery and npm remediation candidate (unpublished)

- Require explicit project-bound user registration for Antigravity; refuse unsupported project setup and warn/skip it under project `--cli all`.
- Migrate receipt-owned legacy entries only after SDK and actual native inventory checks; preserve recovery evidence and rollback a pending migration on uninstall.
- Use a canonical npm bin target; verify publish dry-run normalization, tarball, isolated global installation, npm exec and npx.
- Correct native/version evidence and scope documentation. No model execution or publication is implied.

Version decision: npm currently lists 1.0.0 and the stage version. Use 1.1.1 as a distinct patch candidate for remediation of the reviewed, unpublished 1.1.0 artifact; old candidate certification is stale.


## 1.1.0 — Antigravity integration candidate (unpublished)

- Add the independent `antigravity` provider and `agy` detection/override across unified lifecycle commands.
- Manage Antigravity MCP JSON and Router Skills in documented project/user locations with receipt ownership and shared-router safeguards.
- Reuse daily MCP allowlisting, project/registry binding and supervised SQLite setup; add schema 12 provenance migration with owner-digest authorization for existing registries.
- Add direct stdio/coexistence/regression coverage and npm runtime artifact checks. Native Antigravity model execution and authenticated cross-agent workflows remain NOT VERIFIED.

The historical release-preparation notes below describe earlier candidates; npm 1.0.0 is now the published baseline. No publication is performed for this candidate.


## Unreleased — V1.0.0 proposal

**Publication decision: NO-GO.** This is release preparation, not a published V1.0.0. Package/workspace/CLI runtime metadata remains 0.0.1 under the existing V1 contract freeze. Finalizing version 1.0.0 requires a reviewed compatibility/metadata change, rebuild and independent recertification. No previous published versions or upgrade guarantees are implied.

The source candidate implements project-scoped memory and experiences, structured learning and immutable proposals, static validation, advisory review, approved-active hybrid discovery and digest-pinned retrieval, CLI setup/doctor/repair/uninstall, SQLite backup/migrations and distribution recovery. Offline fixture execution does not prove native model reuse, trusted operator identity or isolated behavioral execution.

AgentMind is licensed under the [MIT License](LICENSE), with the notice included in npm and source archives.

Release preparation adds an artifact-bound read-only rehearsal, proposed release metadata, explicit publication governance, draft notes and incident/post-release runbooks. The source packager now includes this changelog. No domain/MCP/CLI/schema/ranking/security contract changes, autonomous activation or new model dependency are introduced.

Mandatory gaps: clean supported environment and fresh dependency install, independent architecture/final review and exact V1 version finalization. Native, protected-operator and behavioral-verified profiles require separate real evidence. Public release remains blocked. See [draft notes](docs/v1/RELEASE_NOTES_1_0_0.md) and [publication runbook](docs/v1/PUBLICATION.md).

Migration: schema stays 11; no new migration here. Preserve verified WAL-aware whole-registry backup, exact immutable package/evidence/journal references and source artifact before operational upgrades. Historical schema fixtures are not past published releases. Reverse migrations/downgrades remain unsupported. Never replace a live or protected DB through ordinary restore; stage an absent offline file and reconcile external artifacts. See [upgrade guide](docs/v1/UPGRADE.md).
