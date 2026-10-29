# V1 architecture candidate contracts

`v1.json` is a reviewed baseline candidate, not authorization to release or approve a skill.

```
pnpm architecture:check
pnpm test:architecture
```

The check builds existing packages, analyzes TypeScript dependencies, and introspects a real MCP server with **disposable** storage. No provider/model, live registry, authentication, sandbox or privileged service is invoked. Default inspection never rewrites the freeze file. The tests also exercise actual local test-PTY grants against simulated protected-registry markers. These are application-policy tests, not OS separation evidence.

The snapshot freezes the current core export names, representable exported Zod input schemas, 42 generic MCP tools/input schemas/annotations, the shared daily allowlist, protected agent allowlist/schema source, 28 literal `parseArgs` option surfaces, package/evaluation/distribution format sources, schema version 11, package manifests, dependency lock, workspace policy, release boundary report, runtime dependency list and known runtime cycles. Custom refinements are not all expressible in JSON Schema; existing runtime security/lifecycle tests remain mandatory. The daily tools expose formal object output schemas and matching structuredContent to all 19 daily tools (18 core tools plus dynamic status). The 24 other generic legacy/internal tools retain text envelopes and no output schema. The snapshot also captures the broker agent tools through an in-memory SDK transport, daily output contracts and the separate error envelope. Custom value refinements still require runtime validation. Existing text JSON remains compatible.

The sole runtime cycle is errors ↔ privacy: function bodies reference the other module after initialization; no cross-module top-level invocation occurs. Experience ↔ context has a type-only reverse edge. New runtime cycles or changed public contracts fail the check. This is a static declaration graph, not a proof of arbitrary runtime behavior or transitive dependency security.

`node scripts/architecture.mjs --write-freeze` explicitly writes a new candidate **only to this repository's fixed contract file**. Use it after an architecture/security/compatibility review, then inspect the diff, run relevant benchmarks and full regressions, and record the decision. Never refresh a snapshot merely to turn CI green. Security fixes, release-blocking bug fixes, test/documentation corrections and reviewed compatibility fixes are permitted after candidate freeze. New features, renamed public fields, schema downgrades, weaker approval policy and implicit model/service enablement are outside V1 freeze scope.

The local owner SDK and experimental legacy terminal workflows remain trusted-code interfaces, not agent-facing privilege boundaries. Normal V1 agent tools expose no approval/promotion/distribution administration. A broker-marked connection requires broker-issued authority at grant consumption, even if the marker appeared after review. Actual protected deployment, native model workflow, clean-host installation and executable sandbox assurance remain NOT VERIFIED. See the [security guide](../docs/v1/SECURITY.md) and [maintainer guide](../docs/v1/MAINTAINERS.md) for verification limits and release requirements.

Checksums and snapshots are not operator signatures or protection against a repository owner replacing code/tests. Independent review and the existing OS authority boundary remain necessary. No tag or publication is authorized by a passing check.

## MCP compatibility

The two root-union MCP inputs were advertised as empty objects by SDK normalization. Transport object schemas now factor common fields and express exact operation alternatives with `oneOf`; original strict core union validation remains authoritative. No operation names, core inputs, package identities or SQLite schema changed. Codex now enforces the existing 19-tool daily profile server-side, matching Claude/Gemini. Hidden tools are disabled for direct calls too. An explicitly empty profile also suppresses dynamic status.

This is a justified release-blocker correction to the freeze candidate, not silent compatibility certification. Additive structured output may increase wire size. A direct dependency on the existing locked Zod version supports the transport schemas; no dependency version was upgraded. Earlier artifact verification does not cover changed inputs, outputs or adapter surfaces. Rebuild, repeat affected artifact acceptance and request independent recertification. No release is authorized.

The public agentmind entry dynamically loads the existing handlers in agentmind-main, allowing missing runtime dependencies to fail safely before setup. The frozen CLI option definitions are unchanged; only their source path and two literal, code-owned dynamic imports are recorded. No core exports, MCP schemas, migration checksums, database version or protected authority contract changed. Setup orchestration and packaging require new exact-artifact recertification.
