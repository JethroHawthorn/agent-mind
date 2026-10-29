# Quick start — supervised local candidate

This source workflow uses existing commands, no paid model, no privileged approval and no sandbox execution. Read [installation](INSTALLATION.md) first. Commands run from the extracted source workspace; keep that directory in place after configuring adapters because enrollment pins its absolute Node and adapter paths.

```sh
pnpm install --frozen-lockfile
pnpm build
node packages/mcp-server/dist/agentmind.js --help
```

Create a **disposable** project for a first offline exercise. In the same shell:

```sh
REPO="$PWD"
DEMO="$(mktemp -d)"
PROJECT="$DEMO/project"
mkdir "$PROJECT"
cd "$PROJECT"
DB="$DEMO/registry.sqlite"
node "$REPO/packages/mcp-server/dist/agentmind.js" setup --project-root "$PROJECT" --db "$DB" --cli all --dry-run --json
node "$REPO/packages/mcp-server/dist/agentmind.js" status --project-root "$PROJECT" --db "$DB" --json
node "$REPO/packages/mcp-server/dist/agentmind.js" doctor --project-root "$PROJECT" --db "$DB" --json
```

Doctor can exit 7 when nothing is installed, or 2 for incomplete verification. That is not model authentication failure. Planning does not initialize the registry. If a supported CLI is installed, review its plan before explicitly applying it:

```sh
node "$REPO/packages/mcp-server/dist/agentmind.js" setup --project-root "$PROJECT" --db "$DB" --cli codex --apply --json
```

Replace `codex` with `claude` or `gemini` as appropriate. All three can enroll together with `--cli all`; missing/unsupported providers are reported, not installed. Hooks and AGENTS.md/CLAUDE.md/GEMINI.md are preserved. Setup does not approve registry skills.

To verify memory offline, the supplied SDK helper starts the actual MCP server, initializes/migrates this disposable database, performs one call and stops. This is **generic MCP**, not native agent use:

```sh
node "$REPO/scripts/mcp-call.mjs" "$PROJECT" "$DB" codex memory_save '{"kind":"fact","title":"Demo preference","content":"Use the synthetic local fixture."}'
node "$REPO/scripts/mcp-call.mjs" "$PROJECT" "$DB" claude memory_search '{"query":"synthetic"}'
node "$REPO/packages/mcp-server/dist/agentmind.js" memory list --project-root "$PROJECT" --db "$DB" --json
node "$REPO/packages/mcp-server/dist/skill-retrieve.js" --project-root "$PROJECT" --db "$DB" --initialize
node "$REPO/packages/mcp-server/dist/agentmind.js" skills search "sqlite retry" --project-root "$PROJECT" --db "$DB" --json
node "$REPO/packages/mcp-server/dist/agentmind.js" learning inbox --project-root "$PROJECT" --db "$DB" --json
node "$REPO/packages/mcp-server/dist/agentmind.js" proposals list --project-root "$PROJECT" --db "$DB" --json
```

The explicit `skill-retrieve.js --initialize` step creates derived retrieval indexes in this disposable registry. Read-only search never silently builds them. On an existing real registry, follow backup/upgrade preflight before initialization.

An empty skill/proposal list is expected in a new registry. Skills are loaded only after relevant compact cards are selected, with exact active version/digest pins. Selection and retrieval are not evidence of application or success. See [reference](REFERENCE.md) for opt-in learning/retrieval MCP and [security](SECURITY.md) before using real project data. All three agents share the same authorized registry; no additional provider API key is required by AgentMind.
