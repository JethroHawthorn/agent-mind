# AgentMind — Phase 0

Persistent, project-scoped memory shared by local coding agents through an MCP stdio server. TypeScript, the official MCP SDK, SQLite/FTS5 (`better-sqlite3`), Zod and Vitest. AgentMind runs offline without cloud services or LLM API keys.

This implements the narrowly scoped Phase 0 request against the broader [architecture blueprint](docs/ARCHITECTURE_AND_ROADMAP.md). There are exactly two tools: `memory_save` and `memory_search`. No hooks, autonomous learning, skills, vector search, dashboard or Gemini integration. This is original code, not a Hermes fork.

## Install and check

Use Node.js 22.13+ and pnpm 11.6.0. Node 22.13.1/macOS arm64 was tested. The native SQLite driver uses a prebuilt binary where available; otherwise it needs Python and a C/C++ build toolchain. The workspace allows build scripts only for `better-sqlite3` and `esbuild`.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm smoke
pnpm check # all offline quality gates
```

`pnpm smoke` uses separate official SDK clients and server processes to save, restart, retrieve and check isolation. It uses disposable directories and needs no agent accounts. It does **not** exercise Codex or Claude Code.

From the AgentMind repository, set these variables in the terminal used below:

```sh
AGENTMIND_SERVER="$PWD/packages/mcp-server/dist/index.js"
PROJECT="$PWD" # or an absolute directory for the project you want to remember
AGENTMIND_DB="$PROJECT/.agentmind/memory.db"
cd "$PROJECT"
node "$AGENTMIND_SERVER" --project-root "$PROJECT" --db "$AGENTMIND_DB" --health
```

Health exits 0 and prints JSON to **stderr** after initializing/migrating and checking SQLite integrity and FTS5. The default database, when `--db` is omitted, is `~/.agentmind/agentmind.db`. Every client must use the same database path and canonical project root to share memories. Set an explicit writable database path in sandboxed environments.

To start the server directly:

```sh
node "$AGENTMIND_SERVER" --project-root "$PROJECT" --db "$AGENTMIND_DB"
```

It waits for MCP JSON-RPC on stdin. Stdout contains only protocol messages; logs go to stderr. Ctrl-C, SIGTERM or stdin EOF closes the transport and database. A two-second watchdog forces a nonzero exit if cleanup stalls or leaves active handles. Do not configure MCP to run `pnpm start` or `pnpm build`: package-manager output can corrupt stdout. Build first, then launch `node` directly.

`pnpm format` applies Biome formatting and safe lint fixes; `pnpm lint` rejects warnings as well as errors. These checks cover source, scripts, tests and JSON configuration, excluding generated output.

## Share across worktrees, clones or directory moves

Path-based isolation remains the default, including for repositories with identical Git remotes. To deliberately share memories between selected directories, generate a stable, non-secret project key once:

```sh
node -e 'console.log(require("node:crypto").randomUUID())'
```

Add `--project-key THE_SAME_GENERATED_KEY` to both clients' **trusted local launch configuration**, using the same absolute `--db` and each checkout's own `--project-root`. Keep the key when moving a project. For example, from inside each checkout:

```sh
node "$AGENTMIND_SERVER" --project-root "$PWD" --db "$AGENTMIND_DB" \
  --project-key THE_SAME_GENERATED_KEY --health
```

The returned `project_id` must match. Keys are 16–128 letters, digits, dots, underscores or hyphens, starting with a letter or digit. They are namespace selectors, **not secrets or authentication tokens**. Choose one only for directories you intentionally authorize to share; never derive authorization from a tool argument or automatically merge repositories by their remotes. Startup still verifies the working directory against the configured root.

An explicit key creates a separate namespace: it does not automatically reassign existing path-scoped records. Those records remain accessible by omitting the key at their original root. Configure a key before capturing memories that should survive directory moves. Schema version 2 preserves existing IDs, memories and FTS data while allowing separate namespaces at the same directory.

## Connect Codex CLI

Use your normal Codex login. AgentMind never reads or handles that authentication. For an isolated invocation without changing your saved MCP configuration, run from `$PROJECT`:

```sh
codex exec --skip-git-repo-check --ephemeral --ignore-user-config \
  -c 'mcp_servers.agentmind.command="node"' \
  -c "mcp_servers.agentmind.args=[\"$AGENTMIND_SERVER\",\"--project-root\",\"$PROJECT\",\"--db\",\"$AGENTMIND_DB\",\"--source-agent\",\"codex\"]" \
  'Call agentmind memory_save with title "Phase 0 decision", content "Orchid uses SQLite WAL for shared project memory.", and kind "decision". Report the returned memory ID. Do not edit files or use shell tools.'
```

These variable-based TOML arguments assume paths contain no double quotes or backslashes. For persistent interactive use, merge the following into the project's `.codex/config.toml`, replacing the absolute paths. Preserve existing configuration. Trust the project through Codex's normal workflow before relying on project configuration.

```toml
[mcp_servers.agentmind]
command = "node"
args = ["/absolute/agentmind/packages/mcp-server/dist/index.js", "--project-root", "/absolute/project", "--db", "/absolute/project/.agentmind/memory.db", "--source-agent", "codex"]
```

Start `codex` in that project and inspect `/mcp`. Keep the inherited project working directory; do not override the server's `cwd` to bypass the scope check. Avoid a globally registered server pinned to one project's memories. [Official Codex MCP setup](https://developers.openai.com/codex/mcp).

## Connect Claude Code and verify sharing

After the Codex command completes, its server process is gone. Start Claude Code from the **same** `$PROJECT` with the same database:

```sh
claude mcp add --transport stdio --scope local agentmind -- \
  node "$AGENTMIND_SERVER" --project-root "$PROJECT" \
  --db "$AGENTMIND_DB" --source-agent claude
claude
```

In Claude Code, inspect `/mcp`, then send:

> Call agentmind memory_search with query "Orchid WAL". Report the saved memory ID, content, source_agent and status. Use the tool result, not a guess. Do not save anything.

Confirm the ID matches Codex's save result, `source_agent` is `codex`, and `status` is `unverified`. Exit Claude Code and launch it again; repeat the search to verify restart persistence. Claude's local scope is private to your project configuration; `--scope project` instead creates a shareable `.mcp.json` if you intentionally want that. [Official Claude Code MCP setup](https://code.claude.com/docs/en/mcp).

To remove the local Claude registration:

```sh
claude mcp remove --scope local agentmind
```

For a manual isolation check, create a second directory and configure its server with that directory as `--project-root`, while keeping `--db` pointed at the original database. Search for `Orchid WAL` there: results must be empty. Attempting a tool call with `project_id`, `project_root` or `scope` must fail schema validation. Launching a server pinned to the original project from the second directory must fail with `PROJECT_SCOPE_DENIED`. The automated suite covers all these cases.

## Tool contract and boundaries

| Tool | Arguments | Result |
| --- | --- | --- |
| `memory_save` | `title` (1–200 characters), `content` (1–4000), optional `kind`: `fact` (default), `decision`, `preference` | `{ "memory": { "id", "project_id", "title", "content", "kind", "source_agent", "status", "created_at" } }` |
| `memory_search` | `query` (1–500 characters), optional integer `limit` (1–20; default 5) | `{ "memories": [...] }` |

Results are JSON encoded in MCP text content. Unknown fields are rejected. Search uses literal Unicode word tokens, AND matching, FTS5 ranking and a mandatory project filter; it does not expose SQL or FTS query syntax. Punctuation-only queries return no matches. MCP ping checks protocol liveness; `--health` checks storage. Handler failures return `isError: true` with a safe error code/message. Initialization failures exit nonzero without writing stdout.

- Default scope is SHA-256 of the startup-configured canonical absolute directory, with a versioned domain prefix. An optional trusted startup `--project-key` selects a stable shared namespace using a separate hash domain. Startup verifies the actual working directory is inside its configured root in either mode. The model cannot select or switch scope through tool arguments, MCP roots or its declared client identity.
- Without an explicit key, both clients must choose the **same root directory**. Subdirectories are permitted working directories; separately configured roots remain isolated. Symlink aliases resolve to the same scope. Git remotes never automatically authorize sharing.
- Trusted local launch configuration and OS access are the boundary. A local process that can change launch configuration or read the database can access it. This is not a sandbox or multi-user authorization system.
- `source_agent` comes from trusted startup configuration, not a tool argument. It is a local provenance label, not cryptographic proof of client identity. All records remain explicitly `unverified`; saving does not certify correctness.
- Only explicit summaries are saved. No files, transcripts, CLI credentials or environment secrets are collected. Common key/token/password/private-key formats, including Google and Stripe keys, and obvious role-prefixed transcripts are rejected before writing. Explicit documentation placeholders such as `Authorization: Bearer <TOKEN_PLACEHOLDER>` are allowed; real vendor keys are scanned even inside placeholders. This is best-effort detection: never submit secrets or transcripts, including unusual formats the detector may miss. Rejection errors and logs do not echo submitted content.
- New storage directories use mode 0700 and database files 0600 on POSIX; server umask is 0077 for sidecars. On Windows chmod is skipped. Filesystems returning EPERM, ENOTSUP, EOPNOTSUPP or ENOSYS for chmod produce a safe stderr warning and continue; OS ACLs/filesystem controls must protect access there. Other permission/I/O errors fail startup. Existing parent directory permissions remain under your control. Keep databases out of Git. No background telemetry or application network clients are implemented.
- SQLite uses WAL, a 5-second busy timeout, FULL synchronous commits, foreign keys, and transactional versioned migrations. Newer schema versions are refused. Concurrent processes may report a safe error if storage stays locked or unavailable.

## Verification status

Automated tests exercise real stdio transport using official SDK clients, durable saves, independent process retrieval, concurrent project isolation, validation, migration rollback, health and graceful shutdown. CLI versions detected: Codex **0.163.0**, Claude Code **2.1.310**. Their setup command syntax was checked against installed help and official documentation.

**Actual Codex-to-Claude tool calls have not been verified.** The independent review reports live Codex save/search calls and a blocked Claude proxy endpoint; the review's displayed save/search IDs differ, so those logs do not prove same-record handoff. During remediation the new live harness could not complete the Codex invocation in the restricted environment. No authentication settings or credentials were inspected or changed.

After normal native CLI login and connectivity work, run this opt-in live gate (it is excluded from `pnpm check`):

```sh
pnpm build
pnpm verify:cli
```

The harness launches real Codex and Claude processes using temporary MCP configuration and a disposable database. It requires a completed Codex `memory_save` tool result, then correlates Claude `memory_search` tool results with that exact memory ID/content across two separate Claude processes. Assistant prose alone cannot pass. It prints safe status JSON, bounds each native invocation to 30 seconds and returns nonzero if any gate fails. It does not modify saved MCP/auth configuration, read credentials, persist native output, or repair accounts/endpoints. Native CLIs retain their normal authentication, settings and connectivity requirements; they may use account quota. See [review remediation](docs/reviews/PHASE_0_REMEDIATION.md) for the remaining operational gate and [Phase 0 decisions](docs/PHASE_0_DECISIONS.md) for implementation details.
