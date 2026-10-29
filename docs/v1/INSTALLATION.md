# Installation and profiles

The npm package is `@jethrohawthorn/agentmind`, and its global executable is `agentmind`. Install it with npm; no source checkout or pnpm is needed at runtime.

```sh
npm install --global @jethrohawthorn/agentmind
agentmind --help
agentmind --version
```

For a reviewed local version 1.1.1 artifact, use `npm install --global ./jethrohawthorn-agentmind-1.1.1.tgz`. For isolated prefix installation, use `npm install --global --prefix /tmp/agentmind-prefix ./jethrohawthorn-agentmind-1.1.1.tgz` and invoke `/tmp/agentmind-prefix/bin/agentmind`. The installation test uses a fresh temporary prefix/cache/HOME and installs dependencies through npm. This is developer-host artifact evidence, **not clean-machine certification**.

Direct GitHub installation is excluded: the private source monorepo requires development dependencies and a build, and has no supported Git preparation contract. Maintainers prepare the npm artifact as described in [maintainer guidance](MAINTAINERS.md).

Keep the installed prefix and Node executable available: managed enrollments pin their absolute paths. After moving/replacing either, inspect `agentmind update --dry-run` before applying compatible managed changes. Global npm installation never enrolls a project; only explicit setup changes integration configuration. SQLite's dependency install may download/compile its native binding.

## Antigravity CLI (`agy`)

AgentMind supports Antigravity through **explicit user registration with project-bound enrollment**. The registry and project authorization remain shared with Codex, Claude and legacy Gemini. No automatic Gemini migration or project-to-user fallback occurs.

```sh
agentmind setup --cli antigravity --scope user --dry-run
agentmind setup --cli antigravity --scope user --apply
agentmind status --cli antigravity --scope user
agentmind doctor --cli antigravity --scope user
agentmind doctor --cli antigravity --scope user --connect
agentmind repair --cli antigravity --scope user --dry-run
agentmind update --cli antigravity --scope user --dry-run
agentmind uninstall --cli antigravity --scope user --dry-run
```

Use `--antigravity /absolute/path/to/agy` for an explicit executable. Ordinary status/doctor only inspect files and public version information; no MCP or model starts. `--connect` explicitly checks the enrolled stdio adapter. Setup apply verifies SQLite, schema/FTS, SDK MCP health and the real `agy mcp list` inventory before reporting readiness. It never authenticates or invokes a model.

| Scope | MCP registration | Router Skill |
| --- | --- | --- |
| User (supported explicitly) | `~/.gemini/config/mcp_config.json` | `~/.gemini/antigravity-cli/skills/agentmind-router/SKILL.md` |
| Project | Unsupported for new setup; legacy `.agents/mcp_config.json` is inspected only for owned migration/removal | Legacy owned/shared router is preserved until safe cleanup |

The registration points to the installed absolute Node/adapter/enrollment paths with 19 server-side daily tools. It inherits caller cwd: another project cannot use it to impersonate the enrolled project. One global AgentMind entry supports one enrolled project; attempting another project or registry binding fails closed. Use the same `--scope user` for status, doctor and lifecycle commands. `--cli all` in project scope skips Antigravity with `USER_SCOPE_REQUIRED` and returns incomplete status (2) after configuring the other installed providers.

### Legacy project installation migration

For an AgentMind-owned standalone project entry, run the focused user-scope setup preview above. The plan labels `MIGRATE`, shows the new global registration and separately lists `post_health_operations` for old configuration removal. Explicit apply preserves registry/project binding, stores the old receipt/config in private recovery evidence, and stages the new registration. **Only after SDK health and native inventory verification succeed** is the exact old owned entry removed. Unrelated settings/servers remain. Unowned, edited, ambiguous or cross-project entries are conflicts, not adopted.

A verification failure leaves the old entry and private migration journal intact. Fix the reported issue and rerun focused setup; it re-verifies before cleanup. Uninstalling a pending migration removes the staged user registration and restores the old enrollment/receipt. Shared legacy routers are retained while other managed providers exist. Registry, memory and backups are never deleted. Existing pending database schema migrations still require a backup and the owner-approved digest workflow in [upgrade](UPGRADE.md).

### Plugins and current native evidence

The [official plugin guide](https://antigravity.google/docs/plugins) describes `plugin.json` and `mcp_config.json` inside `.agents/plugins/<name>/`; its CLI install command may stage local plugins globally. With the measured `agy 1.4.10` on 2026-10-29, neither standalone project MCP, project plugin files, nor explicit plugin path registration satisfied `agy mcp list`. Even an accepted globally staged plugin was absent from that MCP inventory, though plugin inventory listed it. AgentMind therefore does not install plugins or advertise verified project-plugin support. A pre-existing `agentmind` plugin is a conflict; unrelated plugins remain untouched.

Version 1.4.10 is host evidence, **not a permanent minimum version**. Historical 1.2.12 reports describe earlier measurements. The successful native tests cover user configuration inventory; direct SDK tests cover initialize/tools/calls/isolation. **NATIVE_ANTIGRAVITY_MODEL_EXECUTION: NOT VERIFIED**. Authenticated cross-agent model workflows, SEC-01 deployment and BE-001 execution remain NOT VERIFIED.

### Troubleshooting

- Missing `agy`: install the official CLI or provide its absolute path.
- Project scope refused: explicitly select `--cli antigravity --scope user`; no global file is written by the refused request.
- Malformed/edited config or pre-existing AgentMind plugin: preserve it and inspect ownership; no forced takeover is provided.
- MCP startup/discovery failure: inspect status, then run focused `doctor --scope user --connect`. Preserve the registry and pending migration journal; rerun setup after fixing the cause.
- Another project's global entry: resolve ownership in that original project before enrolling another one; never replace its receipt manually.

## Prerequisites and platforms

| Component | Requirement | Current evidence |
| --- | --- | --- |
| OS/CPU | macOS arm64 prioritized | Development host and disposable fixtures; clean machine NOT VERIFIED |
| Node | Declared >=22.13.0 | Node 22.13.1 tested; later Node ABI support NOT VERIFIED |
| pnpm | 11.6.0 for contributors only | Not required by installed runtime |
| SQLite | better-sqlite3 as pinned by lock; FTS5 | Native module/FTS5 tested on current host; no binary in source archive |
| Build tools | Python and C/C++ toolchain if native prebuilt unavailable | Native install may download a prebuilt or compile; no clean-host install claim |
| Native CLIs | Optional Codex/Claude/Gemini official executables | Adapter fixtures use public version/help contracts, not model authentication |
| Linux/Windows/Intel macOS | Not certified | No supported clean-machine claim |
| Protected operator | Distinct runner/operator/service authority, protected parents/WAL/SHM and peer-authenticated broker | NOT VERIFIED; not provisioned by setup |
| Behavioral sandbox | Qualified independently verified backend | No accepted executable backend; behavioral execution refused |

Disk/memory minima are not established. Packaging reports source/archive size; native dependency installation needs additional cache/build space. FTS5 is checked by actual runtime health/doctor, not inferred from SQLite being installed. Changing Node major versions requires reinstalling/rebuilding native dependencies for that ABI and reviewing pinned enrollment paths. Reusing a Node 22 SQLite binding under Node 26 fails with an ABI mismatch; this is not a verified Node 26 installation. Dependencies are locked in the contributor workspace, but a fresh npm artifact install resolves the declared production ranges. Vulnerability intelligence and binary provenance remain separate checks.

## Install and inspect

Use `agentmind` from the installed prefix inside your project. The source-only alias `pnpm agentmind` remains available to contributors. See the [quick start](QUICK_START.md) for detailed MCP examples; its explicit compiled paths are for source-workspace verification.

Use `setup --cli PROVIDER --project-root ROOT --db ABSOLUTE_DB --dry-run --json`, launching inside the authorized root. A plan identifies operations, hashes, ownership/preconditions, backups and postconditions. Setup preview does not initialize SQLite. `setup --apply` creates a missing supervised registry with the existing core initializer and verifies SQLite, schema/ledger, FTS5 and direct MCP health before reporting readiness. Existing pending schemas require explicit owner-approved migration; no protected-registry bypass or automatic index rebuild is added. Status/ordinary doctor are read-only; `doctor --connect` explicitly starts enrolled MCP and **may initialize/migrate** SQLite. It is not an ordinary read-only diagnostic. Read [upgrade](UPGRADE.md) before starting new code on an old database.

Apply only after inspection with `--apply`. Mutations are explicit in noninteractive shells. No silent project-to-user fallback. User scope must be requested; it remains project-pinned where supported. Codex user scope is unsupported. A missing CLI is not authentication failure; installation never logs in or extracts credentials.

## Provider-specific behavior

| Provider | Project artifacts | Scope and preservation |
| --- | --- | --- |
| Codex | Managed project TOML/enrollment and `.agents/skills/agentmind-router/SKILL.md` | Project only; unrelated TOML and AGENTS.md retained |
| Claude | `.mcp.json`, `.claude/skills/agentmind-router/SKILL.md`, enrollment | Project default; explicit user registration via official CLI. Unrelated hooks/settings and CLAUDE.md retained |
| Gemini | Project settings/enrollment, router or compatible reused `.agents` router | Project default; explicit user scope. Settings precedence/policy honored; GEMINI.md/auth/hooks untouched |

Exact artifact operations are authoritative in each generated plan; do not manually copy all registry skills into these directories. The small router handles compact cards, negative applicability, abstention, one bounded expansion and exact-version loading. Native reading activation is not protected version promotion. Hooks are preserved, not installed or required.

## Coexistence, ownership, repair and uninstall

`--cli all` uses one explicit registry; no per-provider knowledge store. Codex/Gemini can share the router read-only. Remove Gemini before updating/removing Codex when a dependency conflict is reported, then re-enroll Gemini. No forced deletion of the shared router.

Re-running setup on unchanged managed artifacts should SKIP. Edited/user-owned/foreign entries conflict; filename similarity is not adoption authority. Invalid config, symlinks, prior-digest changes and concurrent setup stop safely. Plans are process-local capabilities; editing JSON does not authorize apply. Per-provider journals and unified `.agentmind/installer/last-run.json` describe partial failures. Compensation is best effort, not filesystem ACID. Do not blindly delete a lock: first ensure no active installer and inspect journals.

`repair --dry-run` targets missing/outdated managed artifacts; `repair --apply` does not adopt user-owned files. `update --dry-run` previews compatible managed updates. `uninstall --cli all --dry-run`, then `--apply`, removes only unchanged managed integration artifacts. Registry, memories, proposals, approved versions, audit, backups and unrelated settings remain. Reinstall uses the same explicit database. No bulk data deletion command is added.

## Release profiles

| Profile | Prerequisites/features | Unavailable / current decision |
| --- | --- | --- |
| A Supervised local candidate | Local owner, source build, private SQLite; memory, learning, advisory review and approved retrieval | Candidate only, not released/certified. Same UID can bypass application controls. Legacy TTY lifecycle is experimental outside supported candidate |
| B Native integration | A plus official CLI, native authentication, authorized model verification | Offline config/SDK proof only; real native discovery/use NOT VERIFIED |
| C Protected operator | Separate OS identities, protected files/service and authenticated approval | NOT VERIFIED; no setup path provisions it |
| D Behavioral verified | Trusted suite/policy/collector plus verified sandbox | NOT VERIFIED; no execution backend; static PASS is not behavioral PASS |
| E Full protected | All native/OS/sandbox/distribution/privacy gates | NOT VERIFIED, not supported for production release |

No terminal prompt establishes OS identity separation. No `--unsafe` or weaker execution fallback is provided. Run status, ordinary doctor and database doctor; obtain separate authorized deployment/isolation/native evidence for advanced profiles. Clean-machine testing and independent review remain required before publication.

## Optional native probes

The npm runtime includes the existing opt-in native session harnesses and their helpers. They resolve runtime assets inside the installed package. They have not been run against authenticated providers here. Protected native peer binaries are excluded; deployment requires a separately built and verified helper. Ordinary doctor and explicit `doctor --connect` use the installed adapters. Protected deployment must supply its own verified runtime; global installation grants no operator authority.

## One-command supervised setup

`agentmind setup --cli all --apply` uses one receipt-bound registry: explicit `--db` when compatible with all receipts, otherwise the existing binding, otherwise `~/.agentmind/agentmind.db`. A conflicting explicit path or disagreeing receipts stops; setup never silently creates another registry. Project scope remains default. New registry directories/files use 0700/0600; existing unsafe ownership/permissions or aliases are refused, never recursively repaired.

Setup loads the actual better-sqlite3 driver, checks an in-memory query and FTS5 probe, previews registry ownership and provider changes, creates an absent registry exclusively, and applies the release-owned core bootstrap under its existing transactional/digest checks. The schema migration ledger is verified and the database reopened. Five actual FTS indexes undergo integrity checks in a rolled-back transaction. No real memory/skill probe records are inserted, and no index rebuild is performed. Empty skill registries can initialize the normal runtime retrieval metadata; a nonempty registry requiring that initialization stops for reviewed maintenance.

Every pre-existing pending schema, including an existing empty uninitialized file, stops for owner action. Use the existing `db migrate --dry-run` plan, backup/preflight and an explicitly approved schema digest as described in [upgrade](UPGRADE.md). Setup does not grant that authority. If a new bootstrap is interrupted before commit, retain the file and inspect it with the same owner workflow; do not delete it to obtain a fresh setup.

After database readiness, existing provider adapters apply their owned configuration plans. Each selected installed integration is then checked via the SDK: MCP initialize/ping, exact daily tool list, enrollment registry binding, project/source/schema health, bounded read-only routing and transport shutdown. These are direct MCP checks, not authenticated model calls. No provider authentication, native models, skill execution, approval or protected action is performed.

Preview uses a bounded read of the SQLite file header rather than opening a live connection. Header versions can lag a live WAL, so schema/ledger/index checks are explicitly deferred to apply. No database, WAL/SHM, migrations, configuration or MCP process is created by preview. The disposable driver/FTS probe is in memory.

JSON retains schema_version 1 with additive `ready`, `exit_code`, `registry`, `checks` and `providers` fields. `applied` means configuration was applied or revalidated; only `ready: true` establishes checked local readiness. Missing providers are SKIP/NOT_INSTALLED, not PASS. All selected integrations ready: exit 0. Installed subset ready with missing providers: exit 2. Conflict/owner migration action: 3; arguments/path: 4; dependency: 5; permission: 6; health/integrity failure: 7; unexpected internal failure: 1. Native/protected/sandbox verification remains separate.

A configuration or runtime failure preserves the database. Existing installer journals/compensation still govern configuration recovery. Rerun setup preview, inspect status/doctor and the private journals, resolve the reported cause, then apply. Do not delete a lock, database or user configuration to force success. Repeated healthy setup reuses the registry and unchanged receipts/configuration, without unnecessary schema migrations or journal rewrites.
