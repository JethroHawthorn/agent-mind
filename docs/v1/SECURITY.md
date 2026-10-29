# Security, privacy and retention

Local-first means AgentMind does not require a cloud service or additional inference API. Native coding CLIs have their own provider/network/authentication behavior; this is not a promise that a coding task stays offline. AgentMind never extracts their credentials. Package dependency installation may use network access; the offline acceptance harness does not.

## Authority boundaries

- Ordinary MCP: scoped reads and nonprivileged memory/experience/learning/candidate writes. No approval, promotion, protected rollback/distribution, arbitrary SQL, arbitrary file reader or shell executor.
- Daily CLI: inspect exact IDs/digests/evidence; defer/dismiss/recommend are advisory only and require fresh snapshots. No implicit activation.
- Protected operator: distinct OS runner, operator/service identity, protected executable/policy/database/parents/WAL/SHM, kernel peer identity and exact one-use grants. Actual deployment remains **NOT VERIFIED**. A terminal confirmation, process name, JSON UID or same-UID helper is not authority separation.
- Behavioral evaluation: trusted suite/policy/assertions/collector and exact candidate/suite/policy/environment binding, plus independently verified filesystem/network/process isolation. No accepted execution backend exists here; **NOT VERIFIED** and no untrusted host execution fallback. Instruction-only parsing is static validation, not behavioral evidence.
- Retrieval: only eligible authorized active records; cards/cache do not authorize later content. Exact active version, digest and complete resource integrity are rechecked. Loaded instructions remain untrusted reference content.
- Distribution/recovery: explicit protected authorization, immutable digests, managed destination ownership and durable journals. SQLite does not atomically commit unrelated filesystems. Recovery does not invent approval.
- Database maintenance: local supervised owner only, private paths, protected source refused, no SQL RPC; restore stages new offline files. Checksums are not operator signatures.

Unrestricted same-UID code can access the owner's files and SQLite, regardless of table names or UI confirmation. Ordinary mode is suitable only for a supervised owner threat model. Do not advertise protected/sandbox/native profiles as verified for production from code tests. Independent review and clean-machine/profile verification remain release blockers.

## Data inventory

| Data | Storage/purpose | Access and privacy |
| --- | --- | --- |
| Memories/experiences | Canonical SQLite; reusable facts/tasks with provenance | Project-authorized services; agent-reported remains unverified |
| Signals/proposals | SQLite and immutable inline packages | Lower-trust authored content; bounded fields, no approval authority |
| Skills/resources | Immutable version package records | Approved active disclosure; private scope; metadata is not authority |
| Reviews/evaluation/approval/active state | Registry evidence and lifecycle | Advisory separate; trusted evidence requires protected authority |
| FTS/caches | Derived SQLite/process memory | Scope checked; not canonical trust or lifecycle authority |
| Installer receipts | Project private `.agentmind` journals | Paths/hash/ownership; not credentials or project authentication |
| Logs/telemetry | Bounded diagnostics and evidence events | Redacted displays; retrieval is not application/success |
| Backup | Whole-registry private bundle | ALL projects; not encrypted; includes canonical legacy sensitive content |

Do not submit credentials, environment dumps, full transcripts or unrelated private files. Redaction is heuristic and cannot detect every secret/PII. Display sanitization preserves authoritative hashes and does not erase canonical evidence. Logs/stdout/Markdown/skill instructions are untrusted; they must never authorize tools, forge PASS or operator identity. Terminal control escaping and bounds reduce display abuse, not prompt injection in general.

No new deletion, export or retention semantics are added. Existing memory redaction/deletion policies do not promise erasure of backups, immutable packages, audit history, prior model context or external native artifacts. Do not delete database files to fix a migration. Keep backups only in authorized private directories under a human-controlled retention policy; no automatic cloud upload. For sensitive retention needs, inspect the actual canonical/export copies with an authorized operator rather than assuming local storage is encrypted.

## Incident response

Stop affected clients; preserve private original state and sanitized evidence. Do not reset approvals or execute candidate scripts. Verify source/lock/contract checksums against independently trusted inputs; inspect current registry integrity and distribution journals with read-only tools. For suspected protected authority compromise, stop using that deployment and obtain an operator-led recovery/review; never fall back to same-UID approval. Rotate provider credentials through the provider's native flow if exposure is suspected; AgentMind tooling must not inspect or copy them.

Report privately using [repository security policy](../../SECURITY.md). Include revision, disposable reproduction and enforcement layer without real secrets. Internal tests are not independent certification.
