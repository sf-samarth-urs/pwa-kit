# Inline Agent Widget — CDN Hosting Research

**Date:** 2026-10-07
**Author:** Samarth Urs
**Status:** Research complete. Recommendation: Yes, feasible and desirable. Scope > 1 week — needs its own work item.

---

## TL;DR

- **Yes, this is exactly how the sibling Cimulate copilot-widget already ships.** Jhalak announced the pattern [here (2026-06-19)](https://salesforce-internal.slack.com/archives/C0B8BH78SAE/p1781884657824399) when the SFRA cartridge first dropped: _"The widget bundle loads directly from our CDN (`cdn.search.cimulate.ai`) at runtime. No static assets bundled in the cartridge. Version upgrades are instant — just change the version number in Business Manager, no redeployment."_ That is literally the behavior you want for `inline-agent-widget`.
- **Canonical URL template is `https://cdn.search.cimulate.ai/copilot-widget/<version>/messaging.umd.js`.** Both PWA Kit (`COMMERCE_CLIENT_CDN_BASE_URL` at `template-retail-react-app/app/constants.js:297`) and the SFRA cartridge (`DEFAULT_CDN_VERSION = '1.42.1'` at `plugin_commerce_client/.../configHelper.js:19`) consume it today. Releases are auto-announced by the Cimulate Bot into `#commerce-client-version-notifications` — v1.47.1 shipped **yesterday** ([link](https://salesforce.enterprise.slack.com/archives/C0BSKKU45HB/p1791318281745759)).
- **Publish pipeline today = the monorepo's own GH Actions job inside `cimulate-ai/cimulate`.** Helen Phan [confirmed (2026-08-17)](https://salesforce-internal.slack.com/archives/C0B8BH78SAE/) _"only the copilot-widget project has automated publishing"_, and that same pipeline failed once in Aug — [`runs/31122088730`](https://github.com/cimulate-ai/cimulate/actions/runs/31122088730/job/92688981822). The infra Jira is **CIM-1473 (publish automation)** + **CIM-1474 (CDN infrastructure)**, both owned by the Cimulate eng team. The `inline-agent-widget` repo is a **separate GitHub repo**, not inside the `cimulate-ai/cimulate` monorepo, which is why none of that publish automation covers it today.
- **The widget is already shaped for CDN publishing.** `inline-agent-widget/package.json` already sets `"main"`, `"unpkg"`, and `"jsdelivr"` to `./dist/inline-agent-widget.umd.js` and ships a UMD build via `vite.umd.config.ts`. **It's just not published anywhere yet** — `npm view inline-agent-widget` → 404; no git tags; still at version `0.1.0`; `.github/workflows/` has only `ci.yml` (unit tests). Zero release automation.
- **The feature flag "CDN vs self-hosted" already exists in the SFRA cartridge for the Commerce Client case — we can mirror that mental model.** Jhalak [called this out (2026-07-31)](https://salesforce-internal.slack.com/archives/C0B8BH78SAE/p1785560180290029): L'Oréal and similar strict-CSP customers can't load external CDNs, so `plugin_commerce_client` ships **two loading modes** switched by a BM `cc_loadingMode` preference (`cdn` or `static`). We shouldn't ditch the self-hosted path — we should make it the fallback, not the default.

---

## 1. The anchor thread (what the user cited)

**Permalink:** <https://salesforce-internal.slack.com/archives/C0B8BH78SAE/p1781884657824399>
**Channel:** `#custom-client-shopper-agent`
**Author:** Jhalak Maheshwari, 2026-06-19 08:57 PDT
**Replies:** 2 (both congratulations, no technical content)

### What the parent message actually says

> 🚀 New: `plugin_commerce_client` - Drop-in SFRA cartridge for Commerce Client (V0) for deployment on **SFRA**.
> We now have a dedicated SFRA cartridge that adds the Commerce Client (AI shopping assistant) to any storefront with zero template changes.
>
> **How it works:**
> - Install the cartridge and add it to your site's cartridge path
> - Configure everything through Business Manager Site Preferences (SCRT2 URL, Org ID, theme, etc.)
> - The widget loads automatically on every page - no code edits needed
>
> **CDN-powered delivery:** The widget bundle loads directly from our CDN (`cdn.search.cimulate.ai`) at runtime. This means:
> - **No static assets bundled in the cartridge**
> - **Version upgrades are instant** — just change the version number in Business Manager, no redeployment
> - Storefront always gets the latest fixes and features when you're ready for them
>
> For merchants/integrators, the workflow is:
> 1. Upload cartridge → 2. Import site preferences → 3. Fill in config in BM → 4. Done ✅

That's **the exact user story you want for `inline-agent-widget`.** The anchor thread is relevant and your framing is correct.

---

## 2. What's actually in production for Commerce Client / copilot-widget

### URL pattern

```
https://cdn.search.cimulate.ai/copilot-widget/<version>/messaging.umd.js
```

Examples in production right now:
- `.../copilot-widget/1.47.1/messaging.umd.js` — [latest, 2026-10-06](https://salesforce-internal.slack.com/archives/C0BSKKU45HB/p1791318281745759)
- `.../copilot-widget/1.47.0/messaging.umd.js` — SRP page context support
- `.../copilot-widget/1.46.2/messaging.umd.js` — onSessionUpdate callback
- `.../copilot-widget/1.46.1/messaging.umd.js` — telemetry gating
- `.../copilot-widget/1.37.0/messaging.umd.js` — `?ccDevMode=true` runtime override

**Versioning strategy:** semver + immutable `/<version>/` paths, **plus a mutable `/latest/` alias**. BM pref description for `cc_cdnVersion` says: _"e.g. '1.8.0' or 'latest'"_ — merchants can pin for stability or track head. For `inline-agent-widget` we should publish both: `/inline-agent-widget/<version>/inline-agent-widget.umd.js` and `/inline-agent-widget/latest/inline-agent-widget.umd.js`.

### Consumer wiring — PWA Kit

| File | Line | What it does |
|---|---|---|
| `template-retail-react-app/app/constants.js` | 297 | `export const COMMERCE_CLIENT_CDN_BASE_URL = 'https://cdn.search.cimulate.ai/copilot-widget'` |
| `template-retail-react-app/config/default.js` | 41 | `cc_cdnVersion: ''` — the merchant-controlled version string inside `COMMERCE_AGENT_SETTINGS` |
| `template-retail-react-app/config/default.js` | 46 | `commerceClientScriptSourceUrl: ''` — explicit URL override for local dev / self-hosting |
| `template-retail-react-app/app/utils/shopper-agent-utils.js` | 240–290 | `validateCommerceClientDomain(url)` — hostname allowlist: `cimulate.ai`, `*.cimulate.ai`, `*.sfcc-store-internal.net` |

Resolver: `${BASE}/${cc_cdnVersion}/messaging.umd.js` unless `commerceClientScriptSourceUrl` is set, in which case that overrides entirely. **No runtime fetching involved — the version is baked into MRT environment variables, hot-swap by Runtime Admin.**

### Consumer wiring — SFRA cartridge

| File | What it does |
|---|---|
| `plugin_commerce_client/.../configHelper.js:19` | `var DEFAULT_CDN_VERSION = '1.42.1';` |
| `plugin_commerce_client/.../configHelper.js:241` | `cdnVersion = getConfigValue(config, 'cc_cdnVersion', DEFAULT_CDN_VERSION, isNonEmptyString);` |
| `plugin_commerce_client/.../configHelper.js:290` | `loadingMode: getConfigValue(config, 'cc_loadingMode', 'cdn', isLoadingMode)` — "cdn" or "static" |
| `plugin_commerce_client/.../configHelper.js:294` | `overridesUrl: getConfigValue(config, 'cc_overridesUrl', '', isOverridesUrl)` |
| `plugin_commerce_client/.../cspHelper.js` | Emits CSP directives needed for the CDN origin |

Merchant toggles `cc_cdnVersion` in BM → next page load pulls that version. Zero redeploy. The static mode exists specifically for CSP-strict customers.

### Publish pipeline (what Helen & Praveen said)

- **Where it lives:** `cimulate-ai/cimulate` monorepo on GitHub (not SalesforceCommerceCloud).
- **How it fires:** auto-publish on merge to `main` for the `copilot-widget` project. Helen Phan [2026-08-17](https://salesforce-internal.slack.com/archives/C0B8BH78SAE/): _"only the copilot-widget project has automated publishing"_ — confirming other packages in the same monorepo (notably `agentforce-sdk`) are **manually published** today.
- **Dual publish:** every release goes to **both** the CDN (`cdn.search.cimulate.ai/copilot-widget/<v>/messaging.umd.js`) **and** npm (`@cimulate/copilot-widget@<v>`). See Cimulate Bot announcement format — every post lists both links.
- **Infra Jira:**
  - **CIM-1473** — Publish automation
  - **CIM-1474** — CDN infrastructure
  - Both referenced by Helen in `#cimu-cim-865-copilot-widget-westmarine` (2025-08-05).
- **Owners:** Cimulate eng. Jhalak + Helen have both merged release PRs. Rishi Ranka is the EM-adjacent approver for the Commerce Client side.

### Known pipeline risks (seen in Slack)

1. **Pipeline can flake.** The 2026-08-06 CI run `31122088730` failed — Helen flagged it, held merges until it cleared. Need a "hold merges" protocol if we replicate.
2. **npm publish depends on peer SDK publish ordering.** Praveen Kumar Ningappa [2026-08-21]: _"we need to merge SDK changes to master first… the publish here is automated… Once the SDK is merged use the new published SDK version in your copilot-widget PR to master."_ Same ordering risk applies to `inline-agent-widget` if it ever consumes `@cimulate/agentforce-sdk`.
3. **CSP breaks customers.** Tarundeep Batra [2026-06-16] on exactly this: a cold Cimulate CDN link 404'd and had to be added to CSP Trusted Sites — `script-src`, plus `connect-src` if the CDN script hits a sibling API domain. **This is the single biggest customer-side gotcha** and the reason the SFRA cartridge keeps `cc_loadingMode=static` as a first-class fallback.
4. **Double-injection.** Jhalak [2026-08-27] found a customer Experience Builder emitting the `<script src=".../messaging.umd.js">` **twice**, which creates double SSE connections. The widget needs to be defensive against repeated loads if we move to CDN — mounting more than once is a real-world failure mode.

---

## 3. Current wiring that would have to change for `inline-agent-widget`

### `inline-agent-widget` repo itself (`/Users/surs/inline-agent-widget`)

```json
// package.json — already partially set up
"name": "inline-agent-widget",
"version": "0.1.0",
"main": "./dist/inline-agent-widget.umd.js",
"unpkg": "./dist/inline-agent-widget.umd.js",
"jsdelivr": "./dist/inline-agent-widget.umd.js",
"scripts": {
  "build": "npm run build:esm && npm run build:umd",
  "build:umd": "vite build --config vite.umd.config.ts",
  "prepublishOnly": "npm run build"
}
```

- `files: ["dist", "README.md", "LICENSE", "NOTICE"]` — ✅ ready
- `.github/workflows/ci.yml` — ✅ exists but only runs unit tests. **No release/publish job.**
- No `publishConfig` → defaults to public npm, but **never been published** (`registry.npmjs.org/inline-agent-widget` returns `{"error":"Not found"}`)
- No git tags
- No semantic-release, no release-please, no changelog automation
- No separate CDN upload script

**Gap:** needs a release workflow that (a) tags, (b) builds UMD + ESM, (c) uploads `dist/inline-agent-widget.umd.js` to the CDN under `<version>/`, (d) optionally publishes to npm.

### PWA Kit (`/Users/surs/pwa-kit`)

Current loading is self-host, static-file:

```jsx
// packages/template-retail-react-app/app/components/inline-agent-widget/index.jsx:23
<Helmet>
  <script src="/static/inline-agent-widget.umd.js" async></script>
</Helmet>
```

Served by:
```js
// packages/template-retail-react-app/app/ssr.js:747
app.get('/static/inline-agent-widget.umd.js', runtime.serveStaticFile('static/inline-agent-widget.umd.js'))
```

And the file lives at `packages/template-retail-react-app/app/static/inline-agent-widget.umd.js`.

**To move to CDN:** mirror the Commerce Client pattern.
- Add `inlineAgent_cdnVersion` + `inlineAgent_scriptSourceUrl` to `COMMERCE_AGENT_SETTINGS` in `config/default.js`.
- Replace the hardcoded `/static/...` script tag with one computed from a new `INLINE_AGENT_WIDGET_CDN_BASE_URL` constant.
- Reuse the existing `validateCommerceClientDomain` or add a parallel allowlist.
- Keep `app.get('/static/inline-agent-widget.umd.js', ...)` as the fallback so the self-host path still works for CSP-strict customers.

CSP (`template-retail-react-app/app/ssr.js`) currently lists `script-src: ["'self'", "'unsafe-eval'", ...]` — a new `cdn.search.cimulate.ai` entry would need to be added, which **the copilot-widget consumption already requires**, so this is effectively a no-op in environments that use Commerce Client.

### SFRA cartridge (`/Users/surs/plugin_commerce_client`)

Current loading:
```isml
// cartridges/plugin_commerce_client/cartridge/templates/default/cimulate/inlineAgentWidget.isml:59
<script src="${URLUtils.staticURL('/js/inlineAgent/inline-agent-widget.umd.js')}"></script>
```

**To move to CDN:** same pattern as Commerce Client in this cartridge.
- Add `cc_inlineAgent_cdnVersion` + `cc_inlineAgent_loadingMode` + `cc_inlineAgent_scriptSourceUrl` to `cc_embeddedAgent_config` (configHelper.js validator).
- Switch the ISML `<script src>` between CDN URL and `URLUtils.staticURL` based on `loadingMode`.
- Reuse `cspHelper.js` to emit the right `Content-Security-Policy` directives when loadingMode is `cdn`.
- Default to `cdn` for new installs; keep `static` as the opt-out (same as copilot-widget).

### SF Next Storefront Next

Not inspected in this round. Based on the Koichi Yagishita / Sarath Canchi thread [2026-10-01](https://salesforce-internal.slack.com/archives/C0B6T3PSCTB/p1790901111998599), SF Next already consumes `commerceClientScriptSourceUrl` from MRT environment variables (`PUBLIC__app__cimulateAgent`) — adding an `inlineAgentScriptSourceUrl` field there mirrors the same mechanism.

### Tests that depend on the file-on-disk assertion

`plugin_commerce_client/test/inlineAgentWidget.test.js:16` has:
```js
it('loads a self-hosted bundle that is present in the uploaded cartridge', function () {
  expect(fs.existsSync(path.join(cartridgePath, 'static/default', scriptPath))).toBe(true);
});
```

This assertion would need to be reworked for CDN mode — probably split into two tests gated by `loadingMode`.

---

## 4. Recommendation

**Yes. Open a work item. Four phases.**

### Phase 1 — `inline-agent-widget` release automation (biggest unknown)

- Add GitHub Actions workflow that on tag push: builds UMD, uploads `dist/inline-agent-widget.umd.js` to `cdn.search.cimulate.ai/inline-agent-widget/<version>/inline-agent-widget.umd.js`, publishes to npm as `@cimulate/inline-agent-widget` (or similar).
- **Owner question:** does the Cimulate eng team own the CDN bucket, or does Falcon? Need to loop in Jhalak and the Cimulate SRE on **CIM-1474** before touching their bucket layout.
- **Decision:** piggyback on the existing publish-automation (**CIM-1473**) by moving `inline-agent-widget` into the `cimulate-ai/cimulate` monorepo as a sibling package to `copilot-widget`? Or keep it as a separate repo and clone the pipeline? Monorepo is faster to ship, separate repo keeps the OSS-ish split clean.
- Add changelog automation (release-please, semantic-release, or the same tool Cimulate already uses — ask Helen).
- Add a Slack webhook for release announcements, same as `#commerce-client-version-notifications`.

### Phase 2 — SFRA cartridge integration

- Add `cc_inlineAgent_cdnVersion` (default `"0.1.0"` or whatever the first published version is; accept `"latest"` as a valid value) and `cc_inlineAgent_loadingMode` (default `"cdn"`) to `configHelper.js`.
- Switch `inlineAgentWidget.isml` script tag based on mode.
- Extend `cspHelper.js` with the inline widget CDN origin.
- Keep `static/default/js/inlineAgent/inline-agent-widget.umd.js` committed as the fallback for `loadingMode: "static"` — same deal as copilot-widget. **Do not delete the self-host path.** L'Oréal-style customers need it.
- Update the jest test to split "static file exists" from "CDN URL built correctly."

### Phase 3 — PWA Kit integration

- Add `inlineAgent_cdnVersion` + `inlineAgent_scriptSourceUrl` to `COMMERCE_AGENT_SETTINGS` in `config/default.js`.
- Update the `<InlineAgentWidget>` component to build the script URL from config, falling back to the current `/static/...` path when neither is set.
- Keep `app.get('/static/inline-agent-widget.umd.js', ...)` in `ssr.js` as the self-host route.
- Extend the hostname allowlist in `shopper-agent-utils.js`.

### Phase 4 — SF Next

- Mirror the PWA Kit MRT env-var pattern on SF Next. Specifics depend on the Storefront Next config layer — needs a short recon pass against the `sfcc-store-internal.net` reference app.

### Scope / effort estimate

- Phase 1 is the critical path (CDN bucket ownership + pipeline). **~1 week with cross-team coordination with Cimulate eng.** Can start by writing the GH Actions workflow in `inline-agent-widget` directly if we decide to keep separate repo.
- Phases 2+3+4 are each ~1–2 days of code if we have Phase 1 as foundation. Mostly mirroring the copilot-widget pattern.

### Non-goals (keep in mind, don't let them creep in)

- **Don't drop the self-host fallback.** It covers CSP-strict customers; Jhalak made that call deliberately for Commerce Client and we should respect it.
- **Don't make this a V1 for widget i18n.** That's a separate work item (parked in `inline_agent_widget_i18n_gap.md`).
- **Don't pivot to an SFCC native-widget "Activity Manager" path** — Sarath Canchi has a POC ([core/pull/34598](https://git.soma.salesforce.com/commerce/digital/pull/34598), 2026-07-31) that would make the entire cartridge-plus-upload step go away, but Jhalak [called out](https://salesforce-internal.slack.com/archives/C0B8BH78SAE/p1785560180290029) that this still needs the CDN-vs-static escape hatch, and we're earlier in the funnel. Follow Sarath's work, but don't block on it.

---

## 5. People to loop into the work item

| Person | Why |
|---|---|
| **Jhalak Maheshwari** | Owns the `plugin_commerce_client` CDN loader, drove the original "no static assets" pitch, approves copilot-widget release PRs |
| **Helen Phan** | Owns the Cimulate publish automation (CIM-1473), can speak to CDN bucket + release-pipeline internals |
| **Praveen Kumar Ningappa** | Owns PWA Kit side of Commerce Client; validated the `commerceClientScriptSourceUrl` MRT-env-var swap pattern on sandbox |
| **Tejas Nadkarni** | Widget runtime behavior; was in the original "static vs CDN" test discussion |
| **Rishi Ranka** | EM, approvals + prioritization for `plugin_commerce_client` and inline widget work |
| **Tarundeep Batra** | Spoke the CSP Trusted Sites playbook that customers hit — good sanity check for the CSP piece |
| **Sarath Canchi** | Native-widget POC — not blocking, but keep in loop so we don't duplicate |

---

## 6. One-liner for standup

> _"The inline-agent-widget today ships as a static file checked into pwa-kit and plugin_commerce_client — same anti-pattern Cimulate solved last year for copilot-widget with the `cdn.search.cimulate.ai/<pkg>/<version>/*.umd.js` layout. The widget's `package.json` is already shaped for it; what's missing is a release pipeline (model = CIM-1473) and two 1-day host-side swaps on PWA Kit and the SFRA cartridge to flip the `<script src>` from `/static/…` to the CDN URL, with the self-host path preserved as a CSP fallback. Opening a work item."_
