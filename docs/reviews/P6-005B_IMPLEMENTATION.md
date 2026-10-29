# P6-005B — Global CLI packaging and README simplification

## A. Executive Summary

The existing CLI is packaged as a global `agentmind` executable. A real npm tarball was installed with fresh npm dependencies into an isolated prefix on macOS arm64 / Node 22.13.1. Installed commands ran outside the checkout with a PATH containing Node, Git, provider doubles and the installed bin; pnpm and workspace node_modules were absent from runtime resolution. All three generated provider configurations started actual installed MCP adapters and persisted/searched memory. The README now leads with purpose, installation and setup.

This is an unpublished 1.0.0 candidate. Public licensing, registry ownership, independent exact-artifact review, clean supported-host acceptance and native/OS/sandbox profile verification remain blockers. No commit, push, publication, tag or release was performed. Artifact identity and exact final results are recorded below and in P6-005B_EVIDENCE.json.

## B. Existing CLI Architecture

Inspection covered root/workspace manifests, pnpm workspace and lock, both TypeScript configurations, all CLI entrypoints and existing bin declarations (none), installer/detection/provider configuration/adapter code, native probe scripts, MCP runtime, router, core migrations and schemas, README/install/maintainer guides, P6-003/P6-004 implementation/review evidence and P6-005A implementation/MCP hardening notes.

`pnpm agentmind` resolves the root script `node packages/mcp-server/dist/agentmind.js`. That file compiles from `packages/mcp-server/src/agentmind.ts`. Its dispatchers implement installation, knowledge, learning/review, evaluation, distribution and database commands. The MCP-server package imports `@agentmind/core` through `workspace:*`; core's schema/migration assets are TypeScript modules compiled into JavaScript. Both workspace packages remain private and retain their names. There is no `packages/cli`.

## C. Chosen Package Owner

The root package already owns the intended distribution name `agentmind` and the existing command alias, so it owns the distribution manifest/bin. Implementation ownership remains in the MCP-server package. Renaming that package would break workspace filters and imply a separately published core dependency. A root distribution wrapper avoids those changes and a duplicate command implementation.

## D. Executable Entry Point

Root bin: `agentmind` → `./dist/runtime/packages/mcp-server/dist/agentmind.js`. The existing `#!/usr/bin/env node` is retained and the artifact mode is 0755. `--version` reads package-relative metadata, emitting only `1.0.0\n`; ordinary command dispatch/error formatting and exit codes are unchanged. Help uses `agentmind`, including the daily dispatcher, without requiring pnpm. Existing handlers are reused.

## E. Monorepo Packaging Strategy

`npm pack` invokes `prepack` → `npm run build:cli` → `node scripts/package-cli.mjs --build`. This calls the existing TypeScript compiler/configurations directly, without invoking pnpm. It assembles the two compiled modules beneath `dist/runtime/packages/*/dist`, copies the router and native probe helper closure, and rewrites only literal internal core imports to relative compiled module paths. There is no JavaScript bundler or native binary bundling.

External npm dependencies are declared at the root. No workspace, link or local-file runtime dependency is shipped. The explicit npm files allowlist excludes source code, workspace node_modules, local configuration, databases, source maps and development native binaries. Declarations/maps are excluded from the runtime tree. The root production-dependency additions change only lockfile importer metadata; resolved workspace dependency versions remain unchanged. Only the corresponding `lockfile_sha256` field changed in the contract candidate; no MCP/core/schema/CLI option freeze was regenerated.

Trade-off: small assembly/import rewriting code must be tested. Benefits: no added bundler, no separate core publication, original runtime layouts retained, normal npm native SQLite installation. Dependency versions use existing supported ranges; fresh npm resolution is not frozen by the pnpm lock and needs independent supply-chain review.

## F. Runtime Dependencies and Assets

Production dependencies: `@modelcontextprotocol/sdk`, `better-sqlite3`, `zod`, `yaml`. Both compiled package trees, package version/type metadata, router skill and nine opt-in native probe/helper scripts are included. Router lookup still resolves three levels above the compiled MCP entry. Curator worker paths retain the original package layout. Migrations, configuration validators and output schemas are compiled modules, not missing external SQL files.

The protected native peer helper is not bundled. Existing protected deployment checks continue to require independently provisioned, verified runtime/ownership; global installation grants no authority. Native doctor uses the existing optional harnesses; its working directory now derives from the harness location so package assets resolve outside the checkout. No native model probe was run.

## G. MCP Server Resolution

Setup pins the real Node executable, absolute installed provider adapter, enrollment path, exact project and shared registry using existing receipt/ownership/configuration logic. Installed tests parse each generated Codex TOML, Claude `.mcp.json` and Gemini settings entry, assert executable/arguments, and launch those exact commands with the SDK stdio client. Initialization/list/call/shutdown and memory persistence/search succeed independently for all three. Agent-facing approval tools remain absent. Provider executable doubles test configuration contracts; they do not certify authenticated native agent discovery or skill use.

## H. SQLite Native Dependencies

The real driver is better-sqlite3. npm installs it as an external native dependency; AgentMind ships no platform-specific binding and no privileged installer. A prebuilt download may be attempted; Python and C/C++ build tools are needed if compilation is required. Actual installed MCP memory save/search and FTS5 work on the observed Node 22.13.1/macOS arm64 host with fresh npm dependencies, not copied developer bindings. Runtime declaration remains Node >=22.13.0. A separate direct probe reported SQLite 3.53.2 and FTS5 result count 1 under Node 22 ABI 127. The installed driver is better-sqlite3 12.11.1 (binding SHA-256 recorded in the ledger). An incidental shell selected Node 26.12.1 and correctly refused this Node-22-built binding with an ABI mismatch; rerunning under the installation interpreter passed. Changing Node majors requires reinstall/rebuild and reviewed enrollment updates. Clean Node 26 installation, other ABIs, Linux, Windows and Intel macOS remain unverified. No universal platform/prebuild guarantee is made.

## I. Local Global Installation

Maintainer commands:

```sh
mkdir -p dist/artifacts
npm pack --pack-destination dist/artifacts
node scripts/verify-global-cli.mjs
```

User artifact installation uses `npm install --global --prefix /tmp/agentmind-prefix ./agentmind-1.0.0.tgz` in an isolated prefix, then its `bin/agentmind`. The normal npm global command in README uses the same artifact/install mechanism with the user's configured prefix. No developer global prefix was modified.

The explicit smoke builds/packs, installs into a new temporary prefix/cache/HOME, checks that installation did not create integration configuration, then runs the installed integration suite. npm dependency lifecycle scripts may download/compile SQLite. AgentMind has no preinstall/install/postinstall/prepare hook. Setup requires its existing explicit apply consent.

## J. Clean-Environment Verification

Fresh prefix, fresh npm cache/config/HOME, no registry/config and no existing AgentMind dependency tree: tested on the developer host. Installed subprocesses have no NODE_PATH, no workspace symlinks and no runtime pnpm. Node, Git and provider doubles are explicitly supplied. Test orchestration itself uses the repository SDK/Vitest; the launched CLI/MCP resolve only their installed code/dependencies. This is disposable-environment artifact evidence, not clean-machine/VM/OS certification. No clean supported OS was available or provisioned.

## K. GitHub Installation Evaluation

Direct GitHub installation is explicitly unsupported. The source monorepo has no supported prepare contract for Git installs; installable compiled assets are generated by the maintainer prepack workflow and development tools are not runtime dependencies. A Git URL is not a supported replacement for the artifact. The repository field was derived from the existing Git remote. No public registry command is advertised as tested/available; a future authorized registry release is the intended ordinary channel.

## L. npm Publication Readiness

Name `agentmind`, version `1.0.0`, description, keywords, repository, bin, files, Node engine and runtime dependencies are declared. The user explicitly selected the new root 1.0.0 metadata, removal of private, shorter description and the files list containing runtime/README/SECURITY. `UNLICENSED` remains. Implementation workspace package metadata stays private 0.0.1 and is not separately published. No homepage or registry-name ownership is invented; no publishConfig is needed for local packing. Owner-approved license, V1 metadata review, package-name control, dependency/native provenance review and independent recertification remain required. Metadata preparation is not complete V1 publication readiness.

## M. README Rewrite

The README explains persistent knowledge across the three coding agents, session context loss, features, tested artifact installation, setup/doctor, proposal versus approval, real search/list/inbox/review syntax, data retention and platform limits. It links detailed docs and includes minimal contributor commands and the actual absence of a license grant. No encryption/cloud/autonomous approval/native certification claims are introduced. Registry installation is deferred rather than using a placeholder package or unverified command.

## N. CLI Help Consistency

Global help displays `agentmind`; daily usage no longer says `pnpm agentmind`. All command groups remain discoverable through combined help. New version output derives from package metadata in both workspace and packed layouts. No command is renamed and no unsupported install alias is introduced.

## O. Security and Privacy

No core authorization, project identity, SEC-01 grant, BE-001 sandbox, database migration, approval/promotion or installer ownership rule changed. Setup remains project-scoped by default; noninteractive mutations require apply. Status/ordinary doctor remain read-only/no-model; explicit connect may initialize/migrate and is documented. Uninstall preserves registry data. Generated config/enrollment tests use disposable roots. Dependency install is separate from explicit integration setup. Known-pattern artifact scans and allowlists are evidence, not exhaustive proof against every possible secret or supply-chain compromise.

## P. Regression Tests

New unit test checks bin/shebang/mode, root metadata/lifecycle hooks, runtime assets, declared externals, closed package-relative imports and absence of source maps/native/source paths. The explicit installed suite checks global command resolution without pnpm, no-config help/version, argument exit code 4, no-write dry-run, apply, all provider configurations and exact installed MCP commands, SQLite/FTS/memory persistence, status/ordinary and connect doctor, repair/update previews, knowledge/learning/review commands, advanced help, ordered uninstall and retained searchable data. It is intentionally opt-in during ordinary tests because it needs a real npm install; `node scripts/verify-global-cli.mjs` performs that installation and runs it.

Final command/results and initial failures are retained in the evidence ledger. Known restricted-host native broker socket failures are not hidden or treated as passing security certification. Earlier heavy-concurrency timeouts/installer failures and the intentionally changed lock digest were separately investigated; targeted tests pass after digest recording and controlled reruns.

## Q. Artifact Identity and Checksums

See `dist/artifacts/agentmind-1.0.0.tgz`, `dist/artifacts/agentmind-1.0.0.manifest.json`, `dist/artifacts/SHA256SUMS` and the tracked P6-005B_EVIDENCE.json ledger. The manifest records every npm file with mode, size and SHA-256, exact packed package metadata, npm integrity and host identity. `scripts/package-evidence.mjs` inspects bytes from the tarball, checks the allowlist, bin mode, unresolved dependencies, absolute checkout paths and known credential patterns. Checksums identify bytes; they are not signatures or release approval.

## R. Remaining Issues

Public distribution remains NO-GO: no license grant/owner publication authorization, no established npm name ownership, no clean supported-host certification or independently approved final artifact, no authenticated Codex/Claude/Gemini acceptance, no verified protected OS or executable sandbox backend. Existing P6-001 through P6-005 blocker records are preserved. Windows is not officially supported/verified here; npm shim generation on Windows was not tested. Native broker socket execution may fail in the restricted host. Fresh npm dependency ranges can resolve differently later.

## S. Independent Review Readiness

Review the source diff, exact tarball/manifest/checksum and regression ledger. Prior P6-003/P6-004/P6-005/P6-005A artifact certifications cannot certify changed executable paths, dependency layout, router/runtime packaging or README/install instructions. Repeat exact-artifact clean macOS installation, Node/native ABI matrix, authenticated provider setup/discovery/use, update/recovery/data retention and affected security/MCP/profile gates. No inherited blocker is closed merely by this software packaging evidence.

The acceptance matrix below scopes PASS to the stated layer; native or clean-OS assurance is never inferred from provider doubles or temporary HOME isolation.

## Artifact and validation summary

Final artifact identity is recorded in the adjacent evidence ledger and `dist/artifacts/agentmind-1.0.0.manifest.json`. The earlier private 0.0.1 candidate remains local historical evidence, not the final deliverable. The user explicitly confirmed the new 1.0.0 metadata during implementation. Source-archive tests now derive archive directory and effective version from current metadata instead of hardcoding 0.0.1; existing NO-GO, inconsistent-workspace-version and no-publication assertions remain intact.

The npm files list intentionally contains runtime, README and SECURITY; detailed documentation is linked in the repository and is not part of the selected runtime package. Source documentation links and shell/JSON blocks are checked. Existing historical V1 preparation documents describe earlier candidates; this report records the new npm artifact and required recertification.

| # | Acceptance criterion | Status | Evidence / limit |
| --- | --- | --- | --- |
| 1 | Existing CLI ownership identified | PASS | Root alias → existing mcp-server agentmind.ts |
| 2 | No duplicate CLI implementation | PASS | Same compiled entry and handlers; assembly only |
| 3 | Global executable works | PASS | Real npm prefix/bin symlink; installed runtime suite |
| 4 | Help works | PASS | Installed --help, no config needed |
| 5 | Version works | PASS | Installed version matches exact packed package metadata |
| 6 | Setup works | PASS | No-write dry-run and apply with disposable provider doubles |
| 7 | Status works | PASS | Installed CONFIGURED state |
| 8 | Doctor works | PASS | Installed ordinary/connect; exit 2 remains incomplete verification |
| 9 | Repair/update compatible | PASS | Installed dry-run plus 81-test controlled installer/release/architecture/daily rerun |
| 10 | Uninstall preserves data | PASS | All installed providers removed in safe order, 3 memories still searchable |
| 11 | Memory CLI works | PASS | Installed search after MCP saves; FTS5 |
| 12 | Skills CLI works | PASS | Installed list/search of empty available skill registry |
| 13 | Learning/review CLI works | PASS | Installed inbox/review/proposals/activity views |
| 14 | Advanced groups compatible | PASS | Installed help; existing regression coverage; no handlers changed |
| 15 | No source checkout dependency | PASS | Physical npm installation; no runtime NODE_PATH/workspace links |
| 16 | No runtime pnpm dependency | PASS | Installed process PATH excludes pnpm |
| 17 | Workspace dependencies resolved | PASS | Relative internal modules; normal external npm deps |
| 18 | Required runtime assets included | PASS | Retained candidate runtime import closure/router/worker/migrations/helpers; manifest audit |
| 19 | SQLite native binding works | PASS | Fresh npm dependency install; actual three-provider MCP saves/search |
| 20 | MCP startup works | PASS | SDK init/list/call/shutdown through all installed adapters |
| 21 | Codex config works | PASS | Exact generated TOML command/args launched; executable double, not native model |
| 22 | Claude config works | PASS | Exact generated MCP JSON command/args launched; executable double |
| 23 | Gemini config works | PASS | Exact generated settings command/args launched; executable double |
| 24 | Local tarball installation works | PASS | npm pack + real fresh-prefix global installation |
| 25 | Clean environment verified | NOT VERIFIED | Disposable prefix/cache/HOME passes; clean OS/VM unavailable |
| 26 | GitHub install supported/excluded | PASS | Explicitly excluded; source/Git prepare contract absent |
| 27 | Package metadata complete | FAIL | License/registry ownership/V1 approval and full runtime metadata recertification open |
| 28 | No credentials in artifact | PASS | Bounded claim: explicit allowlist and known-pattern/source-path scan; not exhaustive provenance certification |
| 29 | No unexpected install side effects | PASS | No AgentMind install lifecycle hooks; fresh install creates no integration config |
| 30 | Security boundaries preserved | PASS | Core/approval/sandbox unchanged; software security151 and installed hidden approval tool assertion; OS verification separate |
| 31 | README concise/understandable | PASS | 122 lines; user purpose/install/setup first, concise features and links |
| 32 | README installation accurate | PASS | Refers to final tested 1.0.0 tarball; does not advertise untested registry install |
| 33 | README quick start accurate | PASS | Installed setup dry-run/apply/ordinary doctor with provider doubles |
| 34 | README security claims accurate | PASS | Local-first/same-UID limits/no autonomous approval/NOT VERIFIED deployment |
| 35 | Help matches installed usage | PASS | Combined help has agentmind usage and version; installed suite |
| 36 | Documentation links valid | PASS | Source docs check15 files/47 links/20 shell blocks/2 JSON/0 errors; linked detailed docs remain in the source repository per selected npm files list |
| 37 | Full regression | FAIL | Final controlled full-suite outcome below; initial timing/metadata failures retained in ledger, resolved by targeted tests |
| 38 | RC recertification recorded | PASS | This report, artifact manifest and ledger mark affected prior certification stale |

Publication remains NO-GO. PASS scopes do not imply complete V1 acceptance or permission to publish. The metadata decision was explicitly confirmed by the user. Version-dependent tests now derive the current root version; no assertion of release authority was weakened.

### Final artifact

- File: `dist/artifacts/agentmind-1.0.0.tgz`
- SHA-256: `89e505aa03177c2e8cf1547b1ded8f5d7f8036b0c4720cca84d1d35261df5f1e`
- Packed size: 251,851 bytes; files: 173.
- npm manifest: `dist/artifacts/agentmind-1.0.0.manifest.json`.
- Global installation evidence: `/private/var/folders/0d/jyw7f9s96kq4bx_0291cd3m40000gn/T/agentmind-global-uV4fIk`.
- Actual fresh npm versions: SDK 1.32.2, better-sqlite3 12.11.1, Zod 4.6.7, YAML 2.9.1. These are not represented as frozen pnpm resolution.

### Final validation commands

| Command | Result |
| --- | --- |
| `pnpm lint` | PASS, existing informational useTemplate finding only |
| `pnpm typecheck` | PASS |
| `pnpm build` | PASS; also executed by final npm prepack and security checks |
| `pnpm docs:check` | PASS, 15 files, 47 links, no errors |
| `pnpm architecture:check` | PASS after recording intentional lock digest |
| `pnpm smoke` | PASS, cross-source-agent MCP persistence/project isolation |
| `pnpm test:security` | PASS, 151 tests on final 1.0.0 source |
| `pnpm exec vitest run tests/unit/rc-validation.test.ts tests/unit/release-final.test.ts tests/integration/release-readiness.test.ts tests/unit/global-package.test.ts --maxWorkers=2` | PASS, 30 tests after approved metadata update |
| `node scripts/verify-global-cli.mjs` | PASS, final 1.0.0 fresh npm installation and installed suite |
| `node scripts/package-evidence.mjs dist/artifacts/pack-1.0.0.json dist/artifacts/agentmind-1.0.0.tgz` | PASS, exact tarball scan/manifest/checksum |
| `pnpm acceptance` | FAIL release gate J; 34 offline scenarios PASS across two repetitions, eight NOT VERIFIED, zero scenario failures |
| `pnpm acceptance --repeat 1` | FAIL release gate J; 17 offline scenarios PASS, eight NOT VERIFIED, zero scenario failures |

Acceptance runs preceded the approved version-test update; their immutable evidence is retained. Gate J explicitly refuses release approval without independent clean/native/OS/sandbox evidence. No unavailable gate was converted to PASS. Full-suite final command/results are recorded below and in the evidence ledger.

### Full regression result and environment retry

`pnpm exec vitest run --maxWorkers=2` on the final 1.0.0 source: **1,290 passed, 6 failed, 1 skipped** across 109 files. All six failures are in `tests/integration/broker-native.test.ts`, reporting `BROKER_SOCKET_START_FAILED errno=1` under the restricted sandbox. The one skipped test is the explicit global installation suite; it passed separately against the freshly installed final artifact.

The exact affected suite was then rerun with approved sandbox escalation: `pnpm exec vitest run tests/integration/broker-native.test.ts --maxWorkers=1`: **10 passed**, zero failures. This confirms the socket restriction for these tests. The full-suite restricted command remains recorded as exit 1; no claim is made that an entire unrestricted run or clean-machine deployment was performed. Software security tests separately pass 151/151. The initial version-dependent failures were corrected following explicit user confirmation of 1.0.0, and all 30 targeted packaging/release tests pass.

Final changed files: root package.json/pnpm-lock.yaml and .gitignore; existing agentmind.ts/daily help/native probe working-directory resolution; three packaging/evidence/smoke scripts; new package/global installation tests; three version-dependent release tests; README, installation/maintainer docs, intentional lockfile digest field, this report and the evidence ledger. No workspace package rename, duplicated handler, database migration, core policy or router content change. No commits, pushes, tags, npm publication or GitHub releases.
