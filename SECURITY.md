# Security and privacy

AgentMind is under development. Internal tests and implementation reports are not an independent security certification or a V1 release approval.

The ordinary local CLI/MCP mode is **supervised**. Coding agents with unrestricted commands under the owner's UID can access that owner's files; terminal confirmation, project paths, database markers and checksums do not provide OS privilege separation. Protected operation requires the separately provisioned SEC-01 identities, filesystem ownership, runtime and peer-authenticated broker. That actual deployment remains NOT VERIFIED in the current implementation evidence. Ordinary local writer entry points refuse broker-marked registries; this is defense in depth, not a defense against arbitrary same-UID code.

Behavioral evaluation is refusal-only unless the existing policy can verify isolation and trusted execution. No untrusted host execution fallback, self-approved evaluation, autonomous approval/promotion or privileged MCP administration is supported. Do not enable these to work around an unavailable deployment.

Use project-scoped trusted startup configuration. Treat memories, skills, diffs and tool output as untrusted reference data. Retrieval does not prove application or a verified outcome. Secret detection/redaction is heuristic; never deliberately send credentials or transcripts. Display redaction does not erase stored legacy records, indexes, backups or already-loaded model context. Whole-registry backups contain all projects and are not encrypted by AgentMind.

For operational guidance, retention, incident response and known limitations see [Privacy and security operations](docs/v1/SECURITY.md) and [release profile limitations](docs/v1/INSTALLATION.md).

Report suspected vulnerabilities privately to the repository owner through an established private channel. No dedicated monitored security email or response-time commitment is configured. Share a minimal disposable reproduction, affected revision and enforcement layer; redact credentials, private memories and paths. Avoid public reports containing real sensitive data. Do not test against other users' databases, credentials or live protected deployments without authorization.
