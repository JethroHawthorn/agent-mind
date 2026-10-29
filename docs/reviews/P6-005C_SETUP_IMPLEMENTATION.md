# P6-005C — One-command setup, SQLite bootstrap and MCP readiness

## A. Executive Summary

`agentmind setup --cli all --apply` now verifies the real Node SQLite driver, resolves the existing receipt-bound registry, exclusively creates/bootstrap-migrates a missing supervised registry, verifies schema/ledger and all five FTS indexes, applies the existing owned provider configuration plans, and checks each installed MCP adapter through the SDK before returning `ready: true`.

Existing pending schemas deliberately require the established owner-approved digest migration workflow. Setup does not bypass that boundary, rebuild indexes, replace corrupt data, acquire protected broker authority or invoke models. Partial failures preserve the registry and existing configuration recovery journals. Missing providers are reported separately and yield warnings when the installed subset is ready.

The final npm artifact was installed with fresh dependencies into a disposable prefix/cache/HOME on the developer macOS arm64 host, then tested outside the checkout without pnpm or sqlite3 on PATH. This is not clean-machine certification. Native model use, separated protected OS deployment and behavioral sandbox isolation remain NOT VERIFIED. Nothing was committed, pushed, published or tagged.

## B. Existing Setup Architecture

Inspection map, before implementation:

| Responsibility | Existing component reused |
| --- | --- |
| Unified command dispatch | packages/mcp-server/src/agentmind.ts, now handlers in agentmind-main.ts behind a dependency-loading boundary |
| Configuration planning/apply/recovery | installer/service.ts and installer/adapter.ts; provider setup.ts implementations |
| Project authorization | codex/project.ts and core project identity resolution |
| Registry selection | installer/context.ts, shared with daily CLI |
| SQLite initialization/supervised guard | core/database.ts: openDatabase, openUsageDatabase, assertSupervisedRegistry |
| Owner migration plan/digest/transaction | core/database-maintenance.ts: planDatabaseMigration, migrateDatabase |
| Schema checks/checksum journal | core/storage-reliability-migration.ts; schema version 11 |
| Retrieval index initialization | core/retrieval/storage.ts: migrateRetrieval and existing hybrid metadata migration |
| Direct MCP health | installer/doctor.ts: runtimeDoctor |
| Provider processes/stdio shutdown | codex/claude/gemini adapters, runtime.ts, shutdown.ts and SDK transport |
| Global assembly/install smoke | scripts/package-cli.mjs, verify-global-cli.mjs, existing global-cli.test.ts |

The previous unified setup applied configuration only. MCP startup was responsible for first database initialization. This change composes those existing components into readiness orchestration; it does not replace their handlers or storage system.

## C. Reused Components

New installer/setup.ts orchestrates existing plan/apply and runtimeDoctor. New installer/registry.ts performs location/header preflight and calls the existing core database/migration/index APIs. New installer/sqlite-driver.ts provides a disposable in-memory check. No core schema, migration SQL/checksum, public core export, provider configuration format or privileged capability implementation changed.

The existing CLI implementation moved to agentmind-main.ts. The original executable remains agentmind.ts with the same shebang/bin path. Its small dynamic-import boundary catches missing runtime packages before command loading and emits a sanitized dependency error. There is one command implementation. The contract candidate records only the new CLI source path and two literal code-owned dynamic imports; CLI flags, MCP schemas, core exports and database contracts remain unchanged.

## D. SQLite Driver Verification

Before persistent mutation, verifySqliteDriver dynamically loads the actual declared better-sqlite3 package, opens `:memory:`, checks SELECT 1, creates a disposable TEMP FTS5 table, inserts/searches a fixed probe there, and closes it. It does not invoke the external sqlite3 executable, an OS package installer or sudo.

Controlled codes distinguish missing JS driver, missing native binding, ABI/architecture mismatch, unsupported platform, permission failure, connection failure and unavailable FTS5. Only codes and controlled guidance are returned; raw errors/paths are suppressed. The executable boundary handles a wholly missing driver that would otherwise fail during static module imports. Actual installed-package tests temporarily remove/restore both the native binding and driver directory and verify exit 5 without configuration writes. ABI/platform/FTS-unavailable classification uses isolated injected loader failures; an actually FTS-disabled native build and a full unsupported-OS installation were not provisioned.

## E. Registry Path Policy

Selection remains explicit --db, otherwise remembered receipt binding, otherwise ~/.agentmind/agentmind.db. Explicit paths must agree with all remembered bindings. Disagreeing receipts or a different explicit registry now fail clearly instead of overriding the binding. Project identity, canonical authorized root and project/user semantics are reused. Codex user scope remains unsupported.

Existing database, sidecar and parent paths must be canonical, regular/private/current-owner as appropriate, without symbolic/hard links. Parent writability is checked before mutation. Only required absent directories are created, with mode 0700; the file is exclusively reserved with mode 0600. Existing directories are never recursively chmodded. Paths in output pass the existing diagnosticText privacy/redaction boundary.

## F. Database Creation

A missing file is created exclusively; an existing file is never replaced. Only that newly created registry receives automatic release-owned bootstrap through the current core migration engine, using the freshly computed empty-schema digest and its existing immediate transaction/preflight. The core opener then configures the normal runtime and verifies the schema. The migration ledger provides existing checksum/name/applied-at provenance; the setup report identifies creation and the applied version list. No synthetic user memory, experience or skill is inserted.

An existing current supervised registry is opened through openUsageDatabase, which never runs core migrations. An existing empty file is pre-existing state and requires explicit owner migration, rather than being silently adopted/reset. A corrupt, future, unknown or protected registry is preserved and refused. The final schema is reopened through the existing owner migration preflight to recheck ledger, version and digest.

## G. Migration Safety

Automatic bootstrap is narrowly limited to the file exclusively created by this setup invocation. Every pre-existing pending schema stops with INSTALLER_MIGRATION_OWNER_REQUIRED, exit 3, before MCP configuration. The existing owner workflow remains `db migrate --db PATH --dry-run`, reviewed backup/preflight and explicit `--apply --schema-digest SHA256`. Setup cannot invent that owner approval.

Existing core immediate transactions, checksum verification and schema-digest recheck enforce migration consistency. Existing empty-file/crash evidence is retained on failure; no reset, restore or file deletion is attempted. A real original-v1 fixture test verifies refusal, explicit test-owner migration through the existing API, subsequent successful setup, original memory preservation and FTS search. Historical schemas are fixtures, not an invented published upgrade history.

## H. FTS5 Verification

Two distinct assertions are made: the in-memory engine supports working FTS5, and the registry's actual indexes are valid. The fixed DATABASE_INDEXES allowlist contains memories_fts, experiences_fts, skills_fts, skill_version_retrieval_fts and skill_discovery_fts. Setup verifies the core structure/ledger, runs quick_check, prepares actual MATCH statements, and runs FTS integrity-check with rank 1 to compare external-content indexes with their source records.

Index control checks execute inside an immediate transaction that is rolled back even on success. No real user record is inserted or modified to test search. No rebuild command is used. Normal derived retrieval metadata can be initialized through migrateRetrieval for an empty skill-version registry; existing populated versions needing that initialization require reviewed owner action instead of silently indexing potentially large content. Missing or damaged indexes fail readiness. Index integrity checks themselves can scan stored data; they are not constant-time or clean-host performance certification.

## I. MCP Provider Configuration

Only after database readiness do the existing provider adapters apply their process-local owned plans, atomic writes, backups, journals, locks and compensation. They preserve unrelated configuration/hooks/instructions. No AGENTS.md, CLAUDE.md or GEMINI.md changes are introduced.

For --cli all, detected installed providers are selected and missing providers produce individual SKIP/NOT_INSTALLED entries. Installed subset success returns exit 2, not a claim that all three are ready. A specifically requested missing provider fails dependency resolution. Conflicts stop before database mutation; provider-apply failures retain the initialized registry and existing recovery evidence. A missing adapter build is reported as a dependency failure before database/configuration mutation.

## J. MCP Runtime Health Checks

runtimeDoctor remains the direct SDK implementation. It checks the current owned installation, enrollment database and project binding, then launches the installed absolute Node/adapter/enrollment combination in the authorized root with a limited environment. It initializes/pings MCP, lists the exact daily allowlist with valid input schemas, rejects privileged exposure, invokes read-only agentmind_status, and verifies ok/project/source/schema. It also performs the existing bounded read-only routing probe.

SDK client/transport close is awaited and shutdown errors fail readiness. The SDK may escalate termination for an unresponsive child; this implementation does not independently attest an exit-status-zero process trace. Normal adapter startup/close and subsequent reopening pass in tests. No synthetic task records, provider authentication, paid calls, native models, candidate execution, approval or protected operation is performed. Direct MCP success remains distinct from native coding-agent discovery/use.

## K. Dry-Run and Apply Semantics

Preview/default noninteractive setup runs only the disposable driver/FTS check, location/receipt/provider inspection and existing configuration planner. For an existing registry, it reads a bounded SQLite header rather than opening a live SQLite connection, avoiding WAL/SHM coordination writes. The observed header version is explicitly provisional because a live WAL can contain newer state. Live schema/ledger/index integrity and MCP startup are NOT_VERIFIED until apply. Missing registries show their planned bootstrap versions. No persistent file/config/schema is created or changed and no MCP/model starts during preview.

--apply is required for unified setup mutation. Successful apply means SQLite, actual indexes, owned configuration and selected installed MCP runtimes were checked. Ordinary status/doctor remain read-only and do not initialize; doctor --connect retains its explicit startup/migration behavior. Setup does not route an old schema through doctor to evade owner migration approval. Noninteractive defaults and project scope are preserved. Interactive setup can select targets but still requires explicit --apply for mutation.

## L. Idempotency and Recovery

Healthy repeated setup reuses the same registry, verifies current schema without core migration, and skips unchanged configuration/receipts. When all plans SKIP and no recovery is required, it also avoids rewriting the unified journal. Tests compare all private installation file contents, modes and mtimes across repeated setup and verify original user memory and migration-ledger rows remain unchanged.

An existing operation lock is refused before database creation and never deleted automatically. Configuration failures keep the database and existing compensation/journals. A post-configuration runtime failure returns applied:true, ready:false and exit 7, preserving both registry and managed configuration for safe diagnosis/rerun. Interrupted bootstrap leaves recoverable state for explicit owner inspection/migration. There is no cross-filesystem ACID/rollback claim or arbitrary same-UID attacker isolation guarantee.

## M. Security and Authorization Boundaries

Protected broker markers are checked through the existing owner/supervised core preflight before writes; local setup grants no operator authority. Core SEC-01 grant checks, BE-001 sandbox restrictions, project isolation, trusted operator approvals, immutable skill evidence and autonomous promotion/distribution policy are unchanged. Registry rebinding is stricter. No install-time setup hook, OS package installation or privileged service is added.

The new driver loader injection is code-owned test support, not a CLI/environment plugin interface. All JSON/human output uses existing sanitization; error codes and remediation replace raw driver/config/child output. The SQLite native binding remains an ordinary external npm dependency and is not blindly bundled. Same-UID filesystem and platform limits remain explicitly documented.

## N. CLI Output and Exit Codes

Existing JSON schema_version 1 is retained with additive readiness fields: mode, ready, exit_code, registry, checks, providers, plans/results, native_model_execution, and failed_stage/error/recovery on failure. `applied` describes configuration application/revalidation; it is not a substitute for `ready`. Registry paths are safely rendered. Providers distinguish CONFIGURED, ALREADY_CONFIGURED, NOT_INSTALLED and conflicts; runtime checks separately determine overall readiness.

Human output shows driver, registry/schema/FTS, provider and runtime checks, the selected registry and supervised mode. Apply no longer prints the generic Preview-only label. PASS/FAIL/SKIP are explicit; JSON preserves the existing NOT_VERIFIED spelling and human guidance explains native/OS/sandbox limits.

Exit categories remain 0 success; 2 installed subset ready with missing providers/incomplete verification; 3 conflict/busy/owner action; 4 invalid arguments/path; 5 driver/build/dependency; 6 permission; 7 integrity/runtime verification failure; 1 unexpected internal failure. Ordinary doctor may return 7 before enrollment and 2 for incomplete advanced verification even after successful local setup.

## O. README and Documentation Changes

The concise README keeps the verified local candidate npm tarball workflow; public registry installation remains pending. It explains that setup creates a missing registry, uses the declared Node dependency instead of sqlite3 CLI, verifies FTS5/MCP, preserves existing data, and stops for owner-approved existing-schema migrations. Native model execution remains separate. Installation, troubleshooting and source quick-start guides document stage ordering, header-only preview, private paths, warning/exit meanings, idempotency and recovery.

No package name availability, cloud/encryption, universal OS/ABI, authenticated native use, protected deployment or executable sandbox certification is claimed. Detailed guides remain repository documentation under the selected existing npm files metadata.

## P. Automated Test Results

New tests use the existing Vitest framework and installerFixture; no second harness was introduced. setup-driver.test.ts has 8 tests; setup-readiness.test.ts has 29 tests. They cover all required failure categories at the stated actual/injected layer. Existing installer, privacy, migration, MCP and package suites remain intact. A missing-driver test boundary uses the production error class, avoiding false source-versus-built class identity expectations.

Initial diagnostics retained: one pre-enrollment doctor expectation was corrected from 2 to its existing actual exit 7; an injected migration-error class mismatch was fixed in the test; concurrent-change refusals occurred when package/source builds rewrote adapter identities watched by existing consent snapshots. Builds and final readiness validation were separated, and both isolated and full idempotency coverage passed. The original build identity guard was retained. No ownership guard or security assertion was weakened to mask those outcomes.

Exact final commands, counts and hashes are retained in P6-005C_EVIDENCE.json and the adjacent artifact validation logs. Restricted Unix-socket broker failures are reported independently from the approved unrestricted retry, not hidden as a green full-suite command.

## Q. Clean Installation Evidence

Final disposable global install: /private/var/folders/0d/jyw7f9s96kq4bx_0291cd3m40000gn/T/agentmind-global-tbBZI4. npm pack and npm install --global used a fresh prefix/cache/HOME/npm config. No global developer prefix or real registry/config was modified. The installed integration test runs outside the checkout with a PATH containing Node, Git, provider doubles and the prefix/bin; pnpm and sqlite3 are absent. No runtime NODE_PATH/workspace node_modules link is inherited.

Installed tests verify help/version, pure setup preview, one-command creation/FTS/readiness, repeat setup, status, ordinary/connect doctor, exact generated Codex/Claude/Gemini process configuration, real SDK storage/retrieval, advisory views, retained data on uninstall and actual missing binding/driver refusal. Test orchestration uses repository SDK/Vitest, but launched CLI/MCP dependencies are physically installed npm dependencies. This is developer-host artifact evidence, not an independent clean OS/VM or authenticated native-provider test.

## R. Release Artifact Impact

Final artifact: dist/artifacts/p6-005c/agentmind-1.0.0.tgz.
SHA-256: 807b0a67ce50d94fe0e7b035a7c032c6cd0c42269849572c8c788c8f9ba7200c.
Packed bytes: 257,862; files: 177.
Per-file packed manifest: dist/artifacts/p6-005c/agentmind-1.0.0.manifest.json.
Checksum sidecar: dist/artifacts/p6-005c/SHA256SUMS.

The package-evidence helper now writes manifests/checksums beside the supplied archive, keeping this candidate separate from P6-005B. The final artifact includes the loader, existing relocated handlers and the new installer readiness modules via the existing compiled-runtime allowlist. SQLite migrations/assets remain the unchanged compiled core modules. No native binary, user configuration, DB, credentials or source checkout path is included by the explicit artifact scan. This is a known-pattern/allowlist check, not exhaustive supply-chain certification.

The prior P6-005B artifact digest 89e505aa03177c2e8cf1547b1ded8f5d7f8036b0c4720cca84d1d35261df5f1e cannot certify the changed executable loader, setup behavior, database bootstrap/FTS authorization ordering, MCP verification or README. All affected P6-003/P6-004/P6-005/P6-005A/B evidence requires independent exact-artifact recertification. Existing blocker records are preserved. New local bytes under version 1.0.0 are not a published immutable release or publication authorization.

## S. Remaining Blockers

Independent exact-artifact review, clean supported macOS host/native ABI matrix, authenticated Codex/Claude/Gemini discovery/use, public licensing/name control and release authorization remain open. Protected operator OS enforcement and executable sandbox isolation remain NOT VERIFIED. Windows/Linux/Intel macOS and alternate Node ABIs are not certified by this host test. Existing old/empty schemas intentionally require owner migration and populated missing retrieval indexes require reviewed maintenance. Unavailable providers cannot be made ready by setup.

No unsupported protected/behavioral/native claim is upgraded by direct MCP health. The SDK-managed close does not independently attest child exit code zero under every forced-termination scenario. Filesystem checks are defense in depth rather than an openat-based hostile same-UID proof. No native acceptance model was invoked.

## T. Final Assessment

Normal fresh supervised local setup is implemented and verified at the real installed Node/SQLite/FTS/MCP layer. Existing-data and authorization constraints intentionally take precedence over unconditional one-command completion. A successful local setup now has checked database and MCP readiness, while pending owner migrations, conflicts, missing dependencies and failed health are explicit refusals or warnings.

Publication and native/protected/sandbox release certification remain NO-GO/NOT VERIFIED pending their independent gates. The following matrix scopes PASS to the observed implementation/test layer.

| Capability | Status | Evidence / limit |
| --- | --- | --- |
| Existing components reused; one CLI/installer | PASS | Existing handlers/planner/apply/core/doctor, small loader and readiness orchestration |
| Actual SQLite driver/basic connection | PASS | Native in-memory query; installed fresh dependency |
| Missing JS driver/native binding refusal | PASS | Actual installed directory/binding removal and restoration, exit 5 |
| ABI/platform/FTS-unavailable classification | PASS | Controlled loader failures; no raw diagnostics; unsupported real platform NOT VERIFIED |
| Registry default/explicit/receipt selection | PASS | Default private path, retained binding and conflict tests |
| Private writable canonical paths | PASS | 0700/0600 new paths; denied unsafe/unwritable paths without chmod |
| Missing registry bootstrap | PASS | Exclusive creation, existing transactional core initialization/schema11 |
| Existing current registry/data reuse | PASS | Historical/user memory and ledger preservation |
| Existing empty/old/future/unknown/corrupt handling | PASS | Safe refusal; old/empty owner digest required, no reset |
| Owner migration boundary/recovery | PASS | Original-v1 refusal, explicit owner migration, successful setup/FTS afterwards |
| Migration failure recovery | PASS | Injected failure preserves evidence; existing core rollback suites retained |
| Protected broker registry refusal | PASS | Actual fixture marker, no config mutation or protected authority |
| FTS5 engine and actual indexes | PASS | In-memory MATCH and five rolled-back index integrity checks |
| Missing/damaged FTS postings | PASS | Real fixture damage detected; no repair/user-record mutation |
| Codex configuration | PASS | Existing project adapter; installed generated process starts via SDK |
| Claude configuration | PASS | Existing project adapter; installed generated process starts via SDK |
| Gemini configuration | PASS | Existing project adapter/shared router; installed generated process starts via SDK |
| Missing provider reporting | PASS | Each provider missing tested; SKIP and exit2 for ready subset |
| Scope/user configuration ownership | PASS | Unsupported Codex user scope and user-owned conflicts refused |
| MCP initialization/tools/status/scope | PASS | Exact allowlist, expected enrollment/project/source/schema and read-only probes |
| MCP startup failure handling | PASS | Actual broken child adapter, ready:false/applied:true, exit7 |
| MCP SDK-managed shutdown | PASS | Awaited SDK close in real process tests; independent exit-zero attestation NOT VERIFIED |
| Dry-run/default planning purity | PASS | Closed-WAL/header test with content/mode/mtime snapshot; no live DB/MCP writes |
| Repeated setup/idempotency | PASS | Same registry, no extra migrations/receipt/config/journal rewrites, memory retained |
| Partial configuration/interrupted lock recovery | PASS | Existing compensation/journal retained, no DB deletion, no automatic lock removal |
| Stable sanitized JSON and exit categories | PASS | Additive schema1 fields, actual CLI exit tests and controlled codes |
| No models/auth/skill execution/automatic approval | PASS | Direct SDK-only setup path, unchanged authority and full security suite |
| Global package outside checkout/no pnpm/sqlite3 CLI | PASS | Fresh-prefix installed suite with restricted PATH |
| README/documentation accuracy | PASS | Source links/shell/JSON checked; installed quick-start behavior tested |
| Full restricted regression command | FAIL | Six sandbox Unix-socket errors; exact counts recorded below/ledger |
| Affected unrestricted broker retry | PASS | 10 tests pass with approved socket-capable execution |
| Clean OS/VM certification | NOT VERIFIED | Isolated HOME/prefix on developer host only |
| Authenticated native model integrations | NOT VERIFIED | Separate explicit owner authorization required |
| Protected OS/sandbox deployment | NOT VERIFIED | Existing restrictions/refusals remain |
| Final artifact recertification/publication | NOT VERIFIED | New digest and stale lineage recorded; independent approval required |

### Exact validation results

| Command | Result |
| --- | --- |
| `pnpm build` | PASS; also run by final package prepack and final security suite |
| `pnpm lint` | PASS; existing informational useTemplate finding only |
| `pnpm typecheck` | PASS |
| `pnpm docs:check` | PASS: 15 files, 48 local links, 20 shell blocks, 2 JSON blocks, zero errors |
| `pnpm architecture:check` | PASS; no violations; contract matches |
| `pnpm smoke` | PASS: actual SDK persistence/sharing/project isolation, no native models |
| `pnpm exec vitest run tests/integration/setup-readiness.test.ts tests/unit/setup-driver.test.ts --maxWorkers=1` | PASS: 37 tests, including owner migration recovery, repeat setup, actual process failure and unsupported-provider exit5 |
| `pnpm test:database` | PASS: 79 tests across 7 files |
| `pnpm test:security` | PASS: 151 tests across 11 files |
| `node scripts/verify-global-cli.mjs` | PASS: fresh-prefix final tarball install and explicit installed suite; retained prefix listed above |
| `pnpm exec vitest run --maxWorkers=2` | FAIL in restricted host: 1,327 passed, 6 failed, 1 skipped; 111 files, 1,334 tests total |
| `pnpm exec vitest run tests/integration/broker-native.test.ts --maxWorkers=1` with approved sandbox escalation | PASS: all 10 broker socket tests |
| `node scripts/package-evidence.mjs dist/artifacts/p6-005c/pack.json dist/artifacts/p6-005c/agentmind-1.0.0.tgz` | PASS: exact-byte manifest/allowlist/known-pattern and source-path scan |

Both full-suite runs reported only the six broker errors `BROKER_SOCKET_START_FAILED errno=1`; the unrestricted retry verifies those affected tests separately. The one skipped test is the opt-in npm installation suite, which passes through the explicit fresh-install command. No entire unrestricted full-suite or independent protected deployment is claimed.

The last small correction preserves the existing dependency exit5 for unsupported provider versions; its focused readiness suite and final installed artifact smoke were rerun afterward. The broad full-suite counts above precede that exception-classification-only correction. The exact artifact digest and source hashes in the ledger identify the final result rather than inheriting broad-suite certification silently.

Changed files are enumerated with hashes in P6-005C_EVIDENCE.json. They include the original entry loader/new existing-handler location; installer context, doctor, model/presentation and three readiness modules; two new tests and the expanded global package test; README and three user guides; the contract provenance candidate/notes; package-evidence output location; .gitignore and this report/ledger. No core source/schema/migration SQL, router template or workspace package metadata changed.
