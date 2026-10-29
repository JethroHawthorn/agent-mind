# Maintainers: candidate preparation and verification

The release strategy is a **source workspace RC**, preserving the two private workspace packages, pinned pnpm lock, TypeScript build and existing relative router/adapter paths. It is not an npm publishable bundle, standalone binary or preinstalled dependency image. Package version 0.0.1 is not a released semver promise. No license grant is present: resolve licensing/public distribution authorization before any external release.

## Local preparation

From source with existing dependencies:

```sh
pnpm build
pnpm architecture:check
pnpm docs:check
pnpm test:release
node scripts/release.mjs plan
```

Planning reads only an explicit source allowlist and prints versions, file hashes, source identity, sizes and limitations. It does not create an archive, initialize a DB, install dependencies or modify config. Build needs an explicit new output in an existing private current-owner canonical directory:

```sh
RC_DIR="$(mktemp -d)"
node scripts/release.mjs build --output "$RC_DIR/first.tar.gz"
node scripts/release.mjs build --output "$RC_DIR/second.tar.gz"
cmp "$RC_DIR/first.tar.gz" "$RC_DIR/second.tar.gz"
```

Stable ustar/gzip ordering, owner/mtime normalization and explicit file modes make equivalent inputs deterministic within the tested Node/zlib runtime. Cross-zlib or cross-platform byte identity is NOT VERIFIED. Source identity plus every-file hashes live in `RELEASE-MANIFEST.json` inside the archive; archive SHA-256 is returned outside. Retain an independently trusted checksum; it is not a signature or a clean supply-chain certification.

Included: source/tests/scripts/contracts, root and workspace manifests, lockfile/build configs, router/reflection content, native peer **source**, user/maintainer docs and security policy. Excluded: `.git`, node_modules, compiled dist, native binaries, caches, real settings, databases/backups, environment files and historical private audit artifacts. Generated output is built from the extracted source. Source changes require a new identity. Newly implemented source must be reviewed/versioned before a distributable candidate; this milestone does not commit it automatically.

The archive contains no installed binaries; the declared native dependency may download a prebuilt or compile during the explicitly requested `pnpm install --frozen-lockfile`. `pnpm-workspace.yaml` allows build scripts for better-sqlite3 and esbuild only; no privileged installation is performed. No automatic dependency upgrades, binary fetches or package publication occur during artifact creation. Lock integrity does not establish vulnerability absence or authenticate installed binaries. Consult independent dependency advisory intelligence before release; the offline inventory reports its absence honestly.

## Reproduction and scope

`pnpm test:release` verifies deterministic archive bytes, extraction/build using **existing dependency links**, packaged CLI startup/router lookup and generic MCP memory, documented quick-start examples, provider subsets/idempotency/data retention, and backup-before-historical-migration. Dependency links deliberately do not claim fresh dependency resolution or clean-machine installation. P6-004 must install the archive with frozen lock on clean authorized OS/runtime combinations and repeat doctor/MCP/project privacy, native CLI and recovery tests.

Full gates: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test --maxWorkers=2`, `pnpm test:e2e`, `pnpm test:security`, `pnpm test:database`, `pnpm test:behavioral`, `pnpm test:distribution`, `pnpm test:architecture`, `pnpm test:acceptance`, `pnpm smoke`, `pnpm architecture:check`. Overlapping suite totals must not be summed. Broker negative tests need appropriate macOS native test support; failures must remain failures. Never run model/native probes, provisioning, sandbox canaries or real database repair without their own authorization/isolation.

The architecture is shared scoped core → canonical SQLite/immutable packages with derived indexes/caches; native provider adapters retain distinct config semantics; protected authority remains broker-only in an actually separated deployment. Review [contracts](../../contracts/README.md), [reference](REFERENCE.md), [security](SECURITY.md) and [upgrade](UPGRADE.md). Do not refresh frozen contracts to make packaging tests green. Release-relevant source/contract changes need explicit rationale and independent review. No rankings, schema versions or lifecycle semantics change in this milestone.

## Blocker handoff

P6-001 E01 clean-host installation stays open for P6-004. P6-002 independent architecture/security review remains open (no independent P6-002 report was supplied). Native N01, OS S01 and sandbox S02 remain profile gates. Broker test socket EPERM remains an execution gap. Forty-two missing formal MCP output schemas and other inherited review dispositions are not closed by documentation. No license grant/public distribution approval and absence of a fresh dependency-advisory assessment remain release preparation risks. P6-004 receives checksummed artifacts, source identity, exact fresh command outcomes, fixture-vs-native classification and unresolved gate list; no tag/publication is authorized.
