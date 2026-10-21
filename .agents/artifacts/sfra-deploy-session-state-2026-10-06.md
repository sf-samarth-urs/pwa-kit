# SFRA Deploy — Session State (saved 2026-10-06 ~01:15 EDT)

**W-24333475** — SFRA companion to the pwa-kit opener-pills work.
We stopped mid-deploy so Samarth could sleep. Pick up here in the morning.

---

## Where we are

Everything is staged. We are **one WebDAV COPY + one `npm run uploadCartridge` + one Activate click** away from testing on the SFRA storefront.

### Done tonight ✅
1. **UMD refreshed** in the SFRA cartridge.
   - Source: `/Users/surs/inline-agent-widget/dist/inline-agent-widget.umd.js`
   - Dest:   `/Users/surs/plugin_commerce_client/cartridges/plugin_commerce_client/cartridge/static/default/js/inlineAgent/inline-agent-widget.umd.js`
   - SHA256 (both): `40aa4e1bbf5c547f14e045e9119acbe14b93947fbcc011876969f4c998fa3764`
   - Size: 346,684 B
   - This UMD carries: opener pills, welcome-handoff state machine, recoverable-error silencing, typing-dot latency fix. Replaces the stale Oct‑2 `99b5dcf9...` / 343,902 B bundle.

2. **`dw.json`** at `/Users/surs/plugin_commerce_client/dw.json` is correct:
   ```json
   {
       "hostname": "zzsa-013.dx.commercecloud.salesforce.com",
       "username": "surs@salesforce.com",
       "password": "9tH-#!)nSlZyy}r6]vW,JUTTSkPUfK0v)2Ji#5au",
       "code-version": "samarth_w24333475"
   }
   ```
   Bare BM/WebDAV host (not SCAPI short-code host). sgmf-scripts reads this file directly.

3. **New code version created in BM** on `zzsa-013` → NTO PWA site → Site Development → Code Deployment.
   - Row visible: `samarth_w24333475` (431b1bdb7205b6dcc6d93abe5166dd47ee15ad2f), 22.7 \*, mod time 10/6/26 4:10:07 am, **Inactive — currently empty**.
   - Active row remains: `v25_10_5` (29183cfcefb4e541767f3d4a392586eb0bc0df6e), 22.7, activated 12/8/25 2:37:36 pm.
   - Third row (unused): `version1`.

### Not done yet — pick up here in the morning ⏭️

#### Step A — WebDAV COPY `v25_10_5` → `samarth_w24333475`
This is why it matters: our new version is empty. If we upload only our `plugin_commerce_client` and activate it, every other cartridge (`app_storefront_base`, `storefront-reference-architecture`, SFRA core, …) disappears from the running site. The COPY clones the full cartridge tree so our upload only overlays our one cartridge on top of a fully-populated version.

Run from the Mac (same creds as `dw.json`):

```bash
curl -X COPY \
  -u 'surs@salesforce.com:9tH-#!)nSlZyy}r6]vW,JUTTSkPUfK0v)2Ji#5au' \
  -H 'Destination: https://zzsa-013.dx.commercecloud.salesforce.com/on/demandware.servlet/webdav/Sites/Cartridges/samarth_w24333475' \
  -H 'Overwrite: T' \
  'https://zzsa-013.dx.commercecloud.salesforce.com/on/demandware.servlet/webdav/Sites/Cartridges/v25_10_5'
```

Expected: `201 Created` or `204 No Content`. If 207 Multi-Status, read the body for per-resource errors (usually none for cartridge trees).

Verify in BM:
- Code Deployment page → `samarth_w24333475` row's Modification Time should jump to "just now".
- Optional: WebDAV browse `https://zzsa-013.dx.commercecloud.salesforce.com/on/demandware.servlet/webdav/Sites/Cartridges/samarth_w24333475/` → full tree, incl. `app_storefront_base`, `storefront-reference-architecture`, `plugin_commerce_client`, etc.

#### Step B — Upload our cartridge overlay
```bash
cd /Users/surs/plugin_commerce_client
npm run uploadCartridge
```
`uploadCartridge` → `sgmf-scripts --uploadCartridge plugin_commerce_client` — reads `dw.json`, pushes **only** `cartridges/plugin_commerce_client` to the `code-version` in `dw.json` (= `samarth_w24333475`). Overlays — doesn't wipe other cartridges from the copy.

#### Step C — Activate `samarth_w24333475`
BM → NTO PWA → Site Development → Code Deployment → **Activate** on the `samarth_w24333475` row.
Wait for Activation Time column to fill in.

#### Step D — Test
Open:
```
https://www.shop.prd.tbdp.sfcc-store-internal.net/on/demandware.store/Sites-NTOManaged-Site/en_US/Product-Show?pid=500400
```
(Also fine: `https://www.shop.prd.tbdp.sfcc-store-internal.net/en_US/500400.html`.)

Expected on this product (TrailFit Alta, confirmed in `~/Downloads/nto_pdpQuestions_published.tsv` as published):
- Widget renders inline on PDP.
- InputBar placeholder = `"Ask me anything about TrailFit Alta"`.
- Pills (up to 5) render below the answer card.
- Clicking a pill → right-aligned dark bubble → agent response.
- No welcome bubble leak on idle. No red "Something went wrong" flash on anonymous handshake.

Smoke-check a product WITHOUT `pdpQuestions` too — widget should render, pills absent, placeholder generic.

#### Step E — Flip back when done
BM → Code Deployment → Activate `v25_10_5` to restore the shared active version.
Leave `samarth_w24333475` sitting there so we can reactivate it for demos.

---

## Hosts cheat sheet (so morning-you doesn't have to re-derive)

| Host                                                     | Role                                             |
|----------------------------------------------------------|--------------------------------------------------|
| `zzsa-013.dx.commercecloud.salesforce.com`               | BM UI + **WebDAV** cartridge upload (this host)  |
| `sandbox-001.api.commercecloud.salesforce.com`           | SCAPI (shopper APIs, c_pdpQuestions reads)       |
| `www.shop.prd.tbdp.sfcc-store-internal.net`              | **Storefront** we test on (SFRA, NTOManaged)     |
| `production-realm25-qa223.demandware.net`                | Alternate PDP URL on the same realm              |

Storefront ≠ WebDAV host even though it serves the same realm — that's just how NTO's CDN front-end is set up.

---

## Branch state

- `/Users/surs/plugin_commerce_client` on branch `feature/w-24333475-inline-pdp-pills`
- 20 files / ~1100 LOC in flight, uncommitted and that's fine for the sandbox deploy — WebDAV upload is file-level, not git-aware.
- Key files already in place:
  - `cartridge/templates/default/cimulate/inlineAgentWidget.isml` (160 lines)
  - `cartridge/controllers/CommerceClient.js`
  - `cartridge/scripts/cimulate/configHelper.js`
  - `cartridge/static/default/js/inlineAgent/inline-agent-widget.umd.js` ← refreshed tonight
  - `meta/system-objecttype-extensions.xml` (×2 — `pdpQuestions` custom attribute)
  - `test/inlineAgentWidget.test.js`, `test/pdpContextIntegration.test.js`

---

## Parked work (not blocking the SFRA deploy)

### pwa-kit PR #4040 — waiting on upstream write access
- Current PR is from fork `sf-samarth-urs:feature/inline-pdp-opener-pills`.
- E2E CI gets `Secret source: None` with empty AWS env vars → fork-PR secret gate (standard GH Actions security). Can't be fixed from the fork.
- Asked **Evan Chessman** in Slack for write access to `SalesforceCommerceCloud/pwa-kit` (Shilpi already has it on PR #4041 — fair ask).
- Once granted: squash fork branch → push upstream → open new PR → close PR #4040. Merge in the morning (your words).

### Kevin's review on `parsePdpQuestions` — ✅ addressed
Added `console.warn` on both failure paths (bad JSON, non-array parsed value), expected-shape JSDoc with the `'["Q1?","Q2?"]'` example, Commerce Content Studio paragraph documenting the source. Tests at `app/utils/inline-agent-widget-utils.test.js` cover both warn branches + a silent-no-op case. 7 passing, 100% file coverage.

---

## One-liner to resume in the morning

> "COPY v25_10_5 → samarth_w24333475, then upload, activate, test 500400."

That's it. State saved. Sleep well. 🌙
