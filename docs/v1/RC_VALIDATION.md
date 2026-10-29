# Artifact-first release candidate validation

This is maintainer testing, not release publication or an installer. Build a local source RC using the [preparation guide](MAINTAINERS.md). Retain an independently trusted SHA-256 and the source revision/content identity. Never trust a manifest checksum as an operator signature.

```sh
node scripts/rc-validation.mjs --artifact /absolute/new-candidate.tar.gz --sha256 TRUSTED_SHA256
node scripts/rc-validation.mjs --artifact /absolute/new-candidate.tar.gz --sha256 TRUSTED_SHA256 --run
```

Inspection verifies bounded gzip/ustar headers, paths, file modes, complete manifest membership, content digests and source identity **before extraction**. No archive path, symlink, duplicate, undeclared member or digest mismatch may become a host file. Only an actual source RC matching its separately trusted digest should be executed; archive integrity does not make arbitrary code safe.

`--run` creates private disposable source/HOME/config/database roots under the OS temporary directory. It first attempts a frozen-lock **offline install into an empty package store**. Missing cached dependency data is an environmental prerequisite failure, not a clean installation PASS. A fallback physically copies the current reviewed workspace dependencies, confines all symlink targets to the artifact tree and rebases only generated pnpm shims/metadata that embed developer NODE_PATHs. No symlink to source-checkout modules is permitted. Reused native binding digests and toolchain identity are reported. This fallback is **L2 copied-dependency evidence**, not fresh dependency or clean-machine acceptance.

The extracted artifact builds itself, checks its frozen contracts/docs, re-archives itself for a separate-snapshot reproducibility comparison, runs generic MCP smoke and code-owned core/retrieval/install/storage/security/distribution suites. Trusted synthetic fixtures may seed approved versions using existing test authority; they do not establish genuine human/OS approval or native agent learning. Candidate scripts are never executed by this harness. No model invocation, live CLI settings, provider credentials, protected service or live registry is used.

Results and sanitized logs persist in the printed private temporary work directory for inspection; dispose of that specific test directory according to local policy when no longer needed. Per-command deadlines are bounded and a timed-out process group is terminated; interrupted controller runs retain incomplete results, not a success claim. No generic command execution or arbitrary protected path interface is added. Exit 2 means completed restricted verification with unavailable release gates; 1 means failure/refusal, and inspection alone exits 0 on valid bytes.

## Clean-target plan

L1 source checkout tests, L2 artifact/temporary HOME, L3 independently provisioned container/VM, L4 genuinely clean supported macOS target and L5 protected deployment require separate evidence. Linux containers do not certify macOS; L2 cannot establish OS identity separation or credential isolation against unrestricted same-UID code.

For P6-004, independently provision an authorized clean macOS arm64 environment and supported Node/pnpm, transfer only the checksummed source archive, install from its pinned lock, build and run quick start/doctor/privacy/backup/restore/upgrade/uninstall. No source/node_modules host mounts, developer-global modules, credentials or source-checkout dependencies are allowed. Record OS/toolchain/native ABI/image identities and installation logs. Advanced/native profiles require separate explicit authorization and actual evidence. No VM software, OS account, launchd service or paid model is automatically installed/invoked. If prerequisites are unavailable, record NOT VERIFIED and preserve refusal-only features.

No actual historical published AgentMind release is supplied; historical schema fixtures are not a historical release installation. Public licensing, independent review and profile-specific gates remain in the blocker register. Neither a passing artifact smoke nor matching rebuilt hashes authorize V1 or P6-005 publication.
