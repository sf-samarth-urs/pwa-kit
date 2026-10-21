# SFRA Inline PDP Ask Assistant — End-to-End ODS Deploy

**Date:** 2026-10-06
**Work item:** W-24333475 — [Inline PDP] [M5] Display generated inline PDP questions in the inline widget — SFRA
**Branch:** `feature/w-24333475-inline-pdp-pills` on `plugin_commerce_client`
**ODS:** `zyss-001.unified.demandware.net` (team realm `zyss`, personal sandbox, 7-day TTL)
**Agent tenant:** Q3 pc-rnd (`q3sdb60111062025mp1`), `BYONCommerceClientAPI`

Companion to the already-merged pwa-kit PR #4049 for W-24333476. This doc captures the SFRA half end-to-end so the next person doesn't have to re-derive it.

---

## TL;DR

Smoke test on `zyss-001` RefArch demo storefront passed. Inline widget renders on the PDP below Add to Cart, pulls opener-pill questions from a merchant-managed `product.custom.pdpQuestions` attribute, and templates the product name into the InputBar placeholder. Verified on two products: Modern Sport Coat (with pills) and Basic Leg Trousers (no pills — negative case). No red error flashes, no welcome-leaks, no console errors.

---

## Phase 1 — Spawn the ODS

Not using `zzsa-013` (shared sandbox; Alex Nuccio advised against it). Used Rishi Ranka's team realm `zyss` instead.

Jenkins job: **https://digital2.productivity.cc.sfdcsb.net/job/cc-productivity/job/cloud-native-deployment/job/ccdx-custom-spawn/**

Params:
| Param | Value |
|---|---|
| `target_ecom_version` | `latest` |
| `target_jwa_version` | `latest` |
| `target_ecom_realm` | `zyss` |
| `target_ttl` | `7` (days) |
| `resource_profile` | `medium` |
| `deploy_sfra_demo_site` | **`true`** |
| `deploy_sfnext_demo_site` | **`true`** (for W-24333477 next) |
| `QE_PIPELINE_BRANCH` | `master` (default) |

Jenkins green → BM at `https://zyss-001.unified.demandware.net/`. On ODS the BM host IS the WebDAV host (unlike `zzsa-*` which splits them). First-user-on-realm meant the sandbox id ended in `-001`.

---

## Phase 2 — Site Preferences for the widget

Widget is gated server-side on `config.enabled && isConfigured` (reads `cc_embeddedAgent_config` JSON blob). On a fresh ODS this preference doesn't exist — the gate fails, widget never emits HTML.

### 2a. Define the Site Preference attribute

BM → **Administration → Site Development → System Object Types** → click **SitePreferences** → **Attribute Definitions** → **New**:
- **ID:** `cc_embeddedAgent_config`
- **Display Name:** `Embedded Agent Commerce Client (JSON)`
- **Value Type:** `Text` (unbounded string)
- Everything else default

Then **Attribute Grouping** tab → **New Group** `commerceClient` → add `cc_embeddedAgent_config` to it.

### 2b. Set the value

BM → **Merchant Tools → Site Preferences → Custom Preferences → Commerce Client** → paste into `cc_embeddedAgent_config`:

```json
{
    "cc_embeddedAgent_enabled": true,
    "cc_embeddedAgent_scrt2Url": "https://q3sdb60111062025mp1.test1.my.pc-rnd.salesforce-scrt.com",
    "cc_embeddedAgent_orgId": "00Dfi800001CByP",
    "cc_embeddedAgent_esDeveloperName": "BYONCommerceClientAPI",
    "cc_embeddedAgent_persistSession": true,
    "cc_embeddedAgent_enableLogging": true
}
```

**Gotcha:** `enabled` must be a real boolean `true`, not quoted `"true"`. configHelper's `isBoolean()` validator rejects strings, and the widget silently stays disabled. Same for `persistSession` and `enableLogging`.

**Gotcha:** Do NOT set `cc_embeddedAgent_placeholder`. The widget treats it as a verbatim override — if you set `"Ask me anything about {product}"` thinking it's a template, you get literal `{product}` text. Omit the field and let the widget use its built-in `"Ask me anything about <productName>"` template, which it fills from the separate `product-name` HTML attribute.

---

## Phase 3 — Product custom attribute for pills

### 3a. Define `pdpQuestions` on Product

BM → **Administration → Site Development → System Object Types → Product → Attribute Definitions → New**:
- **ID:** `pdpQuestions`
- **Display Name:** `PDP Questions`
- **Help Text:** `Pre-generated shopper questions (JSON) surfaced as pills on the PDP.`
- **Value Type:** `Text`
- **Localizable:** Yes (acceptable; could be No)
- **Visible:** Yes
- Everything else default

### 3b. Add to an Attribute Group

Same page → **Attribute Grouping** tab → **New Group** `aiAssistant` → **AI Assistant** → add `pdpQuestions`.

Group assignment is required for the field to appear in the product edit UI. Attribute definition without grouping = invisible in merchant tools (but SFCC still returns it on `product.custom.pdpQuestions` reads).

### 3c. Set values on sample products

BM → Products → open product → Lock → scroll to **AI Assistant** group → paste a JSON string:

**Modern Sport Coat (`34736758M`):**
```json
["How does this fit — true to size?","What's the fabric blend?","Can I machine wash this?","Does it come in other colors?","What occasions is it best for?"]
```

**Basic Leg Trousers (`73910532-6M`):** leave empty — negative test case.

Apply, Unlock.

---

## Phase 4 — Cartridge upload

### 4a. Update `dw.json`

```json
{
    "hostname": "zyss-001.unified.demandware.net",
    "username": "surs@salesforce.com",
    "password": "<webdav-access-key-from-BM>",
    "code-version": "version1"
}
```

Fresh ODS ships with `version1` as the active code version containing all SFRA baseline cartridges (`app_storefront_base`, `plugin_cartridge_merge`, etc.). Since this is a personal sandbox with nothing to overwrite, we overlay directly into `version1` — **no WebDAV COPY, no new code version, no activation step**.

### 4b. Upload

```bash
cd /Users/surs/plugin_commerce_client
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
npm run uploadCartridge
```

Which runs `sgmf-scripts --uploadCartridge plugin_commerce_client` — pushes just the one cartridge to the WebDAV path for the `code-version` in `dw.json`.

### 4c. Add cartridge to the site path

BM → **Administration → Sites → Manage Sites → RefArch → Settings tab → Cartridges**.

Before:
```
plugin_cartridge_merge:plugin_instorepickup:plugin_wishlists:plugin_giftregistry:lib_productlist:plugin_productcompare:plugin_sitemap:plugin_applepay:plugin_datadownload:app_storefront_base
```

After (prepend):
```
plugin_commerce_client:plugin_cartridge_merge:plugin_instorepickup:plugin_wishlists:plugin_giftregistry:lib_productlist:plugin_productcompare:plugin_sitemap:plugin_applepay:plugin_datadownload:app_storefront_base
```

Order matters — SFCC resolves template/controller/script references left-to-right, first match wins. **Verify via "Effective Cartridge Path"** on the same page (it shows the fully resolved chain including inherited paths like `plugin_apple_pay:plugin_facebook:bc_content:core`). No activation needed; cartridge-path edits are instance-level and take effect immediately.

**UI note:** no success toast appears after Apply. Trust the Effective Cartridge Path readback.

---

## Phase 5 — The code path (how it actually works)

### SFRA server-side (this cartridge)

**File:** `cartridges/plugin_commerce_client/cartridge/templates/default/common/layout/page.isml` (overrides base)

Injects the widget partial conditionally on PDP:
```isml
<isif condition="${pdict.action === 'Product-Show'}">
    <isinclude template="cimulate/inlineAgentWidget"/>
</isif>
```

**File:** `cartridges/plugin_commerce_client/cartridge/templates/default/cimulate/inlineAgentWidget.isml`

Reads data on the SFCC JVM — **no SCAPI call needed from the server**:
```isml
<isscript>
    var ProductMgr = require('dw/catalog/ProductMgr');
    ...
    var pdpQuestions = '';
    var pdpProductName = '';
    try {
        var pdpProductId = pdict.product && pdict.product.id ? String(pdict.product.id) : '';
        if (pdpProductId) {
            var pdpProductRaw = ProductMgr.getProduct(pdpProductId);
            if (pdpProductRaw) {
                if (pdpProductRaw.custom && pdpProductRaw.custom.pdpQuestions) {
                    pdpQuestions = String(pdpProductRaw.custom.pdpQuestions);
                }
                if (pdpProductRaw.name) {
                    pdpProductName = String(pdpProductRaw.name);
                }
            }
        }
        if (!pdpProductName && pdict.product && pdict.product.productName) {
            pdpProductName = String(pdict.product.productName);
        }
    } catch (e) { ... }
</isscript>
```

Then emits a `<script>` block that creates `<inline-agent-widget>` and sets:
- `scrt2-url`, `org-id`, `es-developer-name`, `capabilities-version` — from `cc_embeddedAgent_config`
- `pdp-questions` — raw JSON string from `product.custom.pdpQuestions` (parsed client-side by the UMD)
- `product-name` — raw product name string (widget templates it into the InputBar placeholder client-side as `"Ask me anything about <productName>"`)

### Client-side (the UMD)

- Reads `pdp-questions` HTML attribute → `JSON.parse` → renders up to 5 pills below the input bar
- Reads `product-name` HTML attribute → substitutes into default placeholder template
- On pill click → right-aligned dark bubble → SCRT2 request to the configured tenant → agent response renders in a card below

### Why no SCAPI on SFRA

SFRA PDPs render server-side; `dw.catalog.ProductMgr` is a direct JVM read against the catalog on the same instance that owns it. No HTTP, no SLAS, no OAuth. SCAPI only matters for the SF Next / PWA Kit side (W-24333477), where the browser calls `/products/{id}` and reads `product.c_pdpQuestions` from the response. **Different code paths, same product data.**

---

## Phase 6 — Smoke test results

**URL:** `https://zyss-001.unified.demandware.net/s/RefArch/mens-modern-sportcoat/34736758M.html?lang=en_US`

| Check | Expected | Actual |
|---|---|---|
| Widget mounts inline below Add to Cart | ✅ | ✅ |
| "Ask Assistant" header + New badge | ✅ | ✅ |
| InputBar placeholder = "Ask me anything about Modern Sport Coat" | ✅ | ✅ |
| 5 pills from `custom.pdpQuestions` | ✅ | ✅ |
| Pill click → right-aligned dark user bubble | ✅ | ✅ |
| SCRT2 request fires to `q3sdb60111062025mp1...` | ✅ | ✅ (confirmed in Network tab) |
| Response bubble renders | ✅ | ✅ (quality N/A — Q3 tenant has no RefArch grounding, agent correctly says "I don't have this info") |
| Dynamic follow-up pills replace static pills after first response | ✅ | ✅ |
| No welcome-leak on idle | ✅ | ✅ |
| No red error flash | ✅ | ✅ |
| **Negative case:** PDP without `pdpQuestions` → widget renders, no pills | ✅ | ✅ (Basic Leg Trousers `73910532-6M`) |

---

## Lessons / Gotchas (for the standup / for future me)

1. **ODS BM == WebDAV host.** On personal ODS (`zyss-001.unified.demandware.net`) both roles live at the same hostname. On shared sandboxes (`zzsa-013.dx.commercecloud.salesforce.com`) they split. The `dw.json` password field is the WebDAV *access key* from Account Manager, not the SSO password.

2. **No WebDAV COPY needed on fresh ODS.** `version1` is already populated with the full SFRA cartridge tree (`app_storefront_base` + plugins). We overlay our one cartridge in place — nothing to clone, nothing to activate.

3. **Site Preference custom attribute must be defined AND grouped.** Just defining the attribute isn't enough — the merchant tools UI only renders grouped attributes. Same rule applies to Product custom attributes.

4. **`cc_embeddedAgent_config` type-strictness.** The configHelper validates every field; wrong types silently fall back to defaults. Booleans must be real booleans. Non-empty strings only (empty string is treated as missing).

5. **Placeholder is NOT a template string.** `cc_embeddedAgent_placeholder` is a verbatim override of the entire placeholder text. For product-name templating, omit this field and set the `product-name` HTML attribute on the widget — the UMD does the client-side templating into its default placeholder.

6. **Cartridge path order matters.** Our cartridge must come before `app_storefront_base` for the ISML override (`common/layout/page.isml`) to win. Verify via the "Effective Cartridge Path" readback.

7. **No success toast after Apply on Manage Sites.** BM UI quirk — trust the readback field instead.

8. **SFRA PDP uses server-side JVM read; SF Next PDP uses SCAPI client-side.** Same `product.custom.pdpQuestions` attribute, two totally different pickup paths. SFRA = `ProductMgr.getProduct(id).custom.pdpQuestions` in ISML. SF Next = `useProduct()` → `product.c_pdpQuestions` from SCAPI response.

9. **"AI Assistant" attribute group dumps raw JSON in the PDP by default.** SFRA's `product.isml` iterates every attribute group it finds and renders the raw value. Hide by setting `Visible=off` on the attribute definition (hides it in the storefront attribute-group renderer; server-side `.custom.pdpQuestions` reads still work). Not fixed in this round — low priority.

10. **ODS realm assignment:** our team (Rishi Ranka) is on `zyss`. Jenkins job doc: paved-path `chapter3-new-features/deployment/deploying-to-ods`.

---

## Files touched (SFRA cartridge)

Branch: `feature/w-24333475-inline-pdp-pills`

| File | Change |
|---|---|
| `cartridges/plugin_commerce_client/cartridge/templates/default/cimulate/inlineAgentWidget.isml` | +24 lines — read `custom.pdpQuestions`, read product name, set `pdp-questions` + `product-name` attributes |
| `cartridges/plugin_commerce_client/cartridge/static/default/js/inlineAgent/inline-agent-widget.umd.js` | Refreshed — opener pills, product-name templating, welcome-handoff, recoverable-error silencing |

Covered by jest tests at `test/inlineAgentWidget.test.js` and `test/pdpContextIntegration.test.js`.

---

## What's next

- **W-24333477 — SF Next:** same ODS already has SF Next demo deployed. PWA Kit opener-pills code already merged in pwa-kit PR #4049. Just need to point it at `zyss-001` and smoke-test.
- **Content Studio integration:** Set up Account Manager API client + crawl + publish pipeline so `pdpQuestions` populates automatically. Out of scope for this round; smoke test used manual BM entry on 2 products.
- **Content Studio bootstrap for new tenants:** Requires separate AM API client + OCAPI write permission. Documented in `/Users/surs/Downloads/Commerc Content Studio - User Guide.pdf`.

---

## One-liner for standup

> "Deployed the SFRA inline PDP widget end-to-end to a fresh personal ODS on `zyss` — Jenkins spawn, Site Preference + Product custom attribute setup, cartridge upload, cartridge-path wiring, product-name templating. UI contract honored both with and without opener pills. Next: SF Next smoke test on the same ODS for W-24333477."
