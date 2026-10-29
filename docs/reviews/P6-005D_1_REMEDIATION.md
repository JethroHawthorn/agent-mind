# P6-005D.1 — Native registration and npm packaging remediation

## A. Executive Summary

Implemented candidate **`@jethrohawthorn/agentmind@1.1.1`**. F01 is resolved through the explicitly permitted compatibility restriction/workaround: unsupported standalone project setup no longer writes a broken integration or reports readiness; Antigravity requires explicit `--scope user`, while enrollment and registry access remain strictly project-bound. Project-plugin/native project discovery is **not** claimed to work. Owned legacy project entries can be migrated only with explicit user scope and apply; cleanup follows successful SDK health and actual native configuration inventory.

F02's historical warning was reproduced, but executable removal was not: npm 11.20.0 retains its normalized bin entry. The source manifest now uses the canonical path, eliminating that warning. Exact tarball, publish dry-run, global command, npm exec, npx, SQLite and installed MCP checks pass. F03 documentation now states the actual scope contract and measured `agy 1.4.10` evidence, without inventing a minimum version.

No commit, push, tag, actual publication, npm credential change, owner registry/config modification or authenticated model call occurred. See [exact evidence](P6-005D_1_EVIDENCE.json). Full native model/project-plugin release claims remain **NO-GO**; the supported user-registration profile is prepared for independent review.

## B. Review Baseline

- Review and actual entry HEAD: `7bfcc3f5ed2bc03c51ae8383023aa459e09515a7`, branch `develop`.
- Entry package: 1.1.0, with 50 staged files and no unstaged modifications. The owner's staged patch is byte-preserved; remediation changes are unstaged/untracked additions on top.
- Measured tools: Node v22.13.1, npm 11.20.0, `agy` 1.4.10 (`/Users/jethro/.local/bin/agy`).
- Registry version query returned `0.0.0-stage` and `1.0.0`; neither reviewed 1.1.0 nor new 1.1.1 was listed at verification time.
- Version decision, recorded in CHANGELOG before packing: select a distinct **1.1.1 patch candidate** to distinguish remediation from reviewed, unpublished 1.1.0 bytes. No existing published version was overwritten.

## C. Historical Findings Reproduction

| Finding | Reproduction | Remediation |
| --- | --- | --- |
| F01 | Real CLI reports no servers for standalone project MCP. Minimal documented project plugin and explicit path registrations are absent from required MCP inventory. Local plugin install stages globally; plugin list sees it but MCP list still does not. | Explicit user-only registration support; project requests fail before persistent mutation; all-provider project setup warns/skips Antigravity. No hidden fallback or unverified plugin installed. |
| F02 | Actual npm fix/prepare warns for leading `./`, then retains `bin.agentmind` as `dist/...`. Warning alone does not prove stripping. | Canonical manifest target plus independent pack/publish-normalization/executable verification. |
| F03 | Operational docs still described the broken standalone project path and old measured 1.2.12 evidence. | Updated current guide/README and release notes; old reports retained as historical evidence. |

Initial negative native probes used disposable Git projects and HOME. Initial remediation regression caught a no-installed-CLI exit-category error; fixed so absence still returns dependency exit 5, while an installed unsupported project request returns conflict exit 3. A final safety review added preview-time shared-router update rejection before any working registration can be removed.

## D. Antigravity Official Contract Verification

Consulted current [official plugins](https://antigravity.google/docs/plugins), [MCP](https://antigravity.google/docs/mcp) and [migration](https://antigravity.google/docs/cli/gcli-migration/) references plus installed official customization docs under `~/.gemini/antigravity/builtin/skills/agy-customizations/docs/`.

The plugin reference describes a minimal manifest with name/description and an MCP file under the plugin directory. Its standalone schema URL was not retrievable; the displayed schema and actual CLI acceptance were used for the probe. Installed documentation describes project customization roots and `plugins.json` scanning. However, real native inventory did not establish project MCP discovery through those mechanisms. An accepted local plugin was globally staged and appeared in `plugin list --json`, yet remained absent from `mcp list`. A standalone global MCP control in the same isolated HOME was immediately visible.

Do not infer native workspace activation or process cwd from file existence, plugin inventory or these schema checks. Version 1.4.10 is a measured host baseline, not a permanent minimum or a claim that future CLIs can never support a project profile.

## E. Project-Scope Plugin Architecture

No plugin installer was introduced. New project-scope Antigravity setup is explicitly unsupported for this release. `--cli all` in project scope reports `USER_SCOPE_REQUIRED`, configures other supported installed providers and returns incomplete exit 2. A focused installed project-scope request returns exit 3 with `ANTIGRAVITY_SCOPE_UNSUPPORTED`, without creating a registry or either MCP config.

Supported invocation:

```sh
agentmind setup --cli antigravity --scope user --dry-run
agentmind setup --cli antigravity --scope user --apply
agentmind status --cli antigravity --scope user
agentmind doctor --cli antigravity --scope user
agentmind doctor --cli antigravity --scope user --connect
```

MCP lives at `~/.gemini/config/mcp_config.json`; the router lives at `~/.gemini/antigravity-cli/skills/agentmind-router/SKILL.md`. This is a global registration for **one enrolled project**, not global data authorization. The entry inherits caller cwd; the unchanged adapter rejects a foreign project before opening its registry. No environment variable is trusted as project identity. Another project's existing global entry is a conflict, not adopted.

Known standard `agentmind` plugin directories cause a conservative conflict. Unrelated plugins are preserved and no plugin files/enablement settings are written. There is no invented project plugin receipt/lifecycle.

## F. Installer and Receipt Changes

`antigravity/setup.ts` retains bounded reads, strict project/database/enrollment checks, safe path handling, private receipts/backups/locks and atomic file replacement. The adapter entry still uses actual absolute installed Node/adapter/enrollment paths, the same 19 daily tools and second-based timeout. Server-side allowlisting is independent of client discovery.

The existing planner gains a `MIGRATE` disposition and optional `post_health_operations` that disclose deferred legacy cleanup. Plans remain digest-bound with preimage watches; no new CLI/installer or trusted promotion endpoint was created. Status/ordinary doctor stay read-only and explicitly report unsupported project scope. Explicit user-scope repair/update reuse the existing readiness orchestration for managed installations, including migration recovery. Shared-router changes that would conflict with a project router now fail during preview, preserving the working entry.

## G. Legacy Config Migration

Explicit user-scope setup validates the old project receipt, exact owned MCP entry, router/enrollment and registry/project binding. Edited, unowned, malformed, moved or conflicting entries fail before publishing global configuration. The new user receipt retains the old receipt as private migration evidence; the backup also retains old configuration context.

Apply stages the user registration and project-bound enrollment. **Both SDK health and actual `agy mcp list` must pass before the old owned entry is removed.** Unrelated old/new servers and settings are merged/restored. A failed SDK startup or native inventory check retains the old configuration and pending migration state. Rerun setup to re-verify and finish; uninstall of a pending user migration restores the original enrollment/receipt while removing the staged global entry. Registry and memory are retained.

Legacy router cleanup is conservative: read-only reused routers are not removed; owned legacy routers are retained when another managed provider receipt is active. That retention is recorded in private migration evidence. No shared directory or unrelated skill is removed. Existing old-schema databases still require the separate owner-approved migration digest workflow; this remediation adds no schema migration beyond the staged schema 12 baseline.

## H. Native Discovery Evidence

The opt-in real-native test now distinguishes supported user discovery from deliberate project refusal. Its project case does **not** count as successful project discovery. It asserts refusal/purity rather than hiding the upstream limitation.

`AGENTMIND_ANTIGRAVITY_EXECUTABLE=/Users/jethro/.local/bin/agy node node_modules/vitest/vitest.mjs run tests/integration/antigravity-native.test.ts --maxWorkers=1`: **2 passed / 0 failed / 0 skipped**, 4.51 seconds. One verifies project refusal/purity; one verifies real user inventory plus repeat/uninstall/retention. This is not a claim of successful native project discovery.

An independent real-`agy` migration probe in a disposable Git project also passed: old owned standalone registration -> explicit user setup, actual inventory recognition, SDK/SQLite/FTS health, unchanged project identity/database, repeat SKIP, foreign-project enrollment denial, preserved unrelated servers, successful uninstall and retained memory sentinel. Exact commands/results and retained fixture path are in the evidence ledger. No authenticated model ran.

## I. npm Bin Normalization

Before:

```json
{"bin":{"agentmind":"./dist/runtime/packages/mcp-server/dist/agentmind.js"}}
```

After:

```json
{"bin":{"agentmind":"dist/runtime/packages/mcp-server/dist/agentmind.js"}}
```

Actual npm 11.20.0's fix/prepare pipeline retains this canonical bin field with no bin-normalization change/warning. The initial leading-dot warning did not actually remove the field, as verified in the installed npm implementation and before/fixed/prepared objects. Do not generalize this observation to every npm version.

The developer-only `scripts/verify-npm-artifact.mjs` uses isolated HOME/config/cache/prefix, pack dry-run, actual pack, tarball extraction, actual npm normalization, **publish --dry-run --ignore-scripts**, installation of the exact tested archive, offline npm exec and npx. No publish credential or auth token is supplied. npm's missing-login dry-run warning is expected, not a publication failure. Installation stderr/warnings are retained rather than discarded.

## J. Installed Package Verification

Final artifact smoke: **PASS**, npm 11.20.0, candidate 1.1.1. The installed Vitest test passed (1/1) using actual Antigravity discovery. Global executable: `/private/tmp/agentmind-global-AO9VE9/prefix/bin/agentmind`. Retained prefix/cache/evidence: `/private/tmp/agentmind-global-AO9VE9`. `--help`, `--version`, npm exec and npx all executed successfully outside the repository; bin mode 0755 and Node shebang checked. Publish was dry-run only; normalization changes were `[]`. Fresh resolved runtime dependencies: `better-sqlite3@12.11.1`, `@modelcontextprotocol/sdk@1.32.2`, `zod@4.6.7`, `yaml@2.9.1`.

The global test starts the installed executable outside the checkout, with PATH containing Node/Git/provider executables and the installed bin, with no pnpm runtime resolution. It runs project-scope refusal, all-provider warning/setup, explicit Antigravity user setup, status, ordinary and connect doctor, repeat setup, repair/update preview, MCP calls through all four installed adapters and data-preserving uninstall. The actual `agy` executable is supplied for Antigravity discovery. SQLite binding removal and missing dependency scenarios also fail safely in the disposable installation.

This is fresh dependency/prefix verification on the developer host, **not clean-machine certification**. Source-workspace dependencies are not linked into the global package. Tarball imports remain package-relative; runtime modules/router/assets are included by the existing packaging pipeline.

## K. SQLite and MCP Health

The existing one-command driver/registry/schema/FTS setup is reused, not duplicated. Tests verify current schema 12, all five FTS indexes and the actual Node SQLite binding. Registry selection remains receipt-bound; protected registries are denied before config mutation and their bytes remain unchanged. No trusted skill approval/promotion/distribution or registry owner authorization is granted.

Direct stdio tests verify initialize/ping, exact 19 tools with input/output contracts, returned output schema validation, source `antigravity`, shared memory/experience/learning provenance, restart persistence, skill digest checks and foreign-project denial. Native configuration inventory remains a separate evidence layer from actual model-mediated MCP use.

## L. Gemini Coexistence

Codex/Claude/Gemini project setup retains existing behavior. Explicit Antigravity user registration uses its own config/receipt/router and the same authorized registry. Tests cover legacy Gemini config without its executable, independent Gemini/Antigravity setup/removal, shared-router retention, existing global registrations, cross-scope collisions and no automatic Gemini import. Actual four-adapter protocol sharing is verified; native model-to-model sharing remains NOT VERIFIED.

## M. Security Regression

Targeted/full tests include path/control/unsafe-executable checks; config/receipt/enrollment integrity; symlink rejection; moved project/registry mismatch; unowned/imported/plugin conflicts; dry-run purity; protected registry denial; cross-project memory/enrollment denial; direct hidden/privileged tool rejection; approved skill digest verification; shared-router update/removal and uninstall/rollback preservation.

The core authorization/enrollment loader, 19-tool profile, SEC-01 authority and BE-001 execution boundaries were not relaxed. Receipts remain operational ownership evidence, not OS authorization. Synthetic approved fixtures are test setup, not proof of real operator authentication. Protected deployment and executable behavioral sandbox verification remain NOT VERIFIED.

## N. Documentation Changes

README stays short and identifies explicit project-bound user registration. Installation/upgrade/maintainer guides describe current paths, unsupported project scope, CLI usage, migration/recovery, warning/exit behavior, shared-router constraints, unchanged Gemini behavior and native evidence levels. CHANGELOG records candidate 1.1.1 and the version decision. Historical 1.1.0/1.2.12 reports are not rewritten or inherited as current certification.

## O. Automated Tests

| Check | Final result |
| --- | --- |
| Lint | PASS: 350 files checked; one pre-existing informational template suggestion, no warnings/errors. |
| Typecheck/build | PASS. |
| Targeted installer/MCP/native/security set | 129 tests / 9 files passed. Later focused router/migration/security regression: 32 tests / 2 files passed. |
| Final full Vitest | **1366 passed / 0 failed / 3 skipped**, 1369 total, 112 files passed / 2 skipped; 276.54 seconds. |
| Conditional native cases | Separately **2 passed**, covering explicit refusal and actual user inventory. |
| Conditional installed-package case | Separately **1 passed**, actual native discovery and installed SQLite/MCP. |
| Architecture | PASS, exact frozen candidate matches, no violations. No core schema/MCP snapshot change required. |
| Documentation | PASS: 15 files, 56 local links, 22 shell blocks, 2 JSON blocks. |
| Generic MCP smoke | PASS. |
| Exact final artifact audit | PASS: 182 files, executable, allowlist/import/license/source-path/known-secret checks. |

The default suite deliberately skips the global-prefix test and two opt-in native cases; all three were exercised separately. No skipped native model scenario is declared verified.

Initial failures are retained separately in evidence: npm dry-run JSON was keyed by package name (verification harness corrected); one no-installed-CLI exit-category regression was fixed; a native migration probe initially used the wrong MemoryService result shape (harness fixed, then passed). No failed attempt is counted as final certification. Sandbox DNS/timeouts prompted host-permission reruns for npm dependency installation. Unix socket regressions also ran with host permission.

### Acceptance matrix

| # | Criterion | Status | Evidence/limit |
| --- | --- | --- | --- |
| 1 | Real native project discovery | FAIL / unsupported | Required project/plugin inventory never succeeded on measured CLI; current installer refuses this scope. Not disguised as a passing discovery test. |
| 2 | Real user discovery | PASS | Actual `agy` test, independent migration probe and installed tarball setup. |
| 3 | Official plugin schema | PASS | Minimal official manifest accepted by native CLI; no project activation inferred. |
| 4 | Project plugin installation | NOT VERIFIED | Not shipped; supported profile explicitly uses user registration. |
| 5 | Unrelated plugins preserved | PASS | No plugin writes; unrelated plugin fixture preserved, unowned agentmind plugin rejected. |
| 6 | Gemini compatibility | PASS | Existing regressions and independent config/protocol coexistence. |
| 7 | Legacy migration | PASS | Preview, successful cleanup after health/inventory, failure retention, rollback and preserved data. |
| 8 | Lifecycle | PASS | Supported user scope setup/status/doctor/repair/update/uninstall; unsupported scope explicitly refused. |
| 9 | Idempotency | PASS | Repeat SKIP and stable config timestamp. |
| 10 | Registry binding | PASS | Same project/database across migration; conflicting receipts rejected. |
| 11 | Enrollment security | PASS | Caller check unchanged, moved/foreign/link cases rejected. |
| 12 | 19 daily tools | PASS | Actual stdio adapters, including installed package. |
| 13 | Privileged denial | PASS | Direct hidden-tool calls fail; lifecycle unchanged. |
| 14 | Project isolation | PASS | Direct MCP and independent real-native migration probe's enrollment denial. |
| 15 | Bin normalization | PASS | Canonical before/packed/prepared fields retained; no bin normalization warning. |
| 16 | Executable exists | PASS | Exact packed entry and global command. |
| 17 | Shebang | PASS | Node shebang checked in tarball and installed file. |
| 18 | Mode | PASS | Packed/installed executable bits checked. |
| 19 | Global installation | PASS | Fresh disposable prefix, exact archive, no owner executable replacement. |
| 20 | --help | PASS | Global and npx outside repository. |
| 21 | --version | PASS | Global and npm exec return 1.1.1. |
| 22 | Outside checkout | PASS | Isolated project and PATH; no source dependency links. |
| 23 | Runtime assets | PASS | Antigravity modules, shared router and compiled MCP/core closure. |
| 24 | SQLite | PASS | Fresh installed binding, FTS and four-adapter memory workflow. |
| 25 | No runtime pnpm | PASS | Installed test PATH excludes pnpm/workspace modules. |
| 26 | README | PASS | Explicit scope, lifecycle flags and short supported workflow. |
| 27 | Installation guide | PASS | Supported paths/migration, unsupported project profile and evidence limits. |
| 28 | Version claims | PASS | Measured 1.4.10, no permanent minimum claim. |
| 29 | Commands | PASS | Supported user setup/status/doctor/repair/update/uninstall and warning/refusal behavior tested. |
| 30 | Targeted tests | PASS | Exact totals below and in evidence. |
| 31 | Full regression | PASS | 1366 passed / 0 failed / 3 default skips, all conditional cases separately exercised. |
| 32 | Security | PASS | Application-level targeted/full regression; SEC-01/BE-001 deployment not certified. |
| 33 | Artifact identity | PASS | Exact tested archive/hash and source state recorded. |
| 34 | Native model status | PASS | NOT VERIFIED; none invoked. |
| 35 | No publication | PASS | Dry-run only; no commit/push/tag/release. |

The remaining FAIL is the explicitly unsupported native project discovery profile. Reproduce in a disposable HOME/Git project: place `plugin.json` containing name/description plus `mcp_config.json` under `.agents/plugins/agentmind`, then run actual `agy plugin list --json` / `agy mcp list`. The measured CLI did not list project AgentMind MCP; standalone global config in the same HOME is the positive control. Current `agentmind setup --cli antigravity --apply` intentionally returns `ANTIGRAVITY_SCOPE_UNSUPPORTED`, and the supported replacement requires explicit `--scope user`. Do not claim that the source restriction fixes upstream native plugin discovery.

## P. Artifact Identity and Checksums

- Artifact: `dist/artifacts/P6-005D.1/jethrohawthorn-agentmind-1.1.1.tgz`.
- SHA-256: `354d2c10050eabcb541ada924af1cfb96f0ef211d1405da4534330a4662e688b`.
- npm integrity: `sha512-5ozWmn/J2W8VS8y8MtGfQJAfk6aRJlTV6dcjHaeqdjXUPm7Q6unkQl6y8VXbLQotdFlkBX9wik4UoedCnNf0VQ==`.
- Size: 265,054 bytes; unpacked 1,119,978 bytes; 182 files.
- Per-file manifest: `dist/artifacts/P6-005D.1/jethrohawthorn-agentmind-1.1.1.manifest.json`.
- Pack metadata, npm evidence, SHA256SUMS and exact expanded logs: `dist/artifacts/P6-005D.1/`.
- Owner staged-patch SHA-256: `689579b51765e40a4826956432d762819f97e06aceddf506f02225de84a42b8e` (unchanged).
- Full source revision: `7bfcc3f5ed2bc03c51ae8383023aa459e09515a7`; working tree is intentionally dirty with the preserved staged baseline plus remediation changes.

Old reviewed 1.1.0 certification and intermediate 1.1.1 attempts are stale for final bytes. Earlier local attempt directories/logs are retained separately; no published artifact was overwritten. Final source revision and dirty/staged state are recorded in the npm evidence; the owner's staged-patch hash is unchanged. Expanded exact logs and per-file packed hashes are retained with the final artifact.

29 files changed/added **by this remediation**, relative to the preserved index:

- `.gitignore`
- `CHANGELOG.md`
- `README.md`
- `contracts/README.md`
- `docs/reviews/P6-005D_1_EVIDENCE.json`
- `docs/reviews/P6-005D_1_REMEDIATION.md`
- `docs/v1/INSTALLATION.md`
- `docs/v1/MAINTAINERS.md`
- `docs/v1/UPGRADE.md`
- `package.json`
- `packages/mcp-server/src/agentmind-main.ts`
- `packages/mcp-server/src/antigravity/setup.ts`
- `packages/mcp-server/src/installer/adapter.ts`
- `packages/mcp-server/src/installer/doctor.ts`
- `packages/mcp-server/src/installer/model.ts`
- `packages/mcp-server/src/installer/service.ts`
- `packages/mcp-server/src/installer/setup.ts`
- `scripts/package-evidence.mjs`
- `scripts/verify-global-cli.mjs`
- `scripts/verify-npm-artifact.mjs`
- `tests/helpers/antigravity-legacy-fixture.ts`
- `tests/helpers/installer-fixture.ts`
- `tests/integration/antigravity-daily.test.ts`
- `tests/integration/antigravity-native.test.ts`
- `tests/integration/global-cli.test.ts`
- `tests/integration/setup-readiness.test.ts`
- `tests/unit/antigravity-setup.test.ts`
- `tests/unit/global-package.test.ts`
- `tests/unit/installer.test.ts`

## Q. Remaining Unverified Gates

- Native project/plugin discovery remains unsupported for this release.
- Native `agy` server launch cwd, connected initialize/tools, Router Skill use and memory/experience/learning through an authenticated model remain NOT VERIFIED. SDK health and inventory do not establish them.
- Authenticated cross-agent model workflows remain NOT VERIFIED; four-adapter protocol sharing passes.
- Independent security/release review, clean-host/platform/native dependency provenance, SEC-01 OS deployment and BE-001 executable sandbox evidence remain separate gates.

## R. Release Readiness Recommendation

The explicit user-registration supervised profile and npm executable are ready for review against the recorded artifact. **NO-GO for full native/project-plugin or authenticated-model claims.** Do not publish automatically or inherit historical certification. Any future project profile must independently establish native discovery and authorized process cwd without relaxing enrollment checks. No credentials, model authorization, publication, commit, push or tag are supplied by this remediation.
