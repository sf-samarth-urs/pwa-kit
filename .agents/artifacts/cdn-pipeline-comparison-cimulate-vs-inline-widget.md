# CDN publish pipeline — Cimulate Widget (existing) vs Inline Agent Widget (Path B, planned)

> Terminology note: in this doc, **Cimulate Widget** is the Commerce Client UI for the Shopper Agent main chat window (a.k.a. Commerce Client / Custom Client). It replaced the earlier MIAW-powered pwa-kit native chat UI. The literal strings `copilot-widget` (repo folder, bucket prefix, CDN URL path, matrix value, npm package name) are Cimulate-side historical names and are kept as-is.

Audience: engineers who have heard the terms IAM, WIF, SA, GHA but want to see them laid flat side-by-side.

Two pipelines, same bucket (`gs://copilot-bundles`), same CDN (`cdn.search.cimulate.ai`). Different owners, different trust boundaries, different IAM roles — on purpose.

---

## TL;DR

| | Cimulate Widget (today) | Inline Agent Widget (Path B) |
| --- | --- | --- |
| Owned by | Cimulate (`cimulate-ai/cimulate`) | SFCC (`SalesforceCommerceCloud/inline-agent-widget`) |
| Trust boundary | GitHub org `cimulate-ai` | A single GitHub repo in a different org |
| GCS role granted to the publishing SA | `roles/storage.objectAdmin` on **whole** `copilot-bundles` + project-level roles on `cimulate-build` | `roles/storage.objectCreator` on **prefix `inline-agent-widget/` only** |
| Can list the bucket? | Yes | **No** |
| Can read / overwrite / delete objects? | Yes | **No** — not even its own |
| Upload command | `gsutil cp` | `curl -X PUT` (gsutil/gcloud do a preflight list, fail with 403) |
| Overwrite protection | None in IAM; discipline-based | IAM + `x-goog-if-generation-match: 0` → 412 on duplicate version |
| Blast radius if the workflow is compromised | Anyone who can run the workflow can clobber *any* object in the bucket (including Cimulate Widget bundles under `copilot-widget/`) | Can only create new objects under `inline-agent-widget/<version>/`; cannot overwrite existing versions, cannot touch Cimulate Widget bundles under `copilot-widget/` |

The whole reason Path B exists is because **the publishing identity sits in a different GitHub org from the bucket's owner**. We can't reuse Cimulate's existing `objectAdmin` SA — that would hand an out-of-org principal the keys to Cimulate's production CDN bucket.

---

## Why `objectCreator` and not `objectAdmin`

Five reasons, strongest first.

**1. Cross-org trust.** Cimulate's existing SA is bound to `assertion.repository_owner == 'cimulate-ai'` — only workflows in repos owned by the `cimulate-ai` GitHub org can mint tokens for it. Inline-agent-widget is `SalesforceCommerceCloud/inline-agent-widget` — a different org that Cimulate does not operate. Granting a cross-org principal `objectAdmin` on a bucket that already serves Cimulate Widget production bundles (under the `copilot-widget/` prefix) means a compromised or misconfigured workflow in SFCC's org could overwrite Cimulate Widget assets in prod.

**2. Blast radius.** `objectAdmin` = create + read + list + delete + overwrite + edit object IAM. `objectCreator` = create only. On a public CDN bucket, overwrite is the dangerous permission — a bad bundle at an existing URL silently serves to every page already pointing at it. Create-only means a bad release can only ever be a *new* URL, never a replacement of a working one.

**3. Immutability is enforced two ways, not one.**
- Policy: `objectCreator` role has no `storage.objects.update` or `storage.objects.delete`.
- Protocol: `x-goog-if-generation-match: 0` on the PUT. GCS returns `412 Precondition Failed` if the object already exists.

With `objectAdmin`, nothing in IAM prevents a second PUT from silently overwriting a shipped version. The generation-match header is still a nice-to-have, but it's workflow discipline — remove it and the pipeline overwrites happily.

**4. Prefix scoping is cleaner.** The IAM condition `resource.name.startsWith("projects/_/buckets/copilot-bundles/objects/inline-agent-widget/")` scopes writes to `inline-agent-widget/` only — a PUT to `copilot-widget/anything.js` returns 403. The trailing slash is load-bearing (`inline-agent-widget-other/` doesn't match). `objectAdmin` conditioned on a prefix would still let the SA list and read objects outside the prefix if left unconditioned on other permissions.

**5. Compliance posture.** Cimulate's platform prohibits creating `google_service_account_key`. For a cross-org identity, "minimum privilege + Workload Identity Federation + no key" is the only pattern that passes review. `objectAdmin` for an external principal does not.

---

## Side-by-side: every component

### Trigger

| | Cimulate Widget | Inline Agent Widget |
| --- | --- | --- |
| Event | `push` to `master` | `push` to `main` (per the mermaid; the earlier plan draft says `v*` tag — we switched to merge-to-main to mirror the Cimulate Widget pipeline) |
| Path filter | `paths: javascript/**` | `paths: src/**` |
| Matrix / scoping | `get-changes` script → publishes only if changed folder is exactly `["copilot-widget"]` | Single-package repo, no matrix |
| Version source | `package.json` → `npm pkg get version` | `package.json` → `npm pkg get version` |

### Runner

| | Cimulate Widget | Inline Agent Widget |
| --- | --- | --- |
| `runs-on` | `cimulate-build` (Cimulate's self-hosted ARC runners) | `ubuntu-latest` (GitHub-hosted) |
| Why | Cimulate owns the runners and the project | Cimulate's runners don't accept jobs from `SalesforceCommerceCloud/*` |

### GitHub Actions auth → GCP (the WIF part)

Both use Workload Identity Federation. No JSON keys anywhere. The difference is **which pool** and **which conditions**.

```
GitHub Actions job
  └─> requests OIDC id-token from token.actions.githubusercontent.com
       └─> google-github-actions/auth@v2 presents token to GCP STS
            └─> STS checks: does this token's claims satisfy the pool/provider's attribute_condition?
                 └─> if yes: STS mints a short-lived access token (<1h) for the bound SA
                      └─> workflow uses that access token to call GCS
```

| | Cimulate Widget | Inline Agent Widget |
| --- | --- | --- |
| WIF pool | `github-arc` | `inline-agent-widget` (new) |
| WIF pool project | `cimulate-build` | `cimulate-search-api` |
| Provider | `github-arc` under that pool | `github` under the new pool |
| Issuer | `token.actions.githubusercontent.com` | same |
| `attribute_condition` (CEL) | `assertion.repository_owner == 'cimulate-ai'` | `assertion.repository == 'SalesforceCommerceCloud/inline-agent-widget' && assertion.workflow_ref.startsWith('…/publish-cdn.yml@refs/heads/main')` |
| Who it trusts | Any repo under the `cimulate-ai` GitHub org | Exactly one repo, exactly one workflow file, exactly the `main` branch |
| Bound SA (impersonated by the token) | `vars.GCP_SERVICE_ACCOUNT` on `cimulate-ai/cimulate` | `inline-agent-widget-cdn@cimulate-search-api.iam.gserviceaccount.com` |
| Actions variables on the publishing repo | `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT`, `GCP_PROJECT_ID` (written by Pulumi stack `github-arc`) | `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT` (manually set, values from `terraform output`) |

**The subtle point:** the Cimulate Widget pipeline's CEL is `repository_owner == 'cimulate-ai'` — org-wide. Any `cimulate-ai/*` repo whose workflow has `id-token: write` can impersonate that SA. That's fine because Cimulate owns the org and its SOC/CI policies. The Inline Agent Widget CEL is deliberately narrower: one repo, one workflow filename, one ref prefix. Narrower because the trust side (Cimulate) does not administer the SFCC org.

### Service Account IAM

| | Cimulate Widget (`vars.GCP_SERVICE_ACCOUNT` on `cimulate-ai/cimulate`) | Inline Agent Widget (`inline-agent-widget-cdn@…`) |
| --- | --- | --- |
| Project `cimulate-build` roles | `roles/artifactregistry.admin`, `roles/iam.serviceAccountTokenCreator`, `roles/storage.admin` | **none** |
| Project `cimulate-search-api` roles | — | **none** |
| Bucket `copilot-bundles` roles | `roles/storage.objectAdmin` + `roles/storage.bucketViewer` (unconditional, whole bucket) | `roles/storage.objectCreator` conditioned on `resource.name.startsWith("projects/_/buckets/copilot-bundles/objects/inline-agent-widget/")` |
| Can read `copilot-widget/*` | Yes | No (list is denied) |
| Can delete / overwrite own objects | Yes | **No** — second PUT → 412 |
| Can create `copilot-widget/foo.js` from the inline-agent-widget workflow? | N/A (different repo) | **No** — prefix condition denies with 403 |

The Cimulate Widget SA has broad roles because it also publishes other artifacts (Artifact Registry images, etc.) and operates within Cimulate's own trust boundary. The Inline Agent Widget SA has one role, scoped, because its one job is "write new objects under one prefix."

### Upload command (why John Roman's second question matters)

| | Cimulate Widget | Inline Agent Widget |
| --- | --- | --- |
| Command | `gsutil cp ./dist/*.umd.js gs://copilot-bundles/copilot-widget/${pkg_version}/` | `curl -X PUT -H "x-goog-if-generation-match: 0" -H "Cache-Control: public, max-age=3600" -H "Content-Type: text/javascript" --data-binary @dist/inline-agent-widget.umd.js https://storage.googleapis.com/copilot-bundles/inline-agent-widget/${version}/inline-agent-widget.umd.js` |
| Why that command works | SA has list/read, so gsutil's preflight (checking existence, deciding resumable vs. simple upload) succeeds | SA cannot list; gsutil/gcloud preflight fails with 403 before the write even starts |

**Walk through what `gcloud storage cp` actually does under the hood** (and `gsutil cp` is the same shape):
1. `storage.objects.get` on the destination to check if it exists.
2. If `--if-generation-match` is set, `storage.objects.list` on the parent to resolve path semantics.
3. Decide resumable vs. simple upload (based on file size).
4. `storage.objects.insert` (the actual PUT).

Steps 1 and 2 require `storage.objects.get` and `storage.objects.list` IAM permissions. `roles/storage.objectCreator` has `storage.objects.create` only — not `get`, not `list`. The gcloud command exits non-zero at step 1.

`curl -X PUT` to the JSON API's media endpoint goes straight to step 4. That's the only step the SA has the permission to execute.

**TL;DR for John:** we're not avoiding gcloud as a style choice. gcloud literally cannot run with the role Cimulate is willing to grant. Widening the role to let gcloud work (`objectAdmin`, or even `objectUser`) is exactly the trust posture Path B is designed to avoid.

### Overwrite / immutability

| | Cimulate Widget | Inline Agent Widget |
| --- | --- | --- |
| Protection in IAM | None (SA can delete/overwrite) | `objectCreator` cannot overwrite |
| Protection in protocol | None (nobody sets `IfGenerationMatch`) | `x-goog-if-generation-match: 0` on PUT → GCS returns 412 if the object key already exists |
| What happens if someone bumps `package.json` version to a value already shipped | Overwrites the live object. CDN eventually serves the new bytes at the same URL. | Workflow fails at the PUT. Nothing changes on the CDN. Fix = bump to a new version. |

### Downstream (consumers)

| | Cimulate Widget | Inline Agent Widget |
| --- | --- | --- |
| npm publish? | Yes (`npm publish --access public`) | **No** — our storefront consumers (SFRA cartridge, PWA Kit template, SF Next template) all load the UMD via `<script src>` from the CDN. None `npm install` it. |
| Slack notification | Posts to two `#copilot-releases*` channels with changelog | TBD (nice-to-have, not blocking) |
| CDN URL shape | `https://cdn.search.cimulate.ai/copilot-widget/<version>/messaging.umd.js` | `https://cdn.search.cimulate.ai/inline-agent-widget/<version>/inline-agent-widget.umd.js` |

### CDN caching behavior

Both paths set `Cache-Control: public, max-age=3600` on the object. For inline-agent-widget it has to be set at create time — `objectCreator` has no `storage.objects.update` to patch metadata after.

Each version is a new object path (version in URL), so cache invalidation is not required. A bad release = a new tag/version at a new URL. Rollback = point consumers at the previous version.

---

## Call-flow walk-through

### Cimulate Widget (existing)

```
Dev PR with change under javascript/copilot-widget/
  └─> merge to master
       └─> GHA job: get-javascript-changes
            └─> matrix == ["copilot-widget"]? -> publish job runs
                 ├─> actions/checkout@v3
                 ├─> google-github-actions/auth@v2.1.2
                 │     reads vars.GCP_WORKLOAD_IDENTITY_PROVIDER + vars.GCP_SERVICE_ACCOUNT
                 │     OIDC token -> STS -> short-lived access token for cimulate-ai CI SA
                 │     (SA has objectAdmin on whole bucket)
                 ├─> setup-gcloud@v1
                 ├─> npm ci && npm test && npm run build
                 ├─> npm publish --access public
                 └─> gsutil cp ./dist/*.umd.js  gs://copilot-bundles/copilot-widget/${version}/
                     gsutil cp ./dist/*.css     gs://copilot-bundles/copilot-widget/${version}/
                     (preflight list+get succeed; upload succeeds; overwrite allowed)
         └─> Slack notify
```

### Inline Agent Widget (Path B, planned)

```
Dev PR with change under src/
  └─> bump package.json version (required for any src/ change)
  └─> merge to main
       └─> GHA job: publish-cdn.yml  (paths: src/**)
            ├─> actions/checkout@v4
            ├─> google-github-actions/auth@v2
            │     reads vars.GCP_WORKLOAD_IDENTITY_PROVIDER + vars.GCP_SERVICE_ACCOUNT
            │     OIDC token -> STS -> narrow attribute_condition check:
            │       repo == SalesforceCommerceCloud/inline-agent-widget
            │       workflow_ref starts with .github/workflows/publish-cdn.yml@refs/heads/main
            │     -> short-lived access token for inline-agent-widget-cdn SA
            │     (SA has objectCreator on prefix inline-agent-widget/ ONLY)
            ├─> actions/setup-node@v4 (node 22)
            ├─> npm ci && npm test && npm run build
            │   (writes dist/inline-agent-widget.umd.js)
            ├─> version=$(npm pkg get version | tr -d '"')
            └─> curl -X PUT  https://storage.googleapis.com/copilot-bundles/inline-agent-widget/${version}/inline-agent-widget.umd.js
                  -H "Authorization: Bearer $(gcloud auth print-access-token)"
                  -H "Content-Type: text/javascript"
                  -H "Cache-Control: public, max-age=3600"
                  -H "x-goog-if-generation-match: 0"
                  --data-binary @dist/inline-agent-widget.umd.js
                  (HTTP 200 on first publish, HTTP 412 on duplicate version)
                  (HTTP 403 if someone tries to upload outside inline-agent-widget/)
         └─> (future) Slack notify
```

The two call flows are **structurally identical** — same WIF handshake, same `package.json`-driven versioning, same bucket. What differs is the trust surface at each step.

---

## Five intricate details most people stumble on

1. **WIF is not a password.** No long-lived secret lives anywhere. The GitHub runner has an OIDC id-token minted per-job by GitHub, scoped to that job's claims. GCP exchanges it for a short-lived access token after checking CEL conditions. If the workflow file changes, the token changes shape, and the SA refuses to be impersonated.

2. **`workflow_ref` is the filename, not the branch.** The pinning string is `SalesforceCommerceCloud/inline-agent-widget/.github/workflows/publish-cdn.yml@refs/heads/main`. The `@refs/heads/main` part is the ref the workflow is running on; `.github/workflows/publish-cdn.yml` is the file path. Rename the file and the SA refuses to mint a token.

3. **`attribute.repository` ≠ `assertion.repository`.** In the Terraform, the CEL `attribute_condition` reads `assertion.*` fields directly from the GitHub-issued OIDC token. The `principalSet://` IAM binding references `attribute.repository`, which comes from the `attribute_mapping` block that aliases `assertion.repository` → `attribute.repository`. Two different namespaces, bound by the mapping, easy to confuse.

4. **objectCreator means create-only — including for yourself.** Second PUT of the same object key returns 412, not 200-with-overwrite. The pipeline cannot "re-publish" the same version. You must bump `package.json`. This is the feature, not a bug.

5. **The prefix condition's trailing slash is load-bearing.** `startsWith("…/objects/inline-agent-widget/")` matches `inline-agent-widget/1.2.3/foo.js` but not `inline-agent-widget-other/foo.js`. Drop the slash and the SA can write to `inline-agent-widget-malicious-prefix/*`.

---

## Appendix — John Roman's two Slack questions (2026-10-20)

**Q1 — "Any reason a GCP SA wouldn't be provisioned?"** (asking about Path C)
No disagreement. Path C requires an SFCC-owned GCP SA. The two PCS/IAM intake threads Helen linked (`#enterprise-iam-support`, `#gcp-dev-support`) got no traction over three weeks. Path B does not depend on an SFCC SA — Cimulate owns the SA, SFCC's repo just gets a short-lived token via WIF. Path B is what we're building.

**Q2 — "Why curl over gcloud storage? gcloud should be the preferred method. I didn't understand what you meant by 'both list the destination first.'"**
John is pushing on a real org convention (gcloud is the paved path). On Path B specifically, we cannot use gcloud:

- The SA has `roles/storage.objectCreator` only — no `storage.objects.get`, no `storage.objects.list`.
- `gcloud storage cp` and `gsutil cp` both do a preflight `objects.get` (check if destination exists) and sometimes `objects.list` (resolve path) before issuing the PUT. Those API calls return 403.
- `curl -X PUT` goes straight to `storage.objects.insert` — the one permission the SA has.
- Overwrite protection is enforced by `x-goog-if-generation-match: 0` on the PUT, which is a GCS header curl sends verbatim.

Switching to gcloud requires widening the role (toward `objectAdmin` or `objectUser`), which eliminates the Path B / Path A IAM distinction. gcloud is the paved path when your SA has broad bucket roles. For a cross-org, create-only, prefix-scoped SA, curl is the correct verb.
