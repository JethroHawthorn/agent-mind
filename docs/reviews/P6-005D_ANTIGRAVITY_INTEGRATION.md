# P6-005D — Antigravity CLI integration

Date: 2026-10-29. Candidate: `@jethrohawthorn/agentmind@1.1.0`. Published baseline observed with `npm view`: `1.0.0`.

**Release decision: BLOCKED.** The independent provider, installer lifecycle, SDK stdio contracts and installed npm artifact are implemented. Actual `agy` 1.2.12 recognizes the global MCP entry, but `agy mcp list` reports `No MCP servers configured.` for the documented project config, including inside a disposable Git repository. This is a real failing native acceptance test, not replaced by mocks. `/mcp` workspace discovery and connected-state verification remain outstanding.

**NATIVE_ANTIGRAVITY_MODEL_EXECUTION: NOT VERIFIED**

Authenticated cross-agent model execution: **NOT VERIFIED**. Direct cross-adapter MCP calls are verified separately. No authentication, paid model invocation, Gemini import, publication, credential change, commit, push, tag or GitHub release was performed. All integration writes for verification used disposable project/HOME/registry/npm-prefix locations.

## Official documentation audit

The following official pages were consulted before implementation on 2026-10-29:

- [Product](https://antigravity.google/product/antigravity-cli/): terminal CLI and MCP/skills surfaces.
- [MCP](https://antigravity.google/docs/mcp): local stdio; project `.agents/mcp_config.json`; global `~/.gemini/config/mcp_config.json`; `mcpServers`, `command`, `args`, `cwd`, `enabledTools`, `timeoutSeconds`; interactive `/mcp` management. Plugin-contributed servers are possible and are not a fully inspected policy tier here.
- [Gemini migration](https://antigravity.google/docs/cli/gcli-migration/): separate MCP profiles and skill paths; migration is an explicit user workflow. AgentMind never invokes `agy plugin import gemini` or accepts a Gemini enrollment as Antigravity.
- [CLI reference](https://antigravity.google/docs/cli/reference/): interactive MCP management and command flags.
- [Install/authenticate](https://antigravity.google/docs/install): current redirect describes authentication/keyring behavior; avoid launching an ordinary session during detection.

Public native inspection established executable `/Users/jethro/.local/bin/agy`, version `1.2.12`. Bounded `--help`, `mcp --help` and `mcp list --help` ran with isolated HOME/cwd, closed stdin and no credential environment. This installed version advertises `mcp add/remove/list/enable/disable` subcommands. Detection deliberately needs only the bounded public version; it does not impose Gemini's `skills`/`mcp add` help contract or infer native stdio/model support from version output.

## Architecture audit and decisions

| Audited surface | Existing architecture and decision |
| --- | --- |
| Provider types/registry | `installer/model.ts` owns the provider list; add `antigravity`, retain all three existing identifiers. |
| Codex adapter | Preserve its strict enrollment/project binding and daily tool profile; reuse its shared file/project helpers. |
| Claude adapter | The enrollment-validation/startServer pattern is reusable; Antigravity has its own integration marker, path and source identity. No Claude registration command is used. |
| Gemini adapter | Reviewed enrollment, layered policy, setup, router reuse and capability checks. Antigravity does not inherit Gemini settings layers, `trust`, `includeTools`, millisecond timeout or migration. |
| Executable detection | Existing bounded public probes, canonical executable resolution and isolated environment are reused. Map Antigravity only to `agy`; explicit override supported. Reject relative paths with separators, controls, nonfiles and nonexecutable files. |
| Unified commands | Extend the existing parser and adapter dispatch across setup/status/doctor/repair/update/uninstall; all-provider limit now derives from provider count. Missing executable policy remains SKIP/incomplete for setup. |
| Receipts/ownership | Dedicated `.agentmind/antigravity/{installation,enrollment}.json`, private backups/locks, preimage snapshots, exact owned entry comparisons and atomic replacement. Unowned/imported entries are conflicts. |
| MCP launchers | Use real absolute Node plus the compiled installed `antigravity/adapter.js`, `--enrollment` and the validated absolute enrollment file. No shell or placeholder arguments. |
| Daily MCP profile | Reuse all 19 `DAILY_TOOLS` and existing runtime/server implementations. Server-side call authorization rejects hidden tools even when named directly. |
| Project/registry identity | Reuse strict canonical project resolution, shared receipt-bound registry selection and supervised local startup. A user-scoped entry inherits caller cwd and rejects foreign projects; it cannot force cwd to impersonate the enrolled project. |
| Router Skill | Reuse the existing reviewed router bytes and lifecycle. Install in documented project/user location. Identical pre-existing bytes are read-only reuse, never adopted as ownership. |
| Acceptance harnesses | Existing native model probes require explicit authorization. New direct stdio tests never pretend to be native model evidence; an opt-in real `agy mcp list` test separately records actual discovery. |
| Package runtime | Existing recursive compiled-runtime assembly includes both Antigravity modules and the new core migration automatically, alongside the shared router. Packaging tests assert their presence; a real npm installation exercised all four adapters. |
| README/install docs | Updated provider list, focused/all setup, paths, troubleshooting, migration ownership, data retention and native verification limits. |

### Dedicated config and lifecycle

`AntigravitySetup` manages `.agents/mcp_config.json` or `~/.gemini/config/mcp_config.json`. Its owned `agentmind` entry has absolute `command`/`args`, `enabledTools` and `timeoutSeconds: 30`. `cwd` is intentionally omitted: actual caller cwd must reach the enrolled adapter's project check, particularly for a global entry. This supports a single enrolled project per global AgentMind registration; other projects should use project scope. Unknown settings/servers are preserved.

Both project and user files are bounded-read and link checked. Malformed JSON, alias names containing AgentMind, changed entries, imported entries without receipts, alternate-scope entries and registry disagreements fail closed. Preview/status/ordinary doctor do not initialize SQLite or write integration files. Public version probing uses disposable temporary files only. Setup apply reuses P6-005C's driver, exclusive new registry creation, migration/ledger/FTS checks and SDK health verification. Existing pending schema changes still require separate owner-approved digest; setup does not migrate an existing old registry implicitly.

Repeated setup produces SKIP and retains config timestamps. Repair restores missing owned files without adopting edited content. Update handles router changes and installed Node/adapter path refresh through a validated old receipt/config pair, preserving project/registry bindings. Old commands are never executed during refresh. Changed user entries stop the update. Existing backup/journal recovery semantics remain; there is no cross-resource ACID claim.

Uninstall removes the owned MCP entry, enrollment and exact owned router file only; it preserves memory, database, backups, unrelated servers/settings/skills, the CLI executable and other integrations. A single shared `.agents/skills/agentmind-router/SKILL.md` keeps one owner. The planner blocks owner removal/update while managed dependents remain; combined removal orders read-only reusers before owners. Failure compensation also preserves owners with surviving dependent receipts.

### Provenance migration and contracts

The core source enum now includes `antigravity`. Schema **12** transactionally rebuilds only the source-constrained `experiences`, `skill_versions` and `skill_usage_events` tables, preserving rowids, records, indexes, triggers, FTS references, skill digests, active pointers and audit history. It appends a checksummed v12 ledger row. The existing v11 ledger row remains required and unchanged. Approval/operator/sandbox authority is not expanded.

A populated actual v11 fixture is built using the historical migrations and upgraded twice to check preservation/idempotency; memory/experience/usage provenance and immutability are tested. Historical interruption fixtures can contain a canonical v12 parent after dropping later objects; the v10 recovery check now recognizes exactly that known widened constraint as well as its original v10 constraint. Unknown schemas still roll back. Version-dependent tests now expect 12; unrelated numeric assertions were retained.

`contracts/v1.json` is an explicitly refreshed 1.1.0 feature candidate: additive provenance enum, new parser entries and schema 12. Daily tool names/output contracts and operator boundaries are unchanged. Snapshot comparison passes, but independent architecture/security compatibility approval is outstanding. Previous artifact certification is not inherited. Old 1.0.0 runtimes must not open schema 12; rollback requires a verified pre-upgrade backup.

## Coexistence matrix

| Scenario | Result/evidence |
| --- | --- |
| Legacy Gemini only | Existing regression tests retained; no executable aliasing. |
| Antigravity only | Focused setup, independent detection/config/receipt and SDK runtime verified. |
| Both installed | Independent provider/config state; shared authorized project and registry through direct adapters. |
| Gemini config without executable | Antigravity setup preserves the legacy config byte content. |
| Imported Gemini entry in Antigravity JSON | Unowned entry causes conflict; no adoption or implicit rewrite. |
| Project/global AgentMind collision | Setup/status detect conflict; neither scope silently wins. |
| Gemini router plus Antigravity project skills | Separate Gemini-owned router retained; shared `.agents` router dependencies tracked where applicable. |

Manual migration plan: back up and inspect the existing Gemini/Antigravity configs and receipts; follow Google's migration guide only under the user's separate intent; preserve legacy Gemini enrollment; inspect any imported entry instead of adopting it; resolve conflicting unowned/duplicate entries manually; run focused AgentMind dry-run, review the exact owned plan, then apply and use `/mcp`. Never delete the registry or credentials to force setup.

## Verification and exact evidence

See `P6-005D_EVIDENCE.json` for exact command outputs, test counts, artifact identity and retained installation evidence. Initial failures and corrections are recorded separately from final outcomes. The sandbox run hit Unix-socket restrictions; the full suite and disposable npm installation were rerun with host permission. No model authorization was requested or inferred.

| Final check | Result |
| --- | --- |
| `npm run lint` | PASS; 348 files checked; one pre-existing informational template-literal suggestion in `tests/unit/learning-review.test.ts:523`, no warnings/errors. |
| `npm run typecheck` | PASS. |
| `npm run build:cli` | PASS; core and MCP server compiled and runtime assembled. |
| `node scripts/architecture.mjs` | PASS; exact candidate matches; no new graph violations/cycles. |
| `npm test -- --maxWorkers=2` (host permissions) | PASS: 112 files passed, 2 skipped; **1359 tests passed, 0 failed, 3 skipped / 1362 total**; 283.87 seconds. Includes unit/integration/installer/MCP/security/database/architecture/acceptance/performance suites. |
| `node scripts/docs-check.mjs` | PASS: 15 files, 54 local links, 22 shell blocks, 2 JSON blocks. |
| `npm run smoke` | PASS: independent SDK processes, shared memory/experience, restart and isolation. |
| `node scripts/verify-global-cli.mjs` (host permissions) | PASS: 1 installed-artifact integration test, 26.49 seconds; fresh dependencies and prefix; executable outside checkout; four adapters. |
| `node scripts/package-evidence.mjs ...` | PASS: exact tarball file/bin/license/dependency/source-path/known-secret-pattern audit, 182 files. |
| Explicit real `agy` config suite | **1 passed, 1 failed**; global discovery passes, workspace discovery fails. No models. |

The default suite skips the global-prefix test and two native config cases by design. The global-prefix test was separately run and passed; both native cases were separately run and their failure is retained. No skipped case is reported as native workflow PASS.

### Direct MCP evidence

Independent real Node/stdio adapter processes initialize/ping, advertise all 19 daily tools with object input/output schemas, and return validated AgentMind output contracts. Codex writes a memory that Antigravity retrieves. Antigravity records an unverified experience retrieved through Codex/Claude/Gemini adapters. Learning signals retain Antigravity provenance and `AGENT_REPORTED` trust. Restart preserves the memory; uninstall leaves it retrievable through Codex. Separate projects sharing the same SQLite file cannot retrieve each other's records; a foreign cwd cannot use the original enrollment, including global scope.

A synthetic reviewed fixture supplies an approved active skill (not real operator authentication evidence). Antigravity routing/load respects the exact version/digest, wrong digests fail, and direct protected tool calls cannot change lifecycle state. Protected names tested include approval, promotion, review decision, distribution sync, database migration and outcome confirmation. No skill execution, autonomous approval or protected registry authority is granted.

### Actual native evidence and remaining failures

The opt-in test `AGENTMIND_ANTIGRAVITY_EXECUTABLE=/Users/jethro/.local/bin/agy node node_modules/vitest/vitest.mjs run tests/integration/antigravity-native.test.ts --maxWorkers=1` runs real `agy mcp list` in disposable project/HOME state. **1 passed, 1 failed**: global configuration discovery/removal passes; project configuration discovery fails with `No MCP servers configured.`. Repeating with a real disposable Git repository did not change the result. This proves a discrepancy in native inventory; it does not establish whether the interactive workspace runtime also fails. Keep the official project path; no undocumented fallback is introduced.

Native connected MCP state, native tool discovery/output compatibility, Router Skill discovery/use, memory/experience/learning execution through an authenticated Antigravity model, and authenticated cross-agent workflows remain **NOT VERIFIED**. The native model harness is not implemented as a Gemini alias; `doctor --native --allow-model` reports an unavailable Antigravity model harness rather than invoking a different provider. Interactive/native acceptance needs an explicitly authorized session and correlated MCP events. Do not replace those results with the SDK evidence above.

## Acceptance matrix

| # | Criterion | Status | Evidence/limit |
| --- | --- | --- | --- |
| 1 | Distinct provider recognized | PASS | Provider/schema/CLI tests; independent receipt and source identity. |
| 2 | `agy` detection | PASS | Real version 1.2.12 plus PATH detection tests. |
| 3 | `--antigravity` override | PASS | Parser, explicit-path and unsafe-path tests. |
| 4 | `--cli antigravity` | PASS | Real AgentMind command parser tests. |
| 5 | `--cli all` inclusion | PASS | Four-provider setup, status and installed artifact tests. |
| 6 | Project MCP config | FAIL | Correct documented JSON/path and direct adapter tests pass; real `agy mcp list` does not discover it. Interactive workspace behavior not verified. |
| 7 | User MCP config | PASS | Official global path, native config inventory/removal and direct adapter/project-bound caller tests. Native connected state not verified. |
| 8 | Existing config preservation | PASS | Merge, exact restoration, unrelated servers/settings and malformed config tests. |
| 9 | Owner receipt integrity | PASS | Changed receipt/entry/registry, link, preimage and shared ownership checks. |
| 10 | Setup dry-run | PASS | No persistent integration/registry writes. |
| 11 | Setup apply | PASS | Shared SQLite/FTS bootstrap and SDK health checks; npm installation. |
| 12 | Repeated setup | PASS | SKIP and unchanged config timestamp. |
| 13 | Status | PASS | Read-only report includes executable/version, config/registry paths, router/receipt state. |
| 14 | Doctor | PASS | Ordinary read-only and explicit SDK connect; native limits reported. |
| 15 | Repair | PASS | Missing owned router restored; edited/unowned content rejected. |
| 16 | Update | PASS | Router and installed-runtime path refresh, stable registry/project binding. |
| 17 | Uninstall | PASS | Owned-only removal and memory/backup/unrelated-file retention. |
| 18 | Router Skill | PASS | Correct paths, digest bytes, exact owned/reused tracking and shared-owner removal protection. Native discovery/use not verified. |
| 19 | Gemini compatibility | PASS | Existing Gemini regression suite and old provenance retained. |
| 20 | Coexistence | PASS | Separate configs, imported-entry rejection and shared-router dependency tests. |
| 21 | MCP initialize | PASS | Actual Antigravity adapter stdio with official MCP SDK; not native model proof. |
| 22 | Daily discovery | PASS | Exact 19 server-side daily tools through stdio. Native model discovery not verified. |
| 23 | Tool schema compatibility | PASS | Object input/output schemas and validated returned outputs through SDK. Native client acceptance not verified. |
| 24 | Protected denial | PASS | Direct hidden-tool calls fail and lifecycle state remains unchanged. |
| 25 | Project isolation | PASS | Foreign enrollment/cwd, record IDs and injected project identity rejected. |
| 26 | Registry sharing | PASS | Four adapters share one authorized project/SQLite registry. |
| 27 | Native memory workflow | NOT VERIFIED | No authenticated Antigravity model call authorized/run. |
| 28 | Native experience workflow | NOT VERIFIED | Direct adapter workflow passes; native model workflow not run. |
| 29 | Cross-agent retrieval | PASS | Actual MCP calls across four adapters; authenticated model-to-model workflow NOT VERIFIED. |
| 30 | npm installation | PASS | Fresh disposable prefix/dependencies, executable outside checkout, four adapters and data retention. |
| 31 | Documentation accuracy | PASS | Official references, documented native discrepancy, valid links/JSON/shell. |
| 32 | Full regression | FAIL | Default automated suite: 1359 passed / 0 failed / 3 skipped; separate required native config suite: 1 pass / 1 fail. Overall native acceptance is incomplete. |

## Artifact and release impact

- Tarball: `dist/artifacts/jethrohawthorn-agentmind-1.1.0.tgz`.
- SHA-256: `aba3224c519db5e729ba75c2a344be9f147dde5ddb6b754bdc28cd329cfcb00c`.
- npm integrity: `sha512-6jylJP158X1j+iLs1P+SxCqCfoFmQkVDrY+0iYshcz44fuJgvYT+bW59+Q2bo9l/1lT0PKQmHimQXPkwH1ESqA==`.
- Size: 263,408 bytes; unpacked 1,110,080 bytes; 182 files.
- File manifest/checksums: `dist/artifacts/jethrohawthorn-agentmind-1.1.0.manifest.json`, `dist/artifacts/SHA256SUMS`, `dist/artifacts/pack-1.1.0.json`.
- Runtime environment: Node v22.13.1, darwin arm64.
- Retained installation: `/private/var/folders/0d/jyw7f9s96kq4bx_0291cd3m40000gn/T/agentmind-global-APLtMc`.
- Exact stdout/stderr/test counts retained in [evidence ledger](P6-005D_EVIDENCE.json); expanded local logs under `dist/artifacts/P6-005D-logs/`.

The tested tarball was copied from the successful smoke installation's exact npm pack output, then independently scanned. It was not silently rebuilt after that installation. Tarball runtime assets include `antigravity/adapter.js`, `antigravity/setup.js`, the provenance migration and existing router. Fixture executable doubles prove installer selection only; actual MCP processes and storage ran from the installed artifact. This is developer-host evidence, not clean-machine/native model certification.

Recommended next version: **1.1.0** (additive provider feature; registry migration compatibility impact explicitly documented). Do not overwrite npm 1.0.0. This candidate has not been published. The two private implementation workspace packages retain their names/versions and remain unpublishable. No new dependency version, npm credential, separate memory database or skill lifecycle was introduced.

Release blockers: resolve/verify native project discovery via the official `/mcp` surface; obtain explicit authorization and correlated native memory/experience/skill/cross-agent evidence; independently review the schema migration, ownership/security and exact npm artifact; verify clean supported hosts/platforms/native dependency provenance. Existing protected-operator and executable-sandbox assurance remains unverified and is not established by this feature.

## Changed files

50 files changed/added (uncommitted):

- `.gitignore`
- `CHANGELOG.md`
- `README.md`
- `contracts/README.md`
- `contracts/v1.json`
- `docs/reviews/P6-005D_ANTIGRAVITY_INTEGRATION.md`
- `docs/reviews/P6-005D_EVIDENCE.json`
- `docs/v1/INSTALLATION.md`
- `docs/v1/MAINTAINERS.md`
- `docs/v1/UPGRADE.md`
- `package.json`
- `packages/core/src/antigravity-source-migration.ts`
- `packages/core/src/database.ts`
- `packages/core/src/gemini-source-migration.ts`
- `packages/core/src/skill-usage-adapters.ts`
- `packages/core/src/source-agent.ts`
- `packages/core/src/storage-reliability-migration.ts`
- `packages/mcp-server/src/agentmind-main.ts`
- `packages/mcp-server/src/antigravity/adapter.ts`
- `packages/mcp-server/src/antigravity/setup.ts`
- `packages/mcp-server/src/installer/adapter.ts`
- `packages/mcp-server/src/installer/detection.ts`
- `packages/mcp-server/src/installer/model.ts`
- `packages/mcp-server/src/installer/service.ts`
- `tests/integration/antigravity-daily.test.ts`
- `tests/integration/antigravity-native.test.ts`
- `tests/integration/database-reliability.test.ts`
- `tests/integration/global-cli.test.ts`
- `tests/integration/installer.test.ts`
- `tests/integration/learning-e2e.test.ts`
- `tests/integration/release-readiness.test.ts`
- `tests/unit/antigravity-setup.test.ts`
- `tests/unit/authoring.test.ts`
- `tests/unit/behavioral.test.ts`
- `tests/unit/core.test.ts`
- `tests/unit/database-reliability.test.ts`
- `tests/unit/experience-scope.test.ts`
- `tests/unit/experience.test.ts`
- `tests/unit/gemini-migration.test.ts`
- `tests/unit/global-package.test.ts`
- `tests/unit/installer.test.ts`
- `tests/unit/learning-review.test.ts`
- `tests/unit/learning.test.ts`
- `tests/unit/retrieval-migration.test.ts`
- `tests/unit/retrieval.test.ts`
- `tests/unit/skill-distribution.test.ts`
- `tests/unit/skill-model.test.ts`
- `tests/unit/skill-operator.test.ts`
- `tests/unit/skill-proposal.test.ts`
- `tests/unit/skill-usage.test.ts`
