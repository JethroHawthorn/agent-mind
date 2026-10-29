# CLI, MCP and daily workflow reference

Run `node packages/mcp-server/dist/agentmind.js --help` for the actual combined help. Run from the authorized project directory using an absolute CLI path if outside the source workspace. `--project-root ROOT --db ABSOLUTE_DB --json` selects the same trusted project/registry across integrations. Caller-supplied project IDs are not accepted as authority.

| Family | Commands | Authority / effects |
| --- | --- | --- |
| Enrollment | `setup`, `update`, `repair`, `uninstall` | Default preview; `--apply` mutates only managed integration files |
| Inspection | `status`, `doctor` | Read-only by default; `doctor --connect` starts MCP and may migrate; never automatically use `--native --allow-model` |
| Memory | `memory list`, `search QUERY`, `show ID` | Scoped read; bounded pagination |
| Experiences | `experience list`, `search QUERY`, `show ID` | Source/session/outcome provenance, reported does not imply verified |
| Skills | `skills list`, `search QUERY`, `show ID`, `versions ID`, `diff ID --from UUID --to UUID` | Approved/active discovery; historical visibility follows policy; digest-bound integrity |
| Resources | `skills resources ID`, `skills resource ID --path MEMBER` | Bounded package paths, no arbitrary filesystem |
| Learning | `learning inbox`, `show ID`, `evidence ID` | Structured evidence, no raw transcript requirement |
| Proposals | `proposals list`, `show ID`, `diff ID`, `evidence ID`, `evaluation ID` | Exact candidate/base digests, static versus behavioral status |
| Advisory review | `review ID`, `review defer ID`, `review dismiss ID`, `review handoff ID` | Decision options require exact snapshot/candidate digest; `--apply` only advisory; stale decisions rejected |
| Activity | `activity --agent codex\|claude\|gemini` | Suggested/selected/retrieved/observed trust categories, no fabricated effectiveness |
| Evaluation | `evaluation status`, `doctor`, `plan`, `show`, `evidence` | Use `evaluation --help` for required candidate/run flags; no executable sandbox available |
| Distribution | `distribution status`, `history`, `plan`, `verify`, `recover`, `rollback` | Use `distribution --help`; read-only planning distinct from protected lifecycle; no agent mutation shortcut |
| Database | `db status`, `doctor`, `migrate`, `backup`, `verify-backup`, `restore`, `index status`, `index rebuild`, `checkpoint` | [Upgrade policy](UPGRADE.md); no arbitrary SQL or protected maintenance |

Listings support `--limit` and `--offset`; immutable IDs and deterministic tie-breaking remain canonical. Empty results are not proof no relevant knowledge exists. JSON has stable canonical fields/no ANSI or mixed prose; exact tool inputs are in the freeze snapshot, not guessed from this table. `--full` does not disable output bounds. Diff/resource pagination can be incomplete: follow continuation indicators.

Integration exit codes: 0 success; 2 warning/incomplete; 3 conflict; 4 invalid arguments; 5 missing dependency; 6 permission; 7 verification failure; 1 unexpected failure. Database help lists its error classes; runtime verification failures can exit 7. Doctor NOT_VERIFIED is not PASS. Read command JSON/errors and exit code together.

## MCP

Run `node packages/mcp-server/dist/index.js --help` for startup flags. Configure **Node directly**, never `pnpm build/start` as a stdio transport because package-manager stdout corrupts protocol. Startup verifies working directory/project, opens the selected database, and may migrate it. Health prints diagnostics on stderr; normal stdout is protocol only.

The generic tool/input/annotation inventory is frozen in [v1.json](../../contracts/v1.json) under `mcp`; use the actual key inventory rather than inventing tool names. It records 42 tools with all optional groups enabled, not 42 default tools. All 19 daily tools declare object output schemas and return identical JSON in text and structuredContent. Errors retain separate isError/text envelopes. The 24 other generic legacy/internal tools retain their historical text contracts. All three native adapters enforce the same 19-tool server-side daily allowlist; direct calls to disabled tools are denied. Protected agent transport retains its fixed 43-operation boundary. See [freeze scope](../../contracts/README.md).

Default memory tool examples:

```json
{"name":"memory_save","arguments":{"kind":"fact","title":"Demo preference","content":"Use synthetic fixtures."}}
```

```json
{"name":"memory_search","arguments":{"query":"synthetic","limit":5}}
```

`experience_record` / `experience_search` preserve provenance; use the frozen input schemas for required fields. `--enable-learning`, `--enable-authoring` and `--enable-retrieval` opt in to the related groups. Proposals are immutable and unapproved. Discovery returns compact cards, semantic selection stays with the current agent, and pinned `skill_load`/resource disclosure rechecks current authorization and package bytes. It never authorizes promotion or executes skill content. No extra paid model or embedding key is needed.

## Shared lifecycle

Memory/experience → learning signal → immutable CREATE_NEW/PATCH_EXISTING/REWRITE_EXISTING proposal → static validation/evaluation → advisory queue → protected approval if deployed → active version → approved retrieval/distribution. Review recommendation, static PASS, model selection and evaluation text never replace operator authority. Core query/ranking/state semantics remain unchanged in this milestone.

## MCP profiles and compatibility

Generic standalone defaults to 16 historical tools. Owner-selected feature groups expose up to 42, including explicit curator maintenance; this compatibility surface is not the native daily profile. The broker agent transport exposes only its fixed nonprivileged allowlist; selecting a subset cannot add operator operations. Approval, promotion, protected rollback/distribution, restore and trusted evidence administration remain outside agent MCP. Removing discovery entries alone is not authorization: core services and the broker remain responsible for scope and authority.

`skill_authoring_submit` remains one tool with CREATE_NEW/PATCH_EXISTING/REWRITE_EXISTING and exact context/base digest binding. Its meaningful compact schema expresses operation-specific required and forbidden fields. Runtime checks additionally enforce package bytes, path uniqueness, payload budgets, scope and freshness; a valid JSON Schema instance is not authorization.

Nested inputs remain structured. Example values: `experience_record.outcome` is `{"status":"failed","summary":"Reported test failure; not independent verification."}`; `skill_route.context` is `{"summary":"SQLite startup retry handling"}`. Strings such as `"success"` are rejected and never become verified outcomes.

Use `review_get` for an existing compact inspection bundle: authoring, lifecycle, evaluation/validation, evidence summary and history. Fetch selected diff/evidence pages only when needed. Broad API consolidation is deferred. Legacy `skill_get` is hidden in daily profiles; ordinary compatibility mode records best-effort usage synchronously when telemetry is enabled and advertises readOnlyHint=false. Disable telemetry explicitly for a pure read. Broker `skill_get` performs no observation write. `skill_load` is the daily exact-version replacement.

See [MCP hardening evidence](MCP_HARDENING.md) for recertification requirements and reproducible offline measurements.
