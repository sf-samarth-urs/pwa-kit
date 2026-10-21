# Publish inline-agent-widget to the Cimulate CDN

In this document, "inline-agent widget" means the `SalesforceCommerceCloud/inline-agent-widget` project, and `copilot-widget` is a different Cimulate package.

**Status: Three options. Build one path.**

`SalesforceCommerceCloud/inline-agent-widget` needs `dist/inline-agent-widget.umd.js` on `gs://copilot-bundles`, served from `https://cdn.search.cimulate.ai`. This doc is for Cimulate engineers and for the inline-agent widget developers. It describes three ways to publish that file.

| If you are | Read |
| --- | --- |
| Choosing a path | [How to choose](#how-to-choose), [comparison](#comparison), and [constraints on Path C](#constraints-on-path-c) |
| Cimulate, Path A — Release asset | [Path A — Cimulate](#path-a--cimulate) |
| Inline-agent widget repo, Path A — Release asset | [Path A — inline-agent-widget](#path-a--inline-agent-widget-salesforcecommercecloud) |
| Cimulate, Path B — Direct upload | [Path B — Cimulate](#path-b--cimulate) |
| Inline-agent widget repo, Path B — Direct upload | [Path B — inline-agent-widget](#path-b--inline-agent-widget-salesforcecommercecloud) |
| Cimulate, Path C — External service account | [Path C — Cimulate](#path-c--cimulate) |
| Inline-agent widget repo, Path C — External service account | [Path C — inline-agent-widget](#path-c--inline-agent-widget-salesforcecommercecloud) |

All three paths use the [object contract](#object-contract). Agree on that table before the first Path A release, the first Path B `terraform apply`, or the Path C bucket grant.

## How to choose

Read [Comparison](#comparison). Each row is a tradeoff. Build one path. Path A does not create the Workload Identity pool. Path B does not add the Cimulate dispatch workflow. Path C does not add Path A's dispatch workflow or Path B's Cimulate Workload Identity pool.

**Path A — Release asset.** The inline-agent widget repo attaches `inline-agent-widget.umd.js` to a GitHub Release. A Cimulate operator runs `workflow_dispatch` with the tag, the commit SHA, and the sha256. The existing CI identity uploads behind the `prod` environment. The inline-agent widget repo does not authenticate to GCP.

**Path B — Direct upload.** Cimulate creates a Workload Identity pool and a service account with create-only access on the `inline-agent-widget/` prefix. A `v*` tag push in the inline-agent widget repo uploads the file. There is no JSON key, and no further Cimulate step after the pool exists.

**Path C — External service account.** The inline-agent widget team owns the service account. They send Cimulate the email. Cimulate grants that email create-only access on the `inline-agent-widget/` prefix. Cimulate does not create the account, does not create a key, and does not create a Workload Identity pool. Cimulate devops is asking for this path. Constraints are in [Constraints on Path C](#constraints-on-path-c).

Identity:

- Path A: no credential in the inline-agent widget repo. Cimulate downloads a GitHub Release asset and uploads with the existing CI identity.
- Path B: Cimulate owns the service account and the Workload Identity pool. The inline-agent widget repo gets a short-lived token. No JSON key.
- Path C: the inline-agent widget team owns the service account. Cimulate's part is a prefix-scoped bucket grant to the email they send.

## Comparison

Each row is a tradeoff: what that path gives you, and what it costs.

| | Path A — Release asset | Path B — Direct upload | Path C — External service account |
| --- | --- | --- | --- |
| Who owns the GCP identity | Cimulate. The new workflow uses the existing CI service account behind `vars.GCP_SERVICE_ACCOUNT` on `cimulate-ai/cimulate`. | Cimulate. A new service account, `inline-agent-widget-cdn@cimulate-search-api.iam.gserviceaccount.com`. The inline-agent widget repo stores the provider resource name and that email as Actions variables. | The inline-agent widget team's service account. They send Cimulate the email. Cimulate does not create the account. |
| Salesforce-side GCP project, service account, or key | None. The inline-agent widget repo does not authenticate to GCP. | None. Auth is Workload Identity Federation. No JSON key. The inline-agent widget team does not create the account. | They request the account through PCS. No key if they use a Workload Identity pool in their own GCP project. A JSON key if they do not, and that key exists only if PCS allows it. Cimulate does not create the account, the key, or a pool. |
| Who can cause bytes to land on the public CDN | A Cimulate operator who runs `workflow_dispatch`, after a `prod` required reviewer approves. | Anyone who can push a `v*` tag on `SalesforceCommerceCloud/inline-agent-widget` while the workflow file is `.github/workflows/publish-cdn.yml`. | Whoever can run their tag workflow, once the bucket grant exists. Cimulate does not approve each release. |
| Approval / review control Cimulate owns | The `prod` environment (required reviewers, self-review disabled, deployment branches limited to `master`), plus the workflow's SHA and sha256 checks. The reviewer sees the tag, the SHA, and the digest. | The prefix-scoped IAM grant. A required-reviewer GitHub environment on the inline-agent widget job is administered by that repo. Cimulate does not control it, and adding or removing the environment does not change `workflow_ref`. | The prefix-scoped IAM grant, which Cimulate can revoke. Cimulate does not check the SHA or the digest. |
| Speed and operational dependency | One manual `workflow_dispatch` per release, with the tag, SHA, and digest. Slower, and it waits on Cimulate. A later Cimulate-owned job could watch for releases. This plan does not design that job. | After the pool exists, a tag push publishes with no further Cimulate step. | After the grant, a tag push publishes with no Cimulate step. Getting the account provisioned is the slow part and depends on PCS. |
| IAM blast radius | The existing CI service account has `roles/storage.objectAdmin` on the whole `copilot-bundles` bucket, including `copilot-widget/`. The workflow hardcodes the destination prefix, keeps `--if-generation-match=0`, and does not take the object path as input. Those are workflow controls. The account's IAM still covers the whole bucket. | The new account gets `roles/storage.objectCreator` only, conditioned on the `inline-agent-widget/` prefix. No list, no read, no delete, no replace. No project roles. | Cimulate grants `roles/storage.objectCreator` only, conditioned on `inline-agent-widget/`, to that external email. Create-only: no list, no read, no delete, no replace. Generation match `0` and `Cache-Control` are set on create. Not `roles/storage.objectAdmin`. Not the `github-arc` `externalBuckets` `copilot-bundles: write` grant, which is unconditional `objectAdmin` on the whole bucket. |
| What is verified | The tag's commit SHA, and the sha256 of the GitHub Release asset `inline-agent-widget.umd.js`. The job resolves the tag and hashes the downloaded file again before upload. | The Workload Identity condition checks the repository, the workflow filename, and that the ref is a tag. The uploaded bytes are whatever that workflow puts in the object. | The workflow file and tag rules are theirs. Cimulate does not re-check the artifact. Cimulate cannot impersonate a service account in their project, so the Path B `gcloud auth print-access-token --impersonate-service-account` negative test does not apply. Cimulate confirms the binding. Both sides `curl` the CDN URL after the first real tag. |

## Object contract

All three paths publish this object. The version segment is the tag with the leading `v` removed.

| Item | Value |
| --- | --- |
| Build output | `dist/inline-agent-widget.umd.js`, produced by `npm run build` in `SalesforceCommerceCloud/inline-agent-widget`. |
| Bucket | `gs://copilot-bundles` (project `cimulate-search-api`, location `US`). Terraform resource `google_storage_bucket.copilot_bundles_bucket` in `infrastructure/terraform/configurations/environments/common-cimulate-search-api/buckets.tf`. |
| Object | `gs://copilot-bundles/inline-agent-widget/<version>/inline-agent-widget.umd.js` |
| Version segment | Tag `v1.2.3` publishes version `1.2.3`. Path A uses `${tag#v}`. Path B and Path C use `${GITHUB_REF_NAME#v}`. The URL has no `v`. |
| Allowed version characters | One path segment: `A-Za-z0-9._-` |
| Cache-Control | `public, max-age=3600`, set when the object is created. |
| CDN URL | `https://cdn.search.cimulate.ai/inline-agent-widget/<version>/inline-agent-widget.umd.js` |
| Origin URL | `https://storage.googleapis.com/copilot-bundles/inline-agent-widget/<version>/inline-agent-widget.umd.js` |

Example for tag `v1.2.3`:

```text
gs://copilot-bundles/inline-agent-widget/1.2.3/inline-agent-widget.umd.js
https://cdn.search.cimulate.ai/inline-agent-widget/1.2.3/inline-agent-widget.umd.js
```

Shared publish rules:

- The same object name is immutable. The upload sets generation match `0`, so a second write of that name fails. Ship a fix as a new tag (a new URL).
- This plan adds no CDN invalidation. Each version is a new object name. If the origin URL is `200` and the CDN URL is `404`, retry the CDN URL.
- A Cimulate bucket admin can delete a bad object. The service accounts used by Path B and Path C cannot. A deleted object can remain on `cdn.search.cimulate.ai` until `max-age=3600` expires.
- Anonymous GET and listing already work on this bucket. The public binding is not in git. Confirm a new object with `curl`. Do not add an `allUsers` binding for this work.

The existing copilot-widget publish, which Path A reuses for identity and approval, is `.github/workflows/build-and-publish-js.yaml`:

- Push to `master` under `javascript/**`, and the job runs only when the changed-folder matrix is exactly `["copilot-widget"]`.
- Environment `prod`, runner `cimulate-build`, `id-token: write`.
- Auth is `google-github-actions/auth@v2.1.2` with `vars.GCP_SERVICE_ACCOUNT` and `vars.GCP_WORKLOAD_IDENTITY_PROVIDER`. Cloud SDK setup is `google-github-actions/setup-gcloud@v1` with `vars.GCP_PROJECT_ID`.
- It copies `./dist/*.umd.js` and `./dist/*.css` with `gsutil cp` to `gs://${{ vars.COPILOT_BUNDLES_BUCKET }}/copilot-widget/<version>/`.
- `vars.COPILOT_BUNDLES_BUCKET` is written by Pulumi stack `github-arc` / `prod.build.us-central1` from the `externalBuckets` key `copilot-bundles`. This plan's destination bucket is the Terraform bucket `copilot-bundles`.

Leave `build-and-publish-js.yaml` unchanged. Path A is a sibling workflow.

## Path A — Release asset

Build one path. These steps are for the release-asset option.

The inline-agent widget repo attaches `inline-agent-widget.umd.js` to a GitHub Release. A manually triggered workflow in `cimulate-ai/cimulate` checks the tag's commit SHA and the file's sha256, then uploads with the existing publish identity into the `inline-agent-widget/` prefix, behind the `prod` environment.

`SalesforceCommerceCloud/inline-agent-widget` does not authenticate to GCP and does not receive `GCP_WORKLOAD_IDENTITY_PROVIDER` or `GCP_SERVICE_ACCOUNT`.

### Caveats

- The workflow reuses Cimulate's existing CI service account. That account has `roles/storage.objectAdmin` on the whole bucket, including `copilot-widget/`, and can already overwrite those objects. A free-form bucket path is unsafe. Hardcode the destination `gs://copilot-bundles/inline-agent-widget/<version>/inline-agent-widget.umd.js`. The version may be derived from the tag input. The bucket, the prefix, and the filename are fixed in the workflow and are not inputs. Keep `--if-generation-match=0` so the same key is not replaced. The control is workflow discipline. The account's IAM still covers the whole bucket.
- Each release needs a manual `workflow_dispatch` by Cimulate with the tag, the SHA, and the digest. That is slower, and it ties releases to Cimulate's availability. It could be automated later, for example by a Cimulate-owned scheduled job that watches for releases. This plan does not design that job.
- Security depends on GitHub Release assets being the source of truth. Required PR approvals and tag-immutability rulesets on the inline-agent widget repo are hygiene. Org admins can bypass them. The gate Cimulate controls is `prod` required reviewers plus the pinned SHA and digest.

### Order

1. Both sides agree on the [object contract](#object-contract).
2. The inline-agent widget team builds the file, tags the commit, attaches `inline-agent-widget.umd.js` to a GitHub Release, and sends Cimulate the tag. Release notes include the commit SHA and the sha256.
3. Cimulate runs `workflow_dispatch` on `master` with `tag`, `sha`, and `sha256`.
4. A `prod` required reviewer approves. Self-review is disabled. The deployment branch rule is limited to `master`.
5. Both sides confirm the CDN URL.

### Path A — Cimulate

Add `.github/workflows/publish-inline-agent-widget-cdn.yaml` in `cimulate-ai/cimulate`. It declares only `workflow_dispatch`. It has no `push`, `release`, or `repository_dispatch` trigger, so the inline-agent widget repository cannot start it. Run it after the release asset exists.

Download the public release asset. Leave the inline-agent widget repository unchecked-out. Cimulate CI does not run their build. A public release URL needs no PAT. Their repository may stay public.

`gcloud storage cp` is acceptable on this path because this service account already has list and delete on the bucket. It is unacceptable for the `objectCreator` accounts on Path B and Path C. Do not point the inline-agent widget repo at `GCP_SERVICE_ACCOUNT` or `GCP_WORKLOAD_IDENTITY_PROVIDER` from `cimulate-ai/cimulate`.

#### Inputs

All three inputs are required strings. The bucket, the prefix, and the filename stay hardcoded in the workflow.

- `tag`: release tag, for example `v1.4.0`
- `sha`: full commit SHA the tag points at
- `sha256`: sha256 of `inline-agent-widget.umd.js`

```yaml
on:
  workflow_dispatch:
    inputs:
      tag:
        description: "Release tag, e.g. v1.4.0"
        required: true
        type: string
      sha:
        description: "Full commit SHA the tag points at"
        required: true
        type: string
      sha256:
        description: "sha256 of inline-agent-widget.umd.js"
        required: true
        type: string
```

On the Actions tab, choose this workflow and click Run workflow. The UI opens a form with a branch selector and one text box per string input. The description is the label. `required: true` fields must be filled before the run starts. Choice inputs would be dropdowns and boolean inputs checkboxes. These three are text boxes. Select `master` in the branch selector.

```bash
gh workflow run publish-inline-agent-widget-cdn.yaml \
  --repo cimulate-ai/cimulate \
  --ref master \
  -f tag=v1.4.0 \
  -f sha=<full-commit-sha> \
  -f sha256=<digest-of-the-umd>
```

The job uses the `prod` environment, so GitHub pauses until a required reviewer approves. The reviewer sees the tag, the SHA, and the digest on the approval screen. Self-review is disabled. The deployment branch rule is limited to `master`.

#### Where the SHA and the digest come from

Take the SHA and the digest from the `SalesforceCommerceCloud/inline-agent-widget` release. On the release page, click the short commit next to the tag and copy the full 40-character SHA.

```bash
gh api repos/SalesforceCommerceCloud/inline-agent-widget/commits/v1.4.0 --jq .sha
```

The workflow resolves the tag again at run time and fails if it is no longer that commit.

GitHub does not show a digest for release assets. Download the asset and hash it:

```bash
gh release download v1.4.0 \
  --repo SalesforceCommerceCloud/inline-agent-widget \
  --pattern inline-agent-widget.umd.js
shasum -a 256 inline-agent-widget.umd.js
```

The workflow downloads the same asset and rejects the run if the hash differs. The inline-agent widget team can print both values in the release notes. The job still recomputes the hash from the downloaded asset.

#### Workflow

`GCP_SERVICE_ACCOUNT` and `GCP_WORKLOAD_IDENTITY_PROVIDER` on `cimulate-ai/cimulate` are Actions variables. Pulumi stack `github-arc` / `prod.build.us-central1` writes them from `infrastructure/pulumi/projects/github-arc/index.ts` through `infrastructure/pulumi/packages/pulumi-infra-github/src/actions/actions_variables.ts`. `GCP_PROJECT_ID` is referenced by `build-and-publish-js.yaml` and is not set by that Pulumi code. Use the variables already on this repository. Do not look up `GCP_PROJECT_ID` to forward it, and do not send these variables to the inline-agent widget repo.

The CI service account behind those variables has `roles/artifactregistry.admin`, `roles/iam.serviceAccountTokenCreator`, and `roles/storage.admin` on project `cimulate-build`, plus `roles/storage.objectAdmin` and `roles/storage.bucketViewer` on the whole `copilot-bundles` bucket. That is why the destination below is hardcoded.

```yaml
name: Publish inline-agent-widget CDN

on:
  workflow_dispatch:
    inputs:
      tag:
        description: "Release tag, e.g. v1.4.0"
        required: true
        type: string
      sha:
        description: "Full commit SHA the tag points at"
        required: true
        type: string
      sha256:
        description: "sha256 of inline-agent-widget.umd.js"
        required: true
        type: string

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: cimulate-build
    environment: prod
    steps:
      - uses: google-github-actions/auth@v2.1.2
        with:
          service_account: ${{ vars.GCP_SERVICE_ACCOUNT }}
          workload_identity_provider: ${{ vars.GCP_WORKLOAD_IDENTITY_PROVIDER }}

      - uses: google-github-actions/setup-gcloud@v1
        with:
          project_id: ${{ vars.GCP_PROJECT_ID }}

      - name: Download the release asset and upload
        run: |
          set -euo pipefail
          tag="${{ inputs.tag }}"
          sha="${{ inputs.sha }}"
          sha256="${{ inputs.sha256 }}"
          version="${tag#v}"
          case "${version}" in
            ""|*[!A-Za-z0-9._-]*)
              echo "Tag must look like v1.2.3"
              exit 1
              ;;
          esac
          resolved="$(
            curl -fsSL \
              -H "Accept: application/vnd.github+json" \
              "https://api.github.com/repos/SalesforceCommerceCloud/inline-agent-widget/commits/${tag}" \
              | python3 -c 'import json,sys; print(json.load(sys.stdin)["sha"])'
          )"
          if [ "${resolved}" != "${sha}" ]; then
            echo "Tag ${tag} points at ${resolved}, not ${sha}"
            exit 1
          fi
          curl -fL -o inline-agent-widget.umd.js \
            "https://github.com/SalesforceCommerceCloud/inline-agent-widget/releases/download/${tag}/inline-agent-widget.umd.js"
          echo "${sha256}  inline-agent-widget.umd.js" | sha256sum -c -
          gcloud config set storage/parallel_composite_upload_enabled False
          gcloud storage cp \
            --cache-control="public, max-age=3600" \
            --content-type="text/javascript" \
            --if-generation-match=0 \
            inline-agent-widget.umd.js \
            "gs://copilot-bundles/inline-agent-widget/${version}/inline-agent-widget.umd.js"
```

#### Confirm

For tag `v1.4.0` (version segment `1.4.0`):

```bash
curl -sI "https://cdn.search.cimulate.ai/inline-agent-widget/1.4.0/inline-agent-widget.umd.js"
```

Expect `200` and `cache-control: public, max-age=3600`. Running the same object name again fails, which is expected. Cleanup of a real version is a Cimulate bucket admin deleting that object.

### Path A — inline-agent-widget (SalesforceCommerceCloud)

Follow this section when Cimulate has chosen Path A. You do not authenticate to GCP. Build the file, tag the commit, attach that file to a GitHub Release, and send Cimulate the tag.

You do not:

- Create a GCP project, a service account, or a JSON key.
- Store `GCP_WORKLOAD_IDENTITY_PROVIDER` or `GCP_SERVICE_ACCOUNT`.
- Add `.github/workflows/publish-cdn.yml`, or upload to the bucket yourself.

The object name and CDN URL are the [object contract](#object-contract).

#### 1. Build and tag

Build so `dist/inline-agent-widget.umd.js` exists (`npm run build`). The asset filename on the release must be exactly `inline-agent-widget.umd.js`, not a versioned filename.

Version tags match the contract: `v*` (example `v1.4.0`). The version segment is the tag with the leading `v` stripped, so tag `v1.4.0` publishes version `1.4.0`. The URL has no `v`. That version is object path `inline-agent-widget/1.4.0/inline-agent-widget.umd.js` and CDN URL `https://cdn.search.cimulate.ai/inline-agent-widget/1.4.0/inline-agent-widget.umd.js`.

Create the tag on the commit you intend to ship, from the default branch, after the build artifact for that commit is the one you will attach. An annotated tag is fine. Leave a tag that was already published where it is. Moving the tag later makes Cimulate's SHA check fail.

```bash
git checkout <full-commit-sha>
git tag -a v1.4.0 -m "v1.4.0"
git push origin v1.4.0
```

#### 2. Attach the release asset

Create a GitHub Release for that tag and upload the file as a release asset named `inline-agent-widget.umd.js`.

GitHub UI: Releases → Draft a new release → choose the existing tag `v1.4.0` → attach `dist/inline-agent-widget.umd.js` → Publish release. The uploaded filename must stay `inline-agent-widget.umd.js`.

CLI: the asset path argument sets the release asset name. The file must already be named `inline-agent-widget.umd.js`.

```bash
gh release create v1.4.0 dist/inline-agent-widget.umd.js --repo SalesforceCommerceCloud/inline-agent-widget --title "v1.4.0" --notes "Commit SHA: <full-sha>. sha256: <digest>."
```

#### 3. Hand off the tag, SHA, and digest

In the release notes, paste the two values Cimulate types into `workflow_dispatch`:

- Commit SHA: `gh api repos/SalesforceCommerceCloud/inline-agent-widget/commits/v1.4.0 --jq .sha`, or the full SHA from the commit the tag points at.
- sha256: `shasum -a 256 dist/inline-agent-widget.umd.js`

Cimulate recomputes both from the release. The notes are the handoff. The digest must be of the exact file attached to the release.

Tell Cimulate the tag. They run `workflow_dispatch` on `cimulate-ai/cimulate`. You do not run a GCP upload.

#### 4. Confirm

```bash
curl -sI "https://cdn.search.cimulate.ai/inline-agent-widget/1.4.0/inline-agent-widget.umd.js"
```

Expect `200`. You cannot upload a second time yourself. Cimulate's upload of the same object name fails if repeated, which is expected. To ship a fix, cut a new tag. Ask Cimulate if a bad version has to be removed.

## Path B — Direct upload

Build one path. These steps are for the direct-upload option.

Cimulate creates a new Workload Identity pool and a new service account with create-only access on the `inline-agent-widget/` prefix. The inline-agent widget repo's GitHub Action uploads directly. No JSON key. The inline-agent widget team does not create a GCP project or a service account.

Cimulate devops's stated concern was that a Cimulate-created account would be used via a JSON key given to the inline-agent widget developers, and that key would have to be rotated. [Path C](#path-c--external-service-account) is their proposed alternative. Path B answers that concern with Workload Identity and no key: the handoff is the Workload Identity provider resource name and the service account email, stored as Actions variables, and GitHub exchanges a short-lived OIDC token for a short-lived GCP token. There is no JSON key to rotate, which matches the existing prohibition on `google_service_account_key`. Path C answers that concern only when the inline-agent widget team uses their own Workload Identity pool. A JSON key on Path C recreates the rotation problem on their side.

Anyone who can push a `v*` tag can publish arbitrary bytes under `inline-agent-widget/` on `cdn.search.cimulate.ai`. Cimulate does not control that boundary. Auth is Workload Identity Federation, so this path needs no JSON key.

### Order

1. Both sides agree on the [object contract](#object-contract) and the [Path B strings](#path-b-strings) below.
2. Cimulate applies Terraform and sends the two values from the apply output.
3. Inline-agent widget developers store those values as repository variables and add `.github/workflows/publish-cdn.yml`.
4. They push a `v*` tag. Both sides run the verification checklist.

### Path B strings

The provider CEL and the bucket IAM condition are pinned to these strings.

| Item | Value |
| --- | --- |
| Workflow file | `.github/workflows/publish-cdn.yml` on `SalesforceCommerceCloud/inline-agent-widget`. Extension is `.yml`. |
| Tag trigger | Push of tags matching `v*` (`refs/tags/v…`). |
| Runner | `ubuntu-latest`. The `cimulate-build` runner belongs to Cimulate. |
| Auth variables | Repository Actions variables (not secrets) `GCP_WORKLOAD_IDENTITY_PROVIDER` and `GCP_SERVICE_ACCOUNT` on `SalesforceCommerceCloud/inline-agent-widget`. |

The provider accepts any `refs/tags/` ref. The workflow's `v*` trigger and the `#v` strip keep the version scheme. Treat those as the check for a leading `v`. The CEL allows any tag ref.

Proposed GCP names, declared here so the sketches stay consistent. These resources do not exist yet:

| Proposed id | Resource |
| --- | --- |
| `inline-agent-widget` | Workload Identity pool id |
| `github` | Workload Identity provider id on that pool |
| `inline-agent-widget-cdn` | Service account id |

Expected identities after apply (the project number is not in git; read the provider string from the output):

- Provider: `projects/<cimulate-search-api project number>/locations/global/workloadIdentityPools/inline-agent-widget/providers/github`
- Service account: `inline-agent-widget-cdn@cimulate-search-api.iam.gserviceaccount.com`

### Path B — Cimulate

You apply this in the cimulate monorepo. Inline-agent widget developers do not.

#### Strategy

Create a new Workload Identity pool and provider in project `cimulate-search-api`, and a new service account with no project roles. Grant that account create-only `roles/storage.objectCreator` on the prefix `inline-agent-widget/` of `gs://copilot-bundles`. Leave the `github-arc` pool, provider, and CI service account unused for this publish.

`roles/storage.objectCreator` is create-only: no list, no read, no delete, no replace. A second PUT of the same object name fails. That is the overwrite lock. This account cannot patch metadata after create, so `Cache-Control: public, max-age=3600` has to be on the create.

#### 1. Add the Terraform

Add a new file next to the bucket, in the same configuration as `buckets.tf`:

`infrastructure/terraform/configurations/environments/common-cimulate-search-api/inline-agent-widget-cdn.tf`

Provider project is already `cimulate-search-api` (`main.tf`). State backend is already `gs://cimulate-tf-state-files`, prefix `common-cimulate-search-api/state`. Do not create a second state. Do not create the pool in project `cimulate-build`.

Use Terraform beside `buckets.tf` because `WorkloadIdentityFederation` cannot express this policy. It interpolates one equality and builds the IAM member from that same attribute:

```hcl
assertion.${attribute} == '${value}'
principalSet://iam.googleapis.com/${pool.name}/attribute.${attribute}/${value}
```

`github-arc` calls it with attribute `repository_owner` and value `cimulate-ai`. This publish needs a raw CEL expression that ANDs `assertion.repository` with `assertion.workflow_ref.startsWith(...)`, and an IAM member on `attribute.repository`, which is not the attribute inside the CEL. A second provider on the `github-arc` pool, or an edit that ORs in another org, is out of scope. A new Pulumi stack would still call `gcp.iam.WorkloadIdentityPoolProvider` by hand, in a project this Terraform configuration already targets.

Paste the resources below into `inline-agent-widget-cdn.tf`. Pool id `inline-agent-widget`, provider id `github`, and service account id `inline-agent-widget-cdn` are proposed names, not existing resources. If apply says one of those ids is already taken, stop. Do not bind this repo to some other account.

```hcl
resource "google_iam_workload_identity_pool" "inline_agent_widget" {
  project                   = "cimulate-search-api"
  workload_identity_pool_id = "inline-agent-widget"
  display_name              = "inline-agent-widget"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = "cimulate-search-api"
  workload_identity_pool_id          = google_iam_workload_identity_pool.inline_agent_widget.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub Actions"

  # Leave allowed_audiences unset. The default audience is this provider's
  # resource name, which is what google-github-actions/auth@v2 requests.
  attribute_condition = "assertion.repository == 'SalesforceCommerceCloud/inline-agent-widget' && assertion.workflow_ref.startsWith('SalesforceCommerceCloud/inline-agent-widget/.github/workflows/publish-cdn.yml@refs/tags/')"

  attribute_mapping = {
    "google.subject"             = "assertion.sub"
    "attribute.repository"       = "assertion.repository"
    "attribute.repository_owner" = "assertion.repository_owner"
    "attribute.workflow_ref"     = "assertion.workflow_ref"
  }

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "inline_agent_widget_cdn" {
  project      = "cimulate-search-api"
  account_id   = "inline-agent-widget-cdn"
  display_name = "inline-agent-widget CDN publisher"
}

resource "google_service_account_iam_member" "inline_agent_widget_wif" {
  service_account_id = google_service_account.inline_agent_widget_cdn.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.inline_agent_widget.name}/attribute.repository/SalesforceCommerceCloud/inline-agent-widget"
}

resource "google_storage_bucket_iam_member" "inline_agent_widget_object_creator" {
  bucket = google_storage_bucket.copilot_bundles_bucket.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.inline_agent_widget_cdn.email}"

  condition {
    title       = "inline-agent-widget-prefix"
    description = "Trailing slash is required so inline-agent-widget-other does not match."
    expression  = "resource.name.startsWith(\"projects/_/buckets/copilot-bundles/objects/inline-agent-widget/\")"
  }
}

output "inline_agent_widget_workload_identity_provider" {
  description = "Actions variable GCP_WORKLOAD_IDENTITY_PROVIDER for SalesforceCommerceCloud/inline-agent-widget. Not a secret. Read after apply."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "inline_agent_widget_cdn_service_account" {
  description = "Actions variable GCP_SERVICE_ACCOUNT for SalesforceCommerceCloud/inline-agent-widget. Not a secret. Read after apply."
  value       = google_service_account.inline_agent_widget_cdn.email
}
```

Notes that are easy to simplify and break:

- The CEL reads `assertion.repository` and `assertion.workflow_ref`. Mapped `attribute.*` values are not available in `attribute_condition`. The `attribute.repository` mapping is what the `principalSet` binding uses. Mapping `repository_owner` does not trust the SalesforceCommerceCloud org.
- The IAM member does not include `/providers/github`. The provider resource name and the `principalSet` are different strings.
- `roles/storage.objectCreator` is create-only: no list, no read, no delete, no replace. A second PUT of the same object name fails. That is the overwrite lock.
- The condition's trailing slash is load-bearing.
- `service_account_id` is `google_service_account.inline_agent_widget_cdn.name` (the `projects/.../serviceAccounts/...` id), not the email.

#### 2. Plan, then apply

From `infrastructure/terraform/configurations/environments/common-cimulate-search-api`, using whatever credential you already use to apply this configuration:

```bash
terraform plan
terraform apply
```

Stop if the plan changes `google_storage_bucket.copilot_bundles_bucket` (that resource has `force_destroy = true`), recreates the bucket, edits `github-arc`, adds `google_service_account_key`, adds `google_project_iam_member`, or adds `allUsers`. The plan should add the pool, the provider, the service account, the workloadIdentityUser binding, the conditional objectCreator binding, and two outputs.

The provider resource name is computed at apply time. Hand off the value from `terraform output` after apply. A string copied out of the plan is the wrong value to send.

#### 3. Read the two values from the apply output

```bash
gcloud projects describe cimulate-search-api --format='value(projectNumber)'
terraform output -raw inline_agent_widget_workload_identity_provider
echo
terraform output -raw inline_agent_widget_cdn_service_account
echo
```

Check the output before you send it:

- The provider string starts with `projects/<number>` where `<number>` is the `cimulate-search-api` project number you just printed. It contains `workloadIdentityPools/inline-agent-widget/providers/github`. It does not contain `workloadIdentityPools/github-arc`.
- The email is `inline-agent-widget-cdn@cimulate-search-api.iam.gserviceaccount.com`.

These two strings are not in git. `terraform output` is where you read them after apply.

Send exactly this, with the output pasted in, to the inline-agent widget developers. Send the new account's values. Leave the variables from `cimulate-ai/cimulate` unsent.

```text
GCP_WORKLOAD_IDENTITY_PROVIDER=<provider output>
GCP_SERVICE_ACCOUNT=<service account output>
```

#### 4. Check the IAM you actually applied

```bash
gcloud projects get-iam-policy cimulate-search-api \
  --flatten="bindings[].members" \
  --filter="bindings.members:inline-agent-widget-cdn@cimulate-search-api.iam.gserviceaccount.com" \
  --format="value(bindings.role)"

gcloud projects get-iam-policy cimulate-build \
  --flatten="bindings[].members" \
  --filter="bindings.members:inline-agent-widget-cdn@cimulate-search-api.iam.gserviceaccount.com" \
  --format="value(bindings.role)"

gcloud storage buckets get-iam-policy gs://copilot-bundles --format=json
```

Both project policy commands print nothing. On the bucket, that service account has one binding: `roles/storage.objectCreator`, condition expression `resource.name.startsWith("projects/_/buckets/copilot-bundles/objects/inline-agent-widget/")`. No `objectAdmin`, `objectUser`, `objectViewer`, or `bucketViewer` for this member. Leave every other bucket member as you found it.

#### 5. Verification checklist

`roles/storage.objectCreator` cannot delete. Any object you create here is world-readable immediately, and this service account cannot remove it. Delete a test object with a principal that already administers `copilot-bundles`. Leave this service account on `objectCreator`.

Run the negative test yourself. The Salesforce workflow should not be asked to upload into `copilot-widget/`.

If your user can already impersonate service accounts, mint a token. If `print-access-token` returns `iam.serviceAccounts.getAccessToken` denied, stop. Leave `roles/iam.serviceAccountTokenCreator` off this account. Granting it to unblock the test is out of scope.

```bash
SA=inline-agent-widget-cdn@cimulate-search-api.iam.gserviceaccount.com
TOKEN="$(gcloud auth print-access-token --impersonate-service-account="${SA}")"
echo 'test' > /tmp/inline-agent-widget.umd.js

put() {
  curl -sS -o /tmp/gcs-upload-body -w "%{http_code}" -X PUT \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: text/javascript" \
    -H "Cache-Control: public, max-age=3600" \
    -H "x-goog-if-generation-match: 0" \
    --data-binary @/tmp/inline-agent-widget.umd.js \
    "$1"
}

echo "prefix denial $(put "https://storage.googleapis.com/copilot-bundles/copilot-widget/iaw-deny-test.js")"
echo "first create $(put "https://storage.googleapis.com/copilot-bundles/inline-agent-widget/0.0.0-iam-test/inline-agent-widget.umd.js")"
echo "second create $(put "https://storage.googleapis.com/copilot-bundles/inline-agent-widget/0.0.0-iam-test/inline-agent-widget.umd.js")"
```

Expected:

- Prefix denial: HTTP `403`. Then `curl -sI https://storage.googleapis.com/copilot-bundles/copilot-widget/iaw-deny-test.js` is `404`.
- First create: HTTP `200`. Then both of these are `200` and `cache-control` is `public, max-age=3600`:
  - `https://cdn.search.cimulate.ai/inline-agent-widget/0.0.0-iam-test/inline-agent-widget.umd.js`
  - `https://storage.googleapis.com/copilot-bundles/inline-agent-widget/0.0.0-iam-test/inline-agent-widget.umd.js`
- Second create of the same key: HTTP `412`. The CDN URL stays `200`.

If the CDN URL is `404` while the `storage.googleapis.com` URL is `200`, retry the CDN URL. This repo has no CDN invalidation step. Do not add one for a new object name.

Delete `gs://copilot-bundles/inline-agent-widget/0.0.0-iam-test/inline-agent-widget.umd.js` with an existing bucket admin when the check is done. A deleted object can remain on `cdn.search.cimulate.ai` until `max-age=3600` expires.

After their first real tag (example `v1.2.3`, version segment `1.2.3`):

1. `curl -sI https://cdn.search.cimulate.ai/inline-agent-widget/1.2.3/inline-agent-widget.umd.js` returns `200` and `cache-control: public, max-age=3600`.
2. Re-run that GitHub job. The upload step fails with HTTP `412`. The CDN URL still returns `200`. A second response of `200` means the same key was written again. Stop and fix that before any further tags.
3. The prefix denial check above returned `403`, and the deny-test object was not created.

There is no invalidation workflow. Each version is a new object name. This account cannot replace or delete a bad version. Cleanup of a real version is a Cimulate bucket admin deleting that object.

#### 6. Risks

A workflow run in `SalesforceCommerceCloud/inline-agent-widget`, on a tag, whose workflow file path is `.github/workflows/publish-cdn.yml`, can upload any bytes under `inline-agent-widget/` on `cdn.search.cimulate.ai`. The CEL checks the repository, the workflow filename, and that the ref is a tag. It does not check the file contents. They can edit that workflow and push a tag. Those objects are public as soon as the PUT succeeds.

The prefix condition blocks creates outside `inline-agent-widget/`, including `copilot-widget/` and objects at the bucket root. It does not block a new name inside the prefix.

A GitHub environment with required reviewers on their job is useful. They administer that repository, so they can remove the environment. It is not a boundary Cimulate controls. Adding or removing an environment does not change `workflow_ref`.

### Path B — inline-agent-widget (SalesforceCommerceCloud)

Follow this section when Cimulate has chosen Path B. You do not need a GCP account. Cimulate will send two strings after they apply their side. Store them, add the workflow below, and push a tag. You cannot see or change their bucket policy.

You do not create a GCP project, a service account, or a JSON key. Cimulate creates the identity. You store two non-secret Actions variables.

#### 1. Store the two values

Cimulate sends:

```text
GCP_WORKLOAD_IDENTITY_PROVIDER=<provider resource name>
GCP_SERVICE_ACCOUNT=<service account email>
```

On `https://github.com/SalesforceCommerceCloud/inline-agent-widget`: Settings → Secrets and variables → Actions → Variables → New repository variable. Create two repository variables. Do not create secrets. The workflow reads `vars.*`. A secret with the same name is invisible to `vars` and auth fails.

| Variable name | What the value looks like |
| --- | --- |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/<number>/locations/global/workloadIdentityPools/inline-agent-widget/providers/github` |
| `GCP_SERVICE_ACCOUNT` | `inline-agent-widget-cdn@cimulate-search-api.iam.gserviceaccount.com` |

Reject the pair and ask Cimulate to resend if either of these is true:

- The provider string contains `workloadIdentityPools/github-arc`.
- The email is anything other than `inline-agent-widget-cdn@cimulate-search-api.iam.gserviceaccount.com`.

Those would be Cimulate's own CI identity. Do not use them. Paste the values with no quotes and no trailing space. Set the variables before the first tag. A tag that runs before the variables exist fails auth. Re-running after a failed auth is fine. Re-running after a successful upload fails on purpose.

#### 2. Add this workflow

Create `.github/workflows/publish-cdn.yml`. Cimulate's token policy allows a token only when the workflow path is exactly `.github/workflows/publish-cdn.yml` and the ref is a tag (`refs/tags/`). It does not check the `v` prefix. This file's `v*` trigger is what limits publishes to version tags. The auth step has to live in this file. Do not move it into a reusable workflow with a different filename. `name: Publish CDN` in the file is the Actions display name. The policy uses the filename. The `name:` field is the display name only.

`npm run build` already writes `dist/inline-agent-widget.umd.js`. Node 22 satisfies `engines.node` `>=18`. The Node version is not part of the contract.

The upload is a single HTTP PUT of that file to `gs://copilot-bundles/inline-agent-widget/<version>/inline-agent-widget.umd.js`. The `Cache-Control` header is stored on the object. The account can create an object and cannot list the bucket, read it back, or replace it. `gcloud storage cp` lists the destination before it writes, so this account cannot use that command. Do not swap the PUT for `gcloud storage cp`, `gsutil cp`, or a JSON key.

```yaml
name: Publish CDN

on:
  push:
    tags:
      - "v*"

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Authenticate to Google Cloud
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ vars.GCP_WORKLOAD_IDENTITY_PROVIDER }}
          service_account: ${{ vars.GCP_SERVICE_ACCOUNT }}

      - name: Set up Cloud SDK
        uses: google-github-actions/setup-gcloud@v2

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: npm

      - name: Install, test, and build
        run: |
          npm ci
          npm test
          npm run build
          test -f dist/inline-agent-widget.umd.js

      - name: Upload to gs://copilot-bundles
        run: |
          set -euo pipefail
          tag="${GITHUB_REF_NAME}"
          version="${tag#v}"
          if [ -z "${version}" ] || [ "${version}" = "${tag}" ]; then
            echo "Tag '${tag}' must start with v, for example v1.2.3"
            exit 1
          fi
          case "${version}" in
            *[!A-Za-z0-9._-]*)
              echo "Version '${version}' must be a single path segment"
              exit 1
              ;;
          esac
          object="inline-agent-widget/${version}/inline-agent-widget.umd.js"
          token="$(gcloud auth print-access-token)"
          http_code="$(
            curl -sS -o /tmp/gcs-upload-body -w "%{http_code}" -X PUT \
              -H "Authorization: Bearer ${token}" \
              -H "Content-Type: text/javascript" \
              -H "Cache-Control: public, max-age=3600" \
              -H "x-goog-if-generation-match: 0" \
              --data-binary @dist/inline-agent-widget.umd.js \
              "https://storage.googleapis.com/copilot-bundles/${object}"
          )"
          echo "Upload HTTP ${http_code}"
          echo "gs://copilot-bundles/${object}"
          echo "https://cdn.search.cimulate.ai/${object}"
          if [ "${http_code}" != "200" ]; then
            cat /tmp/gcs-upload-body
            exit 1
          fi
```

`runs-on` is `ubuntu-latest`. The `cimulate-build` runner belongs to Cimulate.

The tagged commit has to contain this file. Merge the workflow, then tag that commit. Tagging an older commit does not run this file.

Do not add `workflow_dispatch` to test from a branch. A branch run does not match the tag rule, and auth fails. Test by pushing a tag.

#### 3. Pinned strings

Cimulate's token rule and bucket rule are pinned to these strings. Changing them makes the publish fail, or publishes to a URL they did not agree to. Ask first, then wait for them to change their side before you tag.

- Workflow path `.github/workflows/publish-cdn.yml` (the extension is `.yml`).
- Tag pattern `v*`.
- Object prefix `inline-agent-widget/`.
- Object filename `inline-agent-widget.umd.js`.
- Cache-Control `public, max-age=3600`. You cannot change it after the object exists.

You can change the Node version without asking.

#### 4. Publish

```bash
git tag v1.2.3
git push origin v1.2.3
```

Use the version you actually released. The job log prints the `gs://` path and the CDN URL. For tag `v1.2.3` those are:

```text
gs://copilot-bundles/inline-agent-widget/1.2.3/inline-agent-widget.umd.js
https://cdn.search.cimulate.ai/inline-agent-widget/1.2.3/inline-agent-widget.umd.js
```

#### 5. Confirm it is up

```bash
curl -sI "https://cdn.search.cimulate.ai/inline-agent-widget/1.2.3/inline-agent-widget.umd.js"
curl -sI "https://storage.googleapis.com/copilot-bundles/inline-agent-widget/1.2.3/inline-agent-widget.umd.js"
```

Both return `200`. `cache-control` is `public, max-age=3600`. If the bucket URL is `200` and the CDN URL is not yet, wait and retry the CDN URL. You cannot invalidate the CDN.

Auth failures to read before you change the workflow path:

| What you see | What it means |
| --- | --- |
| Auth says the workload identity provider is missing | The variable is unset, misnamed, or stored as a secret. `vars` only sees variables. |
| Auth rejects the token | The workflow filename, the repo, or the ref is not a tag of `publish-cdn.yml`. Fix that. Do not ask Cimulate to trust the whole org. |
| Upload HTTP `403` on the first publish of a new version | The object key is outside `inline-agent-widget/`, or the PUT was changed. |
| Upload HTTP `412` on the first publish | An object with that exact name already exists. |

#### 6. A failed second upload is expected

Re-run the same tag's job, or push the same tag again. The upload step fails with HTTP `412`. The file from the first upload stays on the CDN and still returns `200`.

This account cannot replace or delete an object. To ship a fix, push a new tag, for example `v1.2.4`. That creates a new URL. Ask Cimulate if a bad version has to be removed. You cannot remove it.

#### What Cimulate will not give you

- A GCP project, a console login, or a JSON key.
- Their CI service account, their `github-arc` provider, or permission to list the bucket.
- Permission to replace `copilot-widget` objects, root objects, or an `inline-agent-widget` object that is already there.

## Path C — External service account

Build one path. These steps are for the external-service-account option. Path C does not add Path A's dispatch workflow or Path B's Cimulate Workload Identity pool.

The inline-agent widget team owns the service account. Cimulate's part is a prefix-scoped bucket grant to the email they send. Cimulate does not create the account, does not create a key, and does not create a Workload Identity pool for them.

This is a separate option from Path B. On Path A, no credential is in the inline-agent widget repo: Cimulate downloads a GitHub Release asset and uploads with the existing CI identity. On Path B, Cimulate owns the service account and the Workload Identity pool, and the inline-agent widget repo gets a short-lived token. On Path C, the inline-agent widget team owns the service account.

### GitHub Actions still has to authenticate

Owning the service account does not remove the need for GitHub Actions to authenticate as it.

1. **JSON key in GitHub secrets.** This is the rotation and automation pain Cimulate devops named. It moves that pain to the inline-agent widget team. Salesforce org policy blocks service-account key creation by default. A key exists only if PCS provisions an account that is allowed to have one.
2. **A Workload Identity pool in the inline-agent widget team's own GCP project**, bound to `SalesforceCommerceCloud/inline-agent-widget` and their publish workflow on tag refs. No JSON key. They still send Cimulate only the service account email.

Path C answers the rotation concern only in case 2. A JSON key on Path C recreates that problem on their side.

### Constraints on Path C

These constraints apply to the service account on this path. They do not remove Path C from the [comparison](#comparison).

#### Confirmed

These points are established for this plan. They are not quotations from a policy page pasted here.

- GCP service-account key creation is blocked by default org policy. Teams go through PCS for a provisioned account.
- `iam.managed.disableServiceAccountKeyCreation` is under review in the guardrails working group.
- Embark users have been blocked on sibling constraints.

#### Reasoning

The following is reasoning for this plan. It is not a documented Salesforce policy.

- The inline-agent widget repo has no GCP project yet. A production project needs its own request. A personal or sandbox project is the wrong owner for an identity that writes to a public CDN.
- Ownership splits: the identity sits with the inline-agent widget team, the bucket and CDN with Cimulate. Cimulate trusts a principal it does not manage. Rotation, audit, and revocation need an owner.
- Anything uploaded is served from `cdn.search.cimulate.ai` immediately.

#### Caveat

There is no Slack source that says product repos may not create service accounts. The points above about the project, the ownership split, and the public CDN are reasoning, not documented policy. If that must be stated as policy, confirm with PCS in `#gcp-dev-support` before sending.

### Order

1. Both sides agree on the [object contract](#object-contract).
2. The inline-agent widget team provisions the account through PCS and chooses a JSON key or their own Workload Identity pool.
3. They send Cimulate the service account email.
4. Cimulate applies the grant.
5. They push a `v*` tag.
6. Both sides `curl` the CDN URL.

### Path C — Cimulate

You add one bucket IAM binding in the cimulate monorepo. You do not create their account.

#### Prerequisite

They send one service account email. Reject the pair if they send a JSON key, a `github-arc` provider string, or Cimulate's CI service account email (`GCP_SERVICE_ACCOUNT` on `cimulate-ai/cimulate`). Do not store a key.

#### Bucket grant

Add a bucket IAM member on `google_storage_bucket.copilot_bundles_bucket`: role `roles/storage.objectCreator`, member `serviceAccount:<their email>`, condition title `inline-agent-widget-prefix`, expression `resource.name.startsWith("projects/_/buckets/copilot-bundles/objects/inline-agent-widget/")`. The trailing slash is required.

Add a new file next to the bucket, in the same configuration as `buckets.tf`:

`infrastructure/terraform/configurations/environments/common-cimulate-search-api/inline-agent-widget-external-cdn.tf`

Provider project is already `cimulate-search-api` (`main.tf`). State backend is already `gs://cimulate-tf-state-files`, prefix `common-cimulate-search-api/state`. Do not create a second state. Do not add Path B's pool file.

The variable is the email they sent. This file does not create a pool, a provider, a service account, or a `google_service_account_key`.

```hcl
variable "inline_agent_widget_publisher_email" {
  type        = string
  description = "Service account email the inline-agent widget team sent. Paste their email. Do not create the account."
}

resource "google_storage_bucket_iam_member" "inline_agent_widget_external_object_creator" {
  bucket = google_storage_bucket.copilot_bundles_bucket.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${var.inline_agent_widget_publisher_email}"

  condition {
    title       = "inline-agent-widget-prefix"
    description = "Trailing slash is required so inline-agent-widget-other does not match."
    expression  = "resource.name.startsWith(\"projects/_/buckets/copilot-bundles/objects/inline-agent-widget/\")"
  }
}
```

`roles/storage.objectCreator` is create-only: no list, no read, no delete, no replace. A second PUT of the same object name fails. `Cache-Control: public, max-age=3600` has to be on the create, with `x-goog-if-generation-match: 0`. Do not grant `roles/storage.objectAdmin`. Do not use the `github-arc` `externalBuckets` `copilot-bundles: write` grant. That grant is unconditional `objectAdmin` on the whole bucket.

From `infrastructure/terraform/configurations/environments/common-cimulate-search-api`, using whatever credential you already use to apply this configuration:

```bash
terraform plan -var='inline_agent_widget_publisher_email=THEIR_EMAIL'
terraform apply -var='inline_agent_widget_publisher_email=THEIR_EMAIL'
```

Stop if the plan changes `google_storage_bucket.copilot_bundles_bucket` (`force_destroy = true`), recreates the bucket, edits `github-arc`, adds `allUsers`, or adds a pool, a provider, a service account, or `google_service_account_key`. The plan should add one `google_storage_bucket_iam_member`.

#### IAM check

```bash
SA="THEIR_EMAIL"

gcloud projects get-iam-policy cimulate-search-api \
  --flatten="bindings[].members" \
  --filter="bindings.members:${SA}" \
  --format="value(bindings.role)"

gcloud projects get-iam-policy cimulate-build \
  --flatten="bindings[].members" \
  --filter="bindings.members:${SA}" \
  --format="value(bindings.role)"

gcloud storage buckets get-iam-policy gs://copilot-bundles --format=json
```

Both project policy commands print nothing. On `gs://copilot-bundles`, that member has one binding: `roles/storage.objectCreator`, condition expression `resource.name.startsWith("projects/_/buckets/copilot-bundles/objects/inline-agent-widget/")`.

Cimulate cannot impersonate a service account in their project, so the Path B `gcloud auth print-access-token --impersonate-service-account` negative test does not apply. Confirm the binding. After their first real tag, both sides `curl` the CDN URL in the [object contract](#object-contract).

### Path C — inline-agent-widget (SalesforceCommerceCloud)

Follow this section when the chosen path is Path C. You own the service account. Cimulate grants the email you send. You do not get Cimulate's provider or `GCP_SERVICE_ACCOUNT` from `cimulate-ai/cimulate`.

Request the account through PCS. Do not use a personal or sandbox project for this identity. A production project needs its own request. Send Cimulate only the service account email. Do not send a JSON key or a provider string.

**JSON key.** PCS must allow the key. Store the key PCS gives you as a GitHub secret and authenticate with it. Do not commit the key. Rotation is yours. This is the compliance pain Cimulate devops named, now on your side.

**Workload Identity pool.** Create the pool in your own GCP project. Bind it to repository `SalesforceCommerceCloud/inline-agent-widget`, to the workflow file you will actually commit, and to tag refs only. No JSON key. Cimulate still receives only the service account email. This plan does not include your Terraform or your PCS ticket.

The upload is the same PUT as [Path B's workflow](#2-add-this-workflow): one HTTP PUT with `x-goog-if-generation-match: 0`, `Cache-Control: public, max-age=3600`, and `Content-Type: text/javascript`. `roles/storage.objectCreator` cannot use `gcloud storage cp` or `gsutil cp`. Run on `ubuntu-latest`. The `cimulate-build` runner belongs to Cimulate. Trigger on tags `v*` so the version segment matches the [object contract](#object-contract).

If you use Workload Identity, the auth step reads your own provider resource name and your own service account email. Those values are not from `cimulate-ai/cimulate`.

```yaml
on:
  push:
    tags:
      - "v*"

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ vars.GCP_WORKLOAD_IDENTITY_PROVIDER }}
          service_account: ${{ vars.GCP_SERVICE_ACCOUNT }}
      # build, then the same PUT as Path B
```

The object name is the [object contract](#object-contract). Tag `v1.2.3` publishes `inline-agent-widget/1.2.3/inline-agent-widget.umd.js`. A second upload of that name returns HTTP `412`. You cannot delete a bad object. Ask Cimulate.

Confirm:

```bash
curl -sI "https://cdn.search.cimulate.ai/inline-agent-widget/1.2.3/inline-agent-widget.umd.js"
curl -sI "https://storage.googleapis.com/copilot-bundles/inline-agent-widget/1.2.3/inline-agent-widget.umd.js"
```

Expect `200` and `cache-control: public, max-age=3600`. If the origin URL is `200` and the CDN URL is `404`, retry the CDN URL.

## Leave these alone

These boundaries apply to all three paths.

- `.github/workflows/build-and-publish-js.yaml` — copilot-widget publish. Push to `master` under `javascript/**`, and only when the changed-folder matrix is exactly `["copilot-widget"]`. Environment `prod`, runner `cimulate-build`, `id-token: write`. Auth is `google-github-actions/auth@v2.1.2` with `vars.GCP_SERVICE_ACCOUNT` and `vars.GCP_WORKLOAD_IDENTITY_PROVIDER`.
- `.github/workflows/docker-build.yaml` — JSON key via `secrets.GCP_CREDENTIALS` (`credentials_json: ${{ secrets.GCP_CREDENTIALS }}`). Do not copy it.
- `infrastructure/pulumi/projects/github-arc/` including `Pulumi.prod.build.us-central1.yaml`.
- `infrastructure/pulumi/packages/pulumi-infra-gcp/src/iam/workload_identity_federation.ts`.
- `infrastructure/terraform/configurations/environments/common-cimulate-search-api/buckets.tf`. The bucket `google_storage_bucket.copilot_bundles_bucket` (`name = "copilot-bundles"`, `location = "US"`, `force_destroy = true`) stays as it is.
- `infrastructure/gcp/projects/cimulate-search-api/cloud-storage/copilot-bundles-cors.json`. A `<script src>` does not need a CORS change. That file already allows `GET` from any origin. Leave it unchanged for this work.

## Prohibited

- **No JSON keys created by Cimulate.** Do not create `google_service_account_key`. Do not copy `.github/workflows/docker-build.yaml`. On Path C, a key exists only if PCS provisions an account that is allowed to have one, and the inline-agent widget team stores it. Cimulate does not create that key and does not accept one.
- **Do not reuse the `github-arc` pool or provider.** That Workload Identity pool is in project `cimulate-build`, stack `github-arc` / `prod.build.us-central1`. Pool id `github-arc`, provider id `github-arc`, issuer `https://token.actions.githubusercontent.com`, condition `assertion.repository_owner == 'cimulate-ai'`. Path B creates a separate pool. Path A uses the existing CI identity only inside the hardcoded Cimulate workflow. Path C does not create a pool in a Cimulate project.
- **Do not reuse the cimulate-ai/cimulate CI service account for the inline-agent widget repo.** Its email is the Actions variable `GCP_SERVICE_ACCOUNT` on `cimulate-ai/cimulate`. That value is not a literal in git. Do not send it, or that repo's `GCP_WORKLOAD_IDENTITY_PROVIDER`, to Salesforce.
- **Do not grant `roles/storage.objectAdmin` or an unconditional bucket write for this publish.** Path B's account and Path C's external email get `roles/storage.objectCreator` on prefix `inline-agent-widget/` only, with the prefix condition. Path C's grant is that conditional objectCreator binding only. Do not grant `roles/storage.objectAdmin`, `roles/storage.objectUser`, `roles/storage.objectViewer`, `roles/storage.bucketViewer`, or project `roles/storage.admin`. Do not grant any project-level role.
- **Do not add `SalesforceCommerceCloud` to `github-arc` `externalBuckets`.** `infrastructure/pulumi/projects/github-arc/Pulumi.prod.build.us-central1.yaml` has `copilot-bundles: write`. That grants unconditional `roles/storage.objectAdmin` and `roles/storage.bucketViewer` on the whole bucket. Do not use that grant for Path C.
- **Do not widen `repository_owner` to `SalesforceCommerceCloud`.** The existing Pulumi component can emit only one equality, and it derives the IAM binding from that same attribute. Adding an OR would replace the `cimulate-ai` binding. Leave `infrastructure/pulumi/packages/pulumi-infra-gcp/src/iam/workload_identity_federation.ts` unchanged.
- **No new `allUsers` binding.** Anonymous GET and listing already work on this bucket. The public binding is not in git. Confirm a new object with `curl`.
