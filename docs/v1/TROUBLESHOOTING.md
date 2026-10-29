# Troubleshooting and removal

Use the installed `agentmind` executable (or an absolute built CLI path for source work) and launch inside the explicitly authorized project. Start with `status --json`, ordinary `doctor --json`, `db status --db PATH --json` and `evaluation status --json`. Ordinary diagnostics do not invoke models. `doctor --connect` is opt-in runtime work and may migrate; use [backup/preflight](UPGRADE.md) first on older registries.

| Symptom | Safe next step |
| --- | --- |
| Unsupported Node/native SQLite ABI | Use the declared runtime and lockfile; inspect native build prerequisites; do not bypass dependency builds with fake SQLite |
| CLI missing/unsupported | Install/update the official CLI separately; inspect version/help only; partial integrations may operate independently |
| MCP not responding | Build source; verify Node and adapter absolute paths. Use direct Node stdio, not package-manager stdout. Explicit offline connect only after backup |
| Router not discovered | Inspect managed path and duplicate discovery paths; dry-run repair. Actual model discovery remains separate evidence |
| Project mismatch | Launch from canonical authorized root; use the same DB; inspect worktree/nested repo scope. Do not forge project IDs |
| Database locked | Stop competing writers/long readers; bounded retry can fail; no infinite retry or unsafe reset |
| Future schema / interrupted migration | Stop old binary; read migration plan and ledger; preserve original. Restore only a verified bundle to a new offline file |
| FTS missing/stale | Database index status, deep doctor, then explicit index rebuild preview; never infer approval from FTS rows |
| Invalid backup | Stop restore; verify trusted checksum, schema and package references; do not edit manifest to force success |
| Broker unavailable / same UID | Protected operation unavailable; no terminal/PTY/env bypass; operator deployment needs separate authorization |
| Sandbox unavailable | NOT VERIFIED refusal is expected; no host-script fallback |
| Distribution incomplete | Inspect `distribution history SKILL_UUID` and `recover SKILL_UUID --dry-run`; no approval is created by recovery |
| Corrupt package | Deny retrieval/publication; preserve evidence; investigate canonical immutable bytes, not cached cards |
| User-owned config or router conflict | Preserve files and resolve manually; repair must not silently adopt them |
| Partial install / stale lock | Inspect private provider/unified journals and running installer. Never automatically remove a live lock or undo user edits |
| JSON contains NOT_VERIFIED | Installed/configured is not authenticated/native/OS/sandbox evidence; follow exact gate prerequisites |
| Socket EPERM in broker tests | Record environment restriction; rerun in an authorized environment; do not remove peer authentication or skip tests to claim protection |

## Removal and reinstall

Preview `uninstall --cli PROVIDER --project-root ROOT --db PATH --dry-run --json`, then explicitly `--apply`. For shared Codex/Gemini router conflicts follow the reported dependency order or uninstall all managed integrations. Unrelated MCP entries, native skills, hooks, instructions and credentials must remain. Registry, experiences, signals, candidates, active/history/evidence/audit and backups remain; this operation is not data deletion. Edited managed files conflict and remain for human resolution. Reinstall uses the same explicit DB path; no new registry is required.

Do not uninstall or alter real protected OS services with these commands. No privileged service was installed by the ordinary installer. Operator provisioning/removal requires a separately authorized runbook preserving knowledge and audit. No `sudo`, recursive delete, authentication reset or disabled sandbox is recommended as a troubleshooting shortcut.

## Setup readiness failures

Setup JSON identifies the failed stage and sanitized code. Missing driver/binding or ABI mismatch requires reinstalling dependencies for the intended Node runtime; no system sqlite3 package is required. A locked registry must be inspected after other writers finish. A corrupt/newer/unknown schema is preserved, never replaced. An existing old or empty registry requires explicit owner migration planning/digest approval. Missing/damaged FTS indexes require reviewed index maintenance; setup never rebuilds them silently. Protected registries require the separate authorized broker workflow.

If configuration succeeds but MCP health fails, `applied` may be true while `ready` is false and exit is 7. Keep the registry and owned files. Inspect the pinned Node/adapter paths, enrollment binding and doctor output; repair the cause and rerun setup preview/apply. A missing provider is reported separately as SKIP; it is not a native authentication test. No successful installer check proves model discovery/use or protected deployment.
