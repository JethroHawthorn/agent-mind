# Installation and profiles

Primary workflow: obtain an independently reviewed source snapshot or local `agentmind-0.0.1` source archive, inspect its checksum using a trusted separately supplied value, extract into a new directory, then run `pnpm install --frozen-lockfile` and `pnpm build`. Package preparation does not publish or install anything. Keep the source directory available: managed commands reference its compiled adapters and current Node executable. Moving it requires a reviewed managed `update` plan.

## Prerequisites and platforms

| Component | Requirement | Current evidence |
| --- | --- | --- |
| OS/CPU | macOS arm64 prioritized | Development host and disposable fixtures; clean machine NOT VERIFIED |
| Node | Declared >=22.13.0 | Node 22.13.1 tested; later Node ABI support NOT VERIFIED |
| pnpm | 11.6.0, declared packageManager | Current workspace commands tested |
| SQLite | better-sqlite3 as pinned by lock; FTS5 | Native module/FTS5 tested on current host; no binary in source archive |
| Build tools | Python and C/C++ toolchain if native prebuilt unavailable | Native install may download a prebuilt or compile; no clean-host install claim |
| Native CLIs | Optional Codex/Claude/Gemini official executables | Adapter fixtures use public version/help contracts, not model authentication |
| Linux/Windows/Intel macOS | Not certified | No supported clean-machine claim |
| Protected operator | Distinct runner/operator/service authority, protected parents/WAL/SHM and peer-authenticated broker | NOT VERIFIED; not provisioned by setup |
| Behavioral sandbox | Qualified independently verified backend | No accepted executable backend; behavioral execution refused |

Disk/memory minima are not established. Packaging reports source/archive size; native dependency installation needs additional cache/build space. FTS5 is checked by actual runtime health/doctor, not inferred from SQLite being installed. Dependencies are locked but vulnerability intelligence and binary provenance remain separate checks.

## Install and inspect

Follow [quick start](QUICK_START.md). The built primary command is `node /absolute/source/packages/mcp-server/dist/agentmind.js`. The source alias `pnpm agentmind` works only in that workspace. No global bin or npm release is supplied.

Use `setup --cli PROVIDER --project-root ROOT --db ABSOLUTE_DB --dry-run --json`, launching inside the authorized root. A plan identifies operations, hashes, ownership/preconditions, backups and postconditions. Setup does not initialize SQLite. Status/ordinary doctor are read-only; `doctor --connect` explicitly starts enrolled MCP and **may initialize/migrate** SQLite. It is not an ordinary read-only diagnostic. Read [upgrade](UPGRADE.md) before starting new code on an old database.

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

No terminal prompt establishes OS identity separation. No `--unsafe` or weaker execution fallback is provided. Run status, ordinary doctor and database doctor; obtain separate authorized deployment/isolation/native evidence for advanced profiles. P6-004 clean-machine testing and independent review remain blockers for publication.
