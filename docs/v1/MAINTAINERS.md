# Maintainers: candidate preparation and verification

The release strategy is a **source workspace RC**, preserving the two private workspace packages, pinned pnpm lock, TypeScript build and existing relative router/adapter paths. It is not an npm publishable bundle, standalone binary or preinstalled dependency image. Package version 1.0.0 is not a released semver promise. The source is licensed under the [MIT License](../../LICENSE). Include its notice in distributions; publishing an official release remains a separately authorized action.

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

Included: source/tests/scripts/contracts, root and workspace manifests, lockfile/build configs, router/reflection content, native peer **source**, user/maintainer docs, security policy and MIT license notice. Excluded: `.git`, node_modules, compiled dist, native binaries, caches, real settings, databases/backups, environment files and historical private audit artifacts. Generated output is built from the extracted source. Source changes require a new identity. Newly implemented source must be reviewed/versioned before a distributable candidate.

The archive contains no installed binaries; the declared native dependency may download a prebuilt or compile during the explicitly requested `pnpm install --frozen-lockfile`. `pnpm-workspace.yaml` allows build scripts for better-sqlite3 and esbuild only; no privileged installation is performed. No automatic dependency upgrades, binary fetches or package publication occur during artifact creation. Lock integrity does not establish vulnerability absence or authenticate installed binaries. Consult independent dependency advisory intelligence before release; the offline inventory reports its absence honestly.

## Reproduction and scope

`pnpm test:release` verifies deterministic archive bytes, extraction/build using **existing dependency links**, packaged CLI startup/router lookup and generic MCP memory, documented quick-start examples, provider subsets/idempotency/data retention, and backup-before-historical-migration. Dependency links deliberately do not claim fresh dependency resolution or clean-machine installation. Independent verification must install the archive with frozen lock on clean authorized OS/runtime combinations and repeat doctor/MCP/project privacy, native CLI and recovery tests.

Full gates: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test --maxWorkers=2`, `pnpm test:e2e`, `pnpm test:security`, `pnpm test:database`, `pnpm test:behavioral`, `pnpm test:distribution`, `pnpm test:architecture`, `pnpm test:acceptance`, `pnpm smoke`, `pnpm architecture:check`. Overlapping suite totals must not be summed. Broker negative tests need appropriate macOS native test support; failures must remain failures. Never run model/native probes, provisioning, sandbox canaries or real database repair without their own authorization/isolation.

The architecture is shared scoped core → canonical SQLite/immutable packages with derived indexes/caches; native provider adapters retain distinct config semantics; protected authority remains broker-only in an actually separated deployment. Review [contracts](../../contracts/README.md), [reference](REFERENCE.md), [security](SECURITY.md) and [upgrade](UPGRADE.md). Do not refresh frozen contracts to make packaging tests green. Release-relevant source/contract changes need explicit rationale and independent review.

## Verification requirements

Clean-host installation and independent architecture/security review remain required. Native model use, OS-separated operator authority and executable sandbox isolation need their own evidence. Restricted-host socket failures and incomplete MCP output-schema coverage must be reported accurately. Release approval and dependency-advisory review remain required before publication. Reviewers need checksummed artifacts, source identity, exact command outcomes and a clear distinction between fixture tests and native integration tests. No tag or publication is authorized by a passing local test.

## Global npm CLI artifact

The root `agentmind` package is the distribution wrapper. Command ownership remains `packages/mcp-server/src/agentmind.ts`; there is no second CLI package. Root `bin` targets `dist/runtime/packages/mcp-server/dist/agentmind.js`.

```sh
mkdir -p dist/artifacts
npm pack --pack-destination dist/artifacts
node scripts/verify-global-cli.mjs
```

`prepack` uses the existing TypeScript configurations, copies compiled JavaScript and the router to an allowlisted runtime tree, and rewrites only internal `@agentmind/core` module specifiers to package-relative imports. Both workspace directory layouts are retained for adapters, curator workers and asset resolution. Detailed documentation remains in the repository; the selected npm files list includes the runtime, README, SECURITY policy and MIT license notice. SQLite migrations and schemas are compiled modules. No source maps, TypeScript sources, databases, credentials, native binaries or workspace node_modules enter the package. External dependencies install normally through npm; no `workspace:*` runtime dependency remains. No new bundler or separately published core package is needed.

`npm pack` builds locally and does not publish. `npm install` has no AgentMind lifecycle script; dependency scripts may install the SQLite binding. There is no runtime pnpm dependency. The root metadata declares version 1.0.0 and license `MIT`; this does not approve release publication. Workspace implementation packages retain their existing private 0.0.1 metadata and are not separately distributed. Repository metadata comes from the existing Git remote. No registry name claim or V1 approval is implied.

The explicit installation smoke uses a disposable npm prefix/cache/HOME, followed by the installed executable with a PATH containing Node and provider executable doubles only. It exercises all three installed MCP adapters, memory/FTS, configuration, read-only views and data-preserving removal. It retains its temporary evidence directory. It needs network/native-build access for a fresh dependency installation; it never uses developer dependency symlinks in the installed runtime. This is not clean-OS/native-model certification.

Artifact identity includes the npm pack file manifest and a separately recorded SHA-256 in the artifact manifest. The changed executable, imports, package assets, metadata and README invalidate previous RC certification for those paths. Rebuild and independently review the exact new artifact, then repeat clean supported-host installation, native provider acceptance, upgrade/recovery and relevant security/profile tests before publication. Existing verification requirements remain open.
