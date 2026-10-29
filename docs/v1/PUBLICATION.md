# Controlled publication proposal — NOT EXECUTED

Current decision: **NO-GO**. V1.0.0 is a proposed version, while package/runtime metadata remains 0.0.1. No artifact is eligible for V1 publication. The rehearsal tool has no publishing executor, signing authority or release approval token. These are application-level safeguards, not OS protection against unrestricted same-UID code invoking Git or inherited credentials. Publisher authority must remain with a separately authorized human outside the untrusted runner; no such publisher identity separation is certified here. `release-final.mjs plan|rehearse` only reads artifact/source/review metadata and emits an explicit blocked decision.

```sh
node scripts/release-final.mjs rehearse --artifact /absolute/local-source-preparation.tar.gz --sha256 TRUSTED_SHA256
```

Exit2 means NO-GO, not a failed attempt to publish; invalid input exits1. No prompt, `--apply`, `--force`, environment variable, review text, serialized approval or stdout PASS can authorize a release. The command never pushes, tags, uploads, signs, reads model credentials or invokes models.

## Roles and approval evidence

Implementation owner prepares source and disposable evidence. A separate reviewer inspects exact source/artifact/digests and mandatory gates. The release approver chooses eligible profiles and explicitly authorizes the particular external mutations. The artifact publisher executes only those authorized mutations with their own least-privilege credentials. Protected/behavioral claims additionally require security approval backed by real deployment/isolation evidence. One human may fill roles, but that is not organizational or OS independence; an implementation agent cannot independently certify/approve itself.

Before requesting publication, assemble a human-readable, independently reviewed approval record binding:

- Exact requested version, complete committed source revision, clean source status and lock/config/toolchain identity.
- Exact artifact filenames, SHA-256 values, sizes, notes/changelog/checksum-manifest digests and validated installation profile/platforms.
- Complete gate results, open blocker waivers where policy allows, independent review identity and evidence.
- Exact repository/channel/destination, proposed tag and each requested mutation: local tag, particular remote refs, draft release/assets, final publication.
- Expiry/change conditions and post-release/incident owner. Any source/artifact/destination/profile change invalidates this approval; unrelated earlier skill-operator grants cannot authorize release.

All mandatory gates must pass for the chosen advertised profile. CONDITIONAL GO does not permit publication. Missing license/clean host/final review/version consistency are not waived by this document. Current preparation artifacts remain private and unlicensed; do not upload even a draft.

## Proposed channel and prerequisites

The inspected origin is `git@github.com:JethroHawthorn/agent-mind.git`. A GitHub source-release channel is proposed only for that configured repository; repository permissions, current remote tags, visibility, release settings and authentication have **not** been queried or verified. No npm channel is configured: workspace packages are private, so npm publication is not a supported plan.

Git tag syntax was checked against local Git help. GitHub CLI is not installed here; the following proposed syntax was checked against official [release create](https://cli.github.com/manual/gh_release_create) and [release edit](https://cli.github.com/manual/gh_release_edit) documentation on 2026-10-29. Future operators must recheck their installed version/help and actual permissions. No CLI installation or authentication was performed. No signing key is provisioned; the annotated-tag proposal is unsigned. Signing, if later required, needs separately established human-controlled keys/trust and verification; checksums are not signatures.

## Proposed commands — human execution only after separate authorization

The block below is a runbook, **not a shell script to run now**. Variables must come from the reviewed approval record, not agent output or package metadata alone. First verify the remote, approved full commit, clean tree, artifact/checksum/notes and absence of an existing conflicting v1.0.0 locally and remotely. Remote inspection requires authorized network access. Do not overwrite a tag, reuse an old digest, or publish the current 0.0.1 preparation artifact under v1.0.0. A required source branch/commit push is a separately reviewed mutation, never `--all`/force.

```sh
# NOT EXECUTED. Exact source must already be reviewed, committed and approved for V1.0.0.
git rev-parse "$APPROVED_COMMIT"
git remote get-url origin
git status --porcelain
git show-ref --verify refs/tags/v1.0.0
git ls-remote --tags origin refs/tags/v1.0.0
# Separate explicit permission: local annotated tag. Existing tag must cause a stop.
git tag -a v1.0.0 "$APPROVED_COMMIT" -F "$APPROVED_TAG_NOTES"
# Separate explicit permission: push this exact tag ref only.
git push origin refs/tags/v1.0.0:refs/tags/v1.0.0
# Separate explicit permission: remote draft creation and asset upload (still external writes).
gh release create v1.0.0 "$APPROVED_ARTIFACT" "$APPROVED_CHECKSUMS" --repo JethroHawthorn/agent-mind --verify-tag --draft --title 'AgentMind V1.0.0' --notes-file "$APPROVED_RELEASE_NOTES"
# Inspect all remote bytes/notes/ref bindings and obtain final publication approval.
# Separate explicit permission: make that reviewed draft public/visible per repository settings.
gh release edit v1.0.0 --repo JethroHawthorn/agent-mind --verify-tag --draft=false
```

`git show-ref --verify` exits nonzero when a tag is absent: inspect that outcome, do not blindly chain this runbook with shell separators or ignore errors. Remote tag/release checks were not executed here; no assertion is made that V1.0.0 is absent remotely. GitHub `--verify-tag` prevents an automatic tag from an unapproved default-branch head. Creating draft/assets and final publication are separate network requests, not an atomic transaction. Stop on partial failure; retain evidence and inspect exact remote state rather than retrying blindly or replacing assets. Actual immutability settings remain unverified.

## Approval checklist and next steps

No checklist item is currently marked approved. Required: resolve all mandatory blockers; reviewed consistent1.0.0 metadata/contract strategy; rebuild; independent exact-artifact recertification; clean install/native/security gates appropriate to selected profiles; owner license; explicit human approval of exact mutations/digests/destinations. Until then the rehearsal returns NO-GO and no publication machinery runs. Post-release checks remain NOT EXECUTED; follow [post-release and incident plan](POST_RELEASE.md) only after authorized publication.
