# Upgrade, migration and recovery

There is no previously published V1/npm upgrade path. Package metadata remains 0.0.1; database schema, package format, evidence and installer receipts have independent versions. A package version alone does not identify a source snapshot: retain the source identity and candidate checksum. Preserve the [frozen contracts](../../contracts/README.md).

## Compatibility matrix

| Starting state | Target | Status / evidence |
| --- | --- | --- |
| Empty registry | Current schema 11 | Supported offline fresh creation |
| Actual original schema 1 fixture | Schema 11 | Tested backup, restore staging, migration and memory/FTS preservation; no historical npm release implied |
| Populated schema 9 fixture constructed by historical migrations | Schema 11 | Existing migration tests preserve active versions, digests, provenance and audit |
| Current schema 11 | Current code | No downgrade/migration; ledger and compatibility checked |
| Unversioned nonempty / malformed / future schema | Current | Refused, never reset |
| Protected broker registry | Ordinary local maintenance | Refused; separately authorized operator upgrade required |
| Managed current router/config | Same source version | SKIP when unchanged; missing managed router repair tested |
| Edited or unowned router/config | Any update | Conflict; no silent adoption/overwrite |
| Earlier published package release | Current | NOT APPLICABLE: no actual historical release artifact supplied |
| Unknown historical receipt/router formats | Current | NOT VERIFIED; inspect exact plan, preserve and resolve conflicts |

No reverse migrations or downgrade support. Older binaries must not write new schemas. Stop **all** MCP/CLI writers and recovery workers before operational upgrade. Future schemas fail closed. Keep the prior source artifact for inspection, but do not start it on a newer database. An operator must resolve unfinished distribution journals; migration does not mark them COMPLETE or invent approval.

## Read-only preflight

From inside the authorized project, set `CLI` to the absolute built `agentmind.js` path and `DB` to the existing canonical SQLite file. These commands do not migrate:

```sh
node "$CLI" status --project-root "$PWD" --db "$DB" --json
node "$CLI" db status --db "$DB" --json
node "$CLI" db migrate --db "$DB" --dry-run --json
node "$CLI" distribution status "$SKILL_ID" --project-root "$PWD" --db "$DB" --json
node "$CLI" update --project-root "$PWD" --db "$DB" --cli all --dry-run --json
```

For distribution inspection, set `SKILL_ID` to a full authorized skill UUID from `skills list`; omit that command if the registry has no skills. Stop on future schema, checksum drift, protected authority, private-directory failure, config ownership conflict, unknown/incomplete distribution, insufficient disk, or missing backup. Examine the migration plan's exact `digest`; schema names or version numbers alone are insufficient. Existing core migration applies transactionally with a rechecked digest, not a cross-resource installation transaction.

The developer helper `node /absolute/source/scripts/upgrade-plan.mjs --db "$DB"` combines the existing read-only migration preflight with an explicit backup requirement. Without `--bundle "$BACKUP" --checksum "$CHECKSUM"` it returns BLOCKED (exit 2). With a verified matching-schema backup it returns PREFLIGHT_ONLY, never an upgrade grant; recency, source identity, stopped clients, unfinished distribution and config plans still require operator inspection. No file, database or config is changed.

## Mandatory pre-upgrade backup

Operational schema/source upgrades require a verified pre-upgrade backup and preserved old source. The local migrator itself does **not** enforce that a backup exists; it is a narrower core maintenance interface. Do not call it as an automated unattended upgrade. No new privileged upgrade API is introduced.

Use an existing current-owner canonical private (0700) directory, never a shared/project-agent-writable destination for protected data. This local workflow refuses protected registries. Files are 0600; encryption is not provided. `BACKUP` must be a new bundle path beneath that directory:

```sh
node "$CLI" db backup --db "$DB" --output "$BACKUP" --dry-run --json
node "$CLI" db backup --db "$DB" --output "$BACKUP" --apply --whole-registry --json
node "$CLI" db verify-backup --bundle "$BACKUP" --checksum "$CHECKSUM" --json
```

Set `CHECKSUM` to the separately retained `sha256` returned by backup (not an agent-supplied replacement). SQLite's online backup includes committed WAL state, unlike copying only the main file. The bundle manifest binds schema, inline package files/digests, active state and pending distribution records. External native directories, broker runtime/policy, ownership and OS identities are **not** backed up as a complete deployment. Backups contain **all projects**, including sensitive canonical content; display redaction is not backup redaction. A checksum detects accidental change against a trusted value, not an attacker replacing both metadata and snapshot.

After verification, explicitly migrate using the exact reviewed current schema digest:

```sh
node "$CLI" db migrate --db "$DB" --apply --schema-digest "$SCHEMA_DIGEST" --json
node "$CLI" db doctor --db "$DB" --deep --json
node "$CLI" update --project-root "$PWD" --db "$DB" --cli all --dry-run --json
```

Set `SCHEMA_DIGEST` to `digest` in the migration plan. Recheck managed configuration plans and apply separately with `update --apply` only after approval. No environment variable enables operator approval. Restart clients only after final compatibility/integrity checks. `--health`, ordinary MCP startup and `doctor --connect` may initialize/migrate; do not use them before backup/preflight on older state.

## Failure checkpoints and recovery

| Failure | Conservative response |
| --- | --- |
| Before/during backup | No schema change; incomplete staging never becomes verified backup; retain source DB |
| After backup/before migration | Verify checksum and replanned schema digest; no automatic update |
| During migration | SQLite transaction rolls back on exception/process crash; inspect original schema; never reset |
| After migration/before config update | Keep newer compatible binary, inspect database; do not reverse schema |
| During config/router update | Inspect unified/provider journals and receipt hashes; preserve edits, use targeted repair plan |
| During hook update | Not applicable: unified installer does not install hooks |
| Before/after final verification | Persist truthful partial state; verify again; no false COMPLETE |
| Protected source | Stop; local backup/migrate/restore cannot supply operator authority |

Restore only to a **new absent offline file**, with explicit whole-registry consent:

```sh
node "$CLI" db restore --bundle "$BACKUP" --checksum "$CHECKSUM" --output "$RESTORED" --dry-run --json
node "$CLI" db restore --bundle "$BACKUP" --checksum "$CHECKSUM" --output "$RESTORED" --apply --whole-registry --json
```

The existing live file remains intact. Inspect external package availability, exact active digests, security policy and distribution journals before manually selecting restored state. Extra packages on disk are not activation authority. Restoring old approval records is not fresh operator authorization. Backup verification preserves original schema and NOT_VERIFIED classifications; a restored historical DB needs a new forward migration. No automated switching of live paths or protected restore is supplied.
