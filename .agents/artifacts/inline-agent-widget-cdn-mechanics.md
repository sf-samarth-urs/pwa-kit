# Inline Agent Widget — CDN Mechanics & SFRA Site-Pref Flow

**Date:** 2026-10-08
**Author:** Samarth Urs
**Status:** Reference doc. Companion to `inline-agent-widget-cdn-hosting-research.md`.
**Related WIs:** W-24457426 (CDN pipeline), W-24457436 (SFRA + PWA Kit host wiring), W-24457447 (SF Next host wiring).

---

## TL;DR

- **The CDN publish is a bucket upload, not a hosted service.** `gsutil cp dist/*.umd.js gs://copilot-bundles/<pkg>/<version>/`. The CDN hostname is just the public HTTPS face of that GCS bucket.
- **GCP enters only for auth + bucket writes.** Workload Identity Federation binds the GHA to a service account; the service account has `storage.objectAdmin` on the bucket prefix. **No GCP project, no runtime hosting, no Cloud Run / KMS / Armor** — none of the stuff from Chintan's W-24457923 Shopper Agent API spike applies here.
- **SFRA cartridge upload ≠ site-pref creation.** They are two independent BM imports: `uploadCartridge` pushes runtime code to WebDAV, `Site Import & Export` loads the metadata XML that defines the pref *attributes*. The merchant then fills in the attribute *values* separately.
- **Attribute values live in a consolidated JSON blob.** Since `W-23848738` the cartridge consolidated per-field preferences (`cc_cdnVersion`, `cc_loadingMode`, etc.) into `cc_config` / `cc_embeddedAgent_config` JSON blobs. For Phase 2 host wiring, we fold the new inline-widget keys into `cc_embeddedAgent_config` and avoid a site-import re-run on upgrade.

---

## 1. The CDN mechanical flow (Cimulate's reference)

### Source

- Workflow: `cimulate/.github/workflows/build-and-publish-js.yaml`
- First landed: [cimulate PR #4537](https://github.com/cimulate-ai/cimulate/pull/4537) (2025-09-03), author @jr-cimulate
- Linked Jiras: CIM-1473 (publish automation), CIM-1474 (CDN infrastructure)

### Trigger

```yaml
on:
  push:
    branches: [master]
    paths: [javascript/**]
```

Fires on **every merge to `master`** when anything under `javascript/` changes. No tag required — version comes straight from `package.json`.

### Permissions

```yaml
permissions:
  checks: write
  contents: read
  id-token: write     # ← lets GitHub mint an OIDC token for GCP WIF
```

**`id-token: write` is non-negotiable** — without it, Workload Identity Federation can't verify the workflow run.

### The two GCP steps

```yaml
- uses: google-github-actions/auth@v2.1.2
  with:
    service_account: ${{ vars.GCP_SERVICE_ACCOUNT }}
    workload_identity_provider: ${{ vars.GCP_WORKLOAD_IDENTITY_PROVIDER }}

- uses: google-github-actions/setup-gcloud@v1
  with:
    project_id: ${{ vars.GCP_PROJECT_ID }}
```

**What's happening under the hood:**

1. **`google-github-actions/auth`** does an OIDC token exchange:
   - GitHub generates a signed JWT describing this run (repo, ref, workflow, actor, etc.) — enabled by `id-token: write`.
   - The action POSTs that JWT to GCP's Security Token Service.
   - GCP's **Workload Identity Pool** validates the JWT against its configured attribute conditions (e.g. "repo must be `SalesforceCommerceCloud/inline-agent-widget`, ref must be `refs/tags/v*`").
   - If the conditions match, GCP issues a short-lived GCP access token bound to `GCP_SERVICE_ACCOUNT`.
   - **No long-lived keys ever stored in GitHub.** This is the whole point of WIF over service-account JSON keys.

2. **`setup-gcloud`** installs `gcloud` and `gsutil` CLIs into the runner and configures them to use the token minted in step 1, with `project_id` set as the default. From this point, any `gsutil` or `gcloud` call runs as the service account.

### The build + publish steps

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: "22.16"
    registry-url: https://registry.npmjs.org

- run: npm install
- run: npm run test

- name: Build and Publish
  run: |
    npm run build
    npm publish --access public
    pkg_version=$(npm pkg get version | tr -d '"')
    gsutil cp ./dist/*.css   gs://${{ vars.COPILOT_BUNDLES_BUCKET }}/${{ matrix.directory }}/${pkg_version}/
    gsutil cp ./dist/*.umd.js gs://${{ vars.COPILOT_BUNDLES_BUCKET }}/${{ matrix.directory }}/${pkg_version}/
    echo "version=${pkg_version}" >> $GITHUB_OUTPUT
```

Three deliverables per release:
1. **npm:** `npm publish --access public` → `npmjs.org/@cimulate/copilot-widget@<version>`
2. **GCS bucket:** `gsutil cp` → `gs://copilot-bundles/copilot-widget/<version>/*.umd.js` + `*.css`
3. **Slack announcement:** downstream step posts to the `copilot-releases` channel with CDN + npm links

### Where is the CDN?

**The CDN (`cdn.search.cimulate.ai`) is not a separate pipeline step.** It is a public HTTPS front-end sitting in front of the GCS bucket. Once a file lands in `gs://copilot-bundles/copilot-widget/1.47.1/messaging.umd.js`, it is immediately readable at `https://cdn.search.cimulate.ai/copilot-widget/1.47.1/messaging.umd.js`.

The mapping is:
```
gs://copilot-bundles/<pkg>/<version>/<file>
                      ↕  (public bucket + CDN mapping)
https://cdn.search.cimulate.ai/<pkg>/<version>/<file>
```

### Mental model

```
┌─────────────────────────────────────────────────────────────┐
│  push to master (paths: javascript/**)                      │
└───────────────────┬─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────┐
│  google-github-actions/auth (OIDC → WIF → access token)     │
│       GitHub repo identity  →  GCP service account          │
└───────────────────┬─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────┐
│  npm ci → npm test → npm run build (vite UMD + ESM)         │
└───────────────────┬─────────────────────────────────────────┘
                    │
         ┌──────────┴──────────┐
         ▼                     ▼
┌──────────────────┐   ┌─────────────────────────────────────┐
│  npm publish     │   │  gsutil cp dist/*.umd.js            │
│  → npmjs.org     │   │  gs://copilot-bundles/<pkg>/<v>/    │
└──────────────────┘   └────────────┬────────────────────────┘
                                    │
                                    ▼
                       ┌─────────────────────────────────────┐
                       │  cdn.search.cimulate.ai/<pkg>/<v>/* │
                       │  (public read; bucket-fronted CDN)  │
                       └─────────────────────────────────────┘
```

---

## 2. What our GHA will look like (inline-agent-widget)

Direct copy-adapt of the Cimulate YAML, with three deliberate deviations.

```yaml
# .github/workflows/release.yml in SalesforceCommerceCloud/inline-agent-widget
name: Release inline-agent-widget

on:
  push:
    tags: ['v*']                    # ← trigger on tag, not master push

permissions:
  id-token: write
  contents: read

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: google-github-actions/auth@v2
        with:
          service_account: ${{ vars.GCP_SERVICE_ACCOUNT }}
          workload_identity_provider: ${{ vars.GCP_WIF_PROVIDER }}

      - uses: google-github-actions/setup-gcloud@v2

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org

      - run: npm ci && npm test && npm run build

      - run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Upload to GCS (immutable + latest)
        run: |
          v=$(npm pkg get version | tr -d '"')
          gsutil -h "Cache-Control:public,max-age=31536000,immutable" \
            cp ./dist/*.umd.js gs://copilot-bundles/inline-agent-widget/${v}/
          gsutil -h "Cache-Control:public,max-age=300" \
            cp ./dist/*.umd.js gs://copilot-bundles/inline-agent-widget/latest/
```

### Deliberate deviations from Cimulate's YAML

| Change | Why |
|---|---|
| **Trigger on tag push, not master push** | Lets us gate a release behind an explicit `git tag v1.0.0 && git push --tags`. Cimulate's "merge-to-release" model is noisier and ships every refactor. |
| **Explicit `Cache-Control` headers per path** | `<version>/*` is immutable → `max-age=31536000, immutable` (1 year). `latest/*` is mutable → `max-age=300` (5 min). Prevents CDN edge nodes from pinning stale `/latest/` for days. Cimulate's YAML doesn't set these, which is fine for pinned-version consumers but shaky for anyone using `/latest/`. |
| **No matrix build** | We have one package in the repo. Dropping `matrix.directory` scaffolding simplifies the YAML. |

### GCP infra we need from Cimulate SRE (Helen's team)

Just these three variables set at the repo level in `SalesforceCommerceCloud/inline-agent-widget`:

| GitHub Variable | What it points at | Who sets it |
|---|---|---|
| `GCP_SERVICE_ACCOUNT` | A GCP service account email like `inline-agent-widget-publisher@<project>.iam.gserviceaccount.com`, with role `storage.objectAdmin` scoped to `gs://copilot-bundles/inline-agent-widget/*` | Cimulate SRE |
| `GCP_WIF_PROVIDER` | The Workload Identity Pool provider resource name, e.g. `projects/<num>/locations/global/workloadIdentityPools/github/providers/salesforce-commerce-cloud` | Cimulate SRE |
| `GCP_PROJECT_ID` | The GCP project that owns the WIF pool + the bucket | Cimulate SRE |

Plus one repo **secret**:
| Secret | What |
|---|---|
| `NPM_TOKEN` | npm automation token for the `@cimulate/*` (or whatever name we pick) scope. Needs publish rights. |

### What Cimulate SRE needs to configure on their side (one-time)

Helen's team will:
1. Create the service account (SA) `inline-agent-widget-publisher@...`.
2. Grant that SA `roles/storage.objectAdmin` on `gs://copilot-bundles/inline-agent-widget/*` (either a prefix condition on the existing bucket or a dedicated bucket — Helen said whichever is easier for them).
3. In their existing Workload Identity Pool for GitHub, add a provider mapping that says:
   - "A JWT from `token.actions.githubusercontent.com` is allowed to impersonate this SA **only if** `attribute.repository == 'SalesforceCommerceCloud/inline-agent-widget'` and `attribute.ref` matches `refs/tags/v*`."
4. Hand us the three variable values above.

**That is the entire GCP footprint for our use case.** No project to create, no runtime to stand up, no KMS, no NAT, no Armor. The confusion with Chintan's W-24457923 is that both touch "GCP" — but his spike is about *running a Python service* on GCP, which is a 10x bigger surface.

---

## 3. SFRA site-pref flow — the two-import truth

### What the cartridge ships

Two independent chunks of content live inside `plugin_commerce_client/`:

| Chunk | Path | Deployed via | Purpose |
|---|---|---|---|
| **Runtime code** | `cartridges/plugin_commerce_client/` | `npm run uploadCartridge` → WebDAV `Cartridges` folder | What the storefront executes at request time (ISML, controllers, scripts) |
| **Metadata** | `site_import_commerce_client/meta/system-objecttype-extensions.xml` | BM → Administration → Site Development → Site Import & Export (zip-and-import) | Declares the site-pref **attributes** themselves (name, type, group, description) |

**Uploading the cartridge does NOT create the site-pref fields in BM.** They are two different imports, and merchants/integrators need to do both.

### What `system-objecttype-extensions.xml` looks like (current `plugin_commerce_client`)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<metadata xmlns="http://www.demandware.com/xml/impex/metadata/2006-10-31">
    <type-extension type-id="SitePreferences">
        <custom-attribute-definitions>
            <attribute-definition attribute-id="cc_config">
                <display-name xml:lang="x-default">Commerce Client Configuration (JSON)</display-name>
                <description xml:lang="x-default">Sole source for Commerce Client settings. Enter a valid JSON object using supported cc_* keys; omitted or invalid fields use their documented defaults.</description>
                <type>text</type>
            </attribute-definition>
            <attribute-definition attribute-id="cc_embeddedAgent_config">
                <display-name xml:lang="x-default">Embedded Agent Configuration (JSON)</display-name>
                <description xml:lang="x-default">Configuration for the embedded agent. Enter a valid JSON object with supported cc_embeddedAgent_* keys ...</description>
                <type>text</type>
            </attribute-definition>
        </custom-attribute-definitions>

        <group-definitions>
            <attribute-group group-id="CommerceClient">
                <display-name xml:lang="x-default">Commerce Client</display-name>
                <attribute attribute-id="cc_config"/>
            </attribute-group>
            <attribute-group group-id="EmbeddedAgentCommerceClient">
                <display-name xml:lang="x-default">Embedded Agent Commerce Client</display-name>
                <attribute attribute-id="cc_embeddedAgent_config"/>
            </attribute-group>
        </group-definitions>
    </type-extension>
</metadata>
```

Two attributes, two groups. **That's all.**

### The merchant-side 4 steps (what Jhalak said), decomposed

| Jhalak's step | What's actually happening |
|---|---|
| 1. Upload cartridge | `sfcc-ci code:deploy` or `npm run uploadCartridge` — pushes `cartridges/` to the WebDAV `Cartridges` folder on the sandbox |
| 2. Import site preferences | BM → Site Import & Export, upload a zip of `site_import_commerce_client/` — **this is where the `cc_config` / `cc_embeddedAgent_config` attributes get created on `SitePreferences`** |
| 3. Fill in config in BM | Merchant navigates to Merchant Tools → Site Preferences → Custom Site Preferences → Commerce Client (or Embedded Agent) → paste JSON blob into the field |
| 4. Add cartridge to the cartridge path | BM → Administration → Sites → Manage Sites → *your site* → Settings → Cartridges → add `plugin_commerce_client:app_storefront_base` |

### Why you remember doing it manually on `zyss-001`

What you did was **step 3** (paste the JSON blob into an existing field). The attribute **slot** was already there — probably from a prior site-import done when the realm template was created, or from a previous version of the cartridge that someone imported.

If you had provisioned a bare realm and uploaded only the cartridge, the `cc_embeddedAgent_config` field wouldn't exist in BM yet. The Site Import is a hard prerequisite.

### History of the schema (recent commits)

```
e23eb61  feat: consolidate commerce client settings @W-23848738    ← switch to JSON blob
57f9087  Add separate Inline Agent Widget preference group with individual cc_ia_* preferences
498ffd3  Rename preference prefix to cc_inlineWidget_ ...
2d726b7  Remove PDP from group name and remove capabilitiesVersion preference
836b444  Move inline widget config to cc_inlineWidget_config JSON blob
265f200  rename inline widget config to embedded agent config
```

Translation: the team **tried** per-field preferences (`cc_ia_*`), then flipped to a single JSON blob under `W-23848738`. The BM screenshot I saw earlier (showing standalone `cc_cdnVersion` + `cc_loadingMode` fields) was from a sandbox running the pre-consolidation schema. The current `main` branch has only two blobs.

**For W-24457436 (Phase 2 SFRA host wiring), we fold the new keys into `cc_embeddedAgent_config`:**

```json
{
  "cc_embeddedAgent_enabled": true,
  "cc_embeddedAgent_scrt2Url": "...",
  "cc_embeddedAgent_orgId": "...",
  "cc_embeddedAgent_esDeveloperName": "...",
  "cc_embeddedAgent_placeholder": "...",
  "cc_embeddedAgent_persistSession": true,
  "cc_embeddedAgent_enableLogging": false,
  "cc_embeddedAgent_cdnVersion": "1.0.0",       ← NEW
  "cc_embeddedAgent_loadingMode": "cdn"         ← NEW (or "static")
}
```

### The upgrade win

**No XML change = no site-import re-run on upgrade.** When a merchant upgrades to the cartridge version that supports CDN loading, they only re-upload the cartridge code; they do NOT need to re-import `site_import_commerce_client/`. They just add two keys to their existing `cc_embeddedAgent_config` JSON blob in BM.

If we had added `cc_embeddedAgent_cdnVersion` as a *standalone* attribute instead, every merchant would need to re-import the site metadata on upgrade. The consolidated JSON design pays off here.

---

## 4. Comparison — what GCP means in each nearby WI

| Workstream | GCP footprint | Who provisions | Scope |
|---|---|---|---|
| **W-24457426 — inline-agent-widget CDN publish (ours)** | 1 WIF binding, 1 service account with `storage.objectAdmin` on a bucket prefix, 3 GH variables, 1 GH secret | Cimulate SRE (one-time setup on their existing project) | File upload only. No compute, no network, no keys. |
| **W-24457923 — Shopper Agent API GCP hosting (Chintan's)** | Full GCP project (stage + prod), Cloud Run or GKE, Cloud NAT (fixed egress IPs for SFAP allowlist), Cloud KMS (C2C signing keys with HSM), Cloud Armor (rate limits), external Application Load Balancer, GDoT `sfdc.*` integration registration, LLM Gateway feature registration, SOTER review | Separate SRE engagement, likely weeks of lead time | Running a stateful Python service that serves 100k+ concurrent SSE streams |

**The common ground is literally two words: "GCP identity."** Both items need an answer to "does `SalesforceCommerceCloud` have / use a GCP project?" Helen's answer unblocks both — but the follow-on work is completely different.

**For our WI, the follow-on is "write a 50-line GHA YAML."**
**For Chintan's, the follow-on is "design a production service."**

Do not conflate.

---

## 5. Cross-references

- Research doc: `pwa-kit/.agents/artifacts/inline-agent-widget-cdn-hosting-research.md`
- Anchor Slack thread: `#custom-client-shopper-agent` 2026-10-07 ([link](https://salesforce-internal.slack.com/archives/C0B8BH78SAE/p1791413254788209))
- Jhalak's `plugin_commerce_client` announcement: 2026-06-19 ([link](https://salesforce-internal.slack.com/archives/C0B8BH78SAE/p1781884657824399))
- Cimulate reference GHA: `cimulate-ai/cimulate` → `.github/workflows/build-and-publish-js.yaml` ([PR #4537](https://github.com/cimulate-ai/cimulate/pull/4537))
- Cimulate Jiras: CIM-1473 (publish automation), CIM-1474 (CDN infrastructure)
- GUS WIs under Epic `a3QEE000002jfYv2AI`:
  - W-24457426 — CDN publishing pipeline
  - W-24457436 — SFRA + PWA Kit consumer wiring
  - W-24457447 — SF Next consumer wiring
- Chintan's parallel spike: W-24457923 — Shopper Agent API GCP hosting (different workstream, shares the GCP-identity question only)
