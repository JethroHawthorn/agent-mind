# MCP release correction and compatibility

P6-005A is an internal release-blocker correction. Publication remains **NO-GO** pending independent review and renewed artifact acceptance. Package version remains 0.0.1 under the existing release policy. This work does not certify native model invocation, protected OS deployment or sandbox isolation.

## Tool surfaces

| Surface | Before | After | Policy |
| --- | ---: | ---: | --- |
| Generic default | 16 | 16 | Historical compatibility; owner-controlled startup |
| Generic all optional groups | 42 | 42 | Legacy plus explicit curator/learning/authoring/retrieval |
| Codex daily adapter | 38 | 19 | Existing shared DAILY_TOOLS enforced in the server |
| Claude daily adapter | 19 | 19 | Same server policy |
| Gemini daily adapter | 19 | 19 | Same server policy |
| Protected broker agent | 43 | 43 | Existing fixed nonprivileged operations, never operator methods |

There are 44 unique identifiers across static standalone tools, dynamic status and broker-only skill_evaluate. Static registration is not runtime exposure. The broker can narrow its software profile but cannot add authority. Genuine broker startup still requires protected configuration/peer authentication. In-memory broker tests verify protocol/application behavior only.

Disabled tools are omitted from tools/list and rejected by tools/call. Core project scope, package integrity and protected service authorization remain mandatory even when a tool is visible. MCP exposes no approval, promotion, protected rollback/distribution, restore, operator grant or trusted behavioral evidence writer.

## Schemas and outputs

The installed SDK serializes object roots; root Zod unions were incorrectly advertised as empty objects. Both skill_authoring_submit and legacy skill_get now use object schemas with exact conditional alternatives and unchanged strict core validation. All three authoring operations remain supported. Common fields and nested patch operations are factored once. File paths now advertise their existing safe relative-path constraint. Additional semantic checks, byte budgets, case-insensitive uniqueness, package scope and stale-state checks remain server-side.

All 19 daily tools have outputSchema and matching structuredContent. Existing JSON text is retained for older consumers. Known identity, trust, digest and pagination fields are checked before success is returned; additive fields are preserved. Errors have isError=true and a separate text error envelope; protocol validation errors remain SDK errors. No empty/null output schema is substituted for missing guarantees. The other 24 generic legacy/internal tools retain their historical output behavior.

Nested context/outcome objects remain required. Descriptions show the accepted form; no ambiguous success shorthand is normalized. Reported success is never independently verified success. The existing review_get bundle already includes authoring, validation/evaluation, lifecycle and evidence summary. Full diff and evidence pages remain progressive disclosures. Tool renaming, deletion, 44-to-16 redesign and a new combined review API are deferred to a separately reviewed compatibility milestone.

Legacy skill_get already classifies enabled telemetry as mutating, records best-effort observations synchronously, and tolerates observation errors. It is absent from daily profiles. Disabling telemetry makes it read-only. Broker skill_get does not record that observation. No telemetry was silently removed.

## Fresh measurements

Actual SDK stdio tools/list, synthetic provider executable doubles, isolated configuration roots, Node 22.13.1/macOS arm64. No authenticated native model was invoked. Serialization is UTF-8 JSON.stringify({tools}); estimated tokens are ceil(bytes/4), not tokenizer counts or billed usage.

| Surface | Tool-list bytes before | After | Estimated tokens before | After |
| --- | ---: | ---: | ---: | ---: |
| Generic default | 15,795 | 20,739 | 3,949 | 5,185 |
| Generic all | 37,995 | 65,286 | 9,499 | 16,322 |
| Codex | 34,844 | 45,709 | 8,711 | 11,428 |
| Claude | 18,146 | 45,709 | 4,537 | 11,428 |
| Gemini | 18,146 | 45,709 | 4,537 | 11,428 |

The actual expanded authoring schema was 6,447 bytes, not the audit's historical 22,167. The corrected runtime schema is 4,473 bytes; draft metadata differs slightly between expanded Zod and SDK output. A previously empty 33-byte input becoming meaningful is an intentional increase. Codex input schemas decrease from 22,950 to 16,490 bytes through filtering, but formal output contracts add 22,639 bytes to each daily list. Retaining text and structured output also increases wire response bytes. No overall model-token saving is claimed.

Reproduce offline measurements after building:

```sh
pnpm build
pnpm exec vitest run tests/integration/mcp-hardening.test.ts tests/integration/mcp-snapshot.test.ts tests/unit/mcp-telemetry.test.ts
pnpm architecture:check
```

Optional AGENTMIND_MCP_SNAPSHOT_OUTPUT and AGENTMIND_MCP_RESPONSE_OUTPUT accept a **new** report file path for the corresponding test. Files are created exclusively with mode 0600; no live registry or CLI configuration is used. Test output includes estimates, source-level evidence and actual protocol behavior, not independent security certification.

## Recertification

contracts/v1.json records the intentional correction: compact inputs, daily/broker output schemas, separate error envelope, Codex policy, and an explicit dependency on the already locked Zod version. No SQLite schema, immutable package format, core public input or lifecycle authority changed. Previous P6-004/P6-005 artifacts cannot certify the changed MCP claims. Rebuild the local source RC; rerun affected artifact MCP, native-adapter, authoring, retrieval, review, security, packaging and documentation tests; then obtain separate independent recertification. Real native provider calls require separate authorization. Protected OS and executable sandbox deployment remain NOT VERIFIED.
