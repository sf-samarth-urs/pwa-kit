# Storefront cleanup — tbdp_prd / NTOManaged on PWA Kit

Session continuation for W-24333476. Pills (PR-A + PR-B) are landed and functional.
Remaining visible defects on `localhost:3000/us/en-US/product/500400`:

1. **Red toast "Something went wrong. Try again."** fires on PDP load, no user action
2. **Product images render as broken** (alt text only, no `<img>` fetch)
3. **Floating "Commerce Client" widget tiles link to SFRA storefront**
   (`shop.prd.tbdp.sfcc-store-internal.net`) instead of localhost:3000
4. (Noted but not a bug) **Pill answers are correct** — "GPS: no" on TrailFit Alta is accurate

The research below pinpoints each root cause with file + line references and names the
smallest config / code change to clear it.

---

## 1) "Something went wrong. Try again." toast — root cause identified

### Two distinct error messages in the codebase

| String | File | Variable | Who fires it |
|---|---|---|---|
| `Something went wrong. Try again!` *(exclamation)* | `app/constants.js:96-99` | `API_ERROR_MESSAGE` | Wishlist, promo, cart, product-view |
| `Something went wrong. Try again.` *(period)* | `app/components/shopper-agent/index.jsx:47-50` | `SESSION_INIT_ERROR_MESSAGE` | Commerce Client (standalone widget) auth-link / token-bridge |

**The screenshot shows the period variant** → this is the **standalone Commerce Client
widget's session-init failure**, NOT the inline PDP widget, NOT the wishlist, NOT PR-A/B.

### Where it fires

`packages/template-retail-react-app/app/components/shopper-agent/index.jsx`:

| Line | Context |
|---|---|
| 412-418 | `failSessionInit()` helper — reset embedded-messaging session + toast |
| 935-938 | After `callTokenBridge()` returns non-200 (auth-link flow) |
| 947-950 | Catch block when the auth-link `run()` throws |

### Why it fires on tbdp_prd

The Commerce Client (`shopper-agent` component) does a two-step handshake when it
mounts:

```
Step 1: /commerce-client/auth-link   → returns an authLinkKey
Step 2: callTokenBridge({authLinkKey, slasAccessToken, siteId})
        → POSTs to SCRT2 to link the chat conversation to the SLAS shopper
```

Expected 200. On any non-200 or thrown error → red toast.

**Likely 401/403/4xx cause**:
- The `COMMERCE_AGENT_SETTINGS` env var sets `scrt2Url` =
  `q3sdb60111062025mp1.test1.my.pc-rnd.salesforce-scrt.com` (per session memory § "Local-only dev diffs")
- That SCRT2 tenant's `commerceOrgId` is wired to tbdp_prd on the Commerce Client side
- But the SLAS shopper token minted from `af919544-…` on tbdp_prd may not be accepted
  by the token-bridge if the SCRT2 side wasn't provisioned to link against that siteId
- Or the auth-link endpoint itself (served by the agent's gateway service) returned non-200

**Verification**: open DevTools → Network → filter `token-bridge` or `auth-link`
when loading the PDP. The failing response code tells us exactly which half broke.
Pre-emptive fix below.

### Fix paths (ranked)

1. **Disable the standalone Commerce Client in dev** (fastest, zero risk, demo-focused).
   The inline PDP widget covers the "Ask Assistant on PDP" story — the floating
   "Commerce Client" launcher is a *different* feature we're not demoing. Set
   `COMMERCE_AGENT_SETTINGS` env var to `enabled: 'false'` or remove it entirely from
   `.env`. Confirmed guard: `components/shopper-agent/index.jsx:146-148` returns early
   when `enabled !== 'true'`.

2. **Investigate token-bridge 4xx** if we want the floating widget running. Needs
   backend wiring from Chintan/Rishi (SCRT2 side provisioning + Commerce Client org
   setup on q3sdb60111062025mp1). Out of scope for this storefront cleanup.

3. **Suppress the toast on the ONE failing event only** — fragile, hides a legitimate
   error signal, don't recommend.

---

## 2) Broken product images — root cause: image domain not proxied

### How images flow

**SCAPI response → ImageGallery → DynamicImage → `<img>`**

| Hop | File | Line | What it does |
|---|---|---|---|
| 1 | `app/pages/product-detail/index.jsx` | 113-138 | `useProduct()` → `productResponse.imageGroups[]` |
| 2 | `app/components/image-gallery/index.jsx` | 110 | hero `src = image.disBaseLink \|\| image.link` + `?sw=X&q=60` |
| 2 | `app/components/image-gallery/index.jsx` | 148 | thumbnail `src = image.disBaseLink \|\| image.link` |
| 3 | `app/components/dynamic-image/index.jsx` | 96 | passes `src` straight to `<img>` — no rewrite |

**No storefront-side URL rewriting exists.** URLs pass through as-is from SCAPI.

### Why it breaks on tbdp_prd

`packages/template-retail-react-app/config/default.js:266-275`:

```js
proxyConfigs: [
    {host: 'sandbox-001.api.commercecloud.salesforce.com', path: 'api'},
    {host: 'sandbox-001.dx.commercecloud.salesforce.com',  path: 'ocapi'}
]
```

Only SCAPI + OCAPI are proxied. Images on tbdp_prd come back from the SFCC image
server at a domain like `edge.disstg.commercecloud.salesforce.com` (production) or
`<realm>.dx.commercecloud.salesforce.com/on/demandware.static/...` (BM) or similar.
Not in the proxy allowlist → browser fetches direct → either CORS, cert, or 404.

**The alt-text-only render in the screenshot** is proof: the `<img>` element renders
but its `src` fails to load, so the browser falls back to showing alt text.

### Fix

Open DevTools → Network → filter `.jpg` or `.png` → load the PDP → inspect:
1. The exact `src` URL being requested
2. The HTTP response (404? CORS fail? SSL fail?)

Then pick one:

**Option A: Add image host to `proxyConfigs`** (cleanest, matches SFCC convention)

Append to `config/default.js:266-275`:
```js
{host: '<image-host-from-devtools>.commercecloud.salesforce.com', path: 'img'}
```

Then rewrite `image-gallery/index.jsx:110,148` to prefix with `/mobify/proxy/img`
when the src is on that host. OR configure PWA Kit SSR to auto-rewrite via a
`getConfig('app').imageProxyPath` knob.

**Option B: Direct-serve images** (if the host is public and CORS-friendly). No code
change — just verify the URL in DevTools and confirm the fetch fails for a NON-CORS
reason (404, DNS). If it's a true 404, SCAPI is returning bad URLs — tbdp_prd image
server might not be configured for NTOManaged's image feed.

**Option C**: use `getImageUrl()` helper to rewrite image URLs through a known-good
proxy host. Not currently in the retail-react-app — would be new code.

---

## 3) Commerce Client product tiles link to SFRA — by design, needs override

### What's happening

The floating "Commerce Client" chat (bottom-right) renders rich product cards. Each
card's link target: `https://www.shop.prd.tbdp.sfcc-store-internal.net/nto/en_US/trailfit-blaze-500600.html`.

That's the **SFRA storefront URL** for tbdp_prd/NTO — the canonical production-facing
storefront. The Commerce Client's product-card component uses whatever URL the
backend agent action returns in its card payload. On the server side, the agent is
configured with the SFRA storefront as the storefront URL.

### Where the mount happens

- Env var: `COMMERCE_AGENT_SETTINGS` (parsed in `config/default.js`, consumed by `components/shopper-agent/index.jsx`)
- Script source: `scriptSourceUrl` (loaded via `useScript`) — hosted on a Salesforce
  domain, validated at `shopper-agent/index.jsx:59-75`
- Element id default: `DEFAULT_COMMERCE_CLIENT_ELEMENT_ID` (constants.js)

### Why the link isn't localhost

The widget passes `domainUrl: s.domainUrl` to the embedded messaging prechat fields
(`shopper-agent/index.jsx:400`). `domainUrl` comes from `useAppOrigin()` (line 28) —
on localhost that returns `http://localhost:3000`. **But the agent backend ignores
`domainUrl`** when building product-card links; it uses the storefront URL
configured server-side in the Commerce Agent action (which is Chintan's SFRA URL).

### Fix paths

1. **Pass a storefront override via `conversationContext`** — the widget supports
   `commerceAgent.conversationContext` (array, validated at `shopper-agent/index.jsx:120-125`).
   If the backend agent action reads a `storefrontUrl` field from conversation
   context, we can inject `storefrontUrl=http://localhost:3000` here. Needs Rishi/
   Chintan to confirm the action's input shape.

2. **Rewrite the links client-side in the widget** — intercept DOM `<a>` clicks
   inside the Commerce Client iframe. Fragile; not a paved path.

3. **Disable the Commerce Client floating widget in dev** — same remedy as the
   session-init toast. Removes the broken tiles entirely for the demo.

**Recommendation**: Option 3 for the Monday demo. The inline PDP widget covers the
"Ask Assistant" story; the floating Commerce Client is a different launcher we don't
need running. Keep it off until Rishi/Chintan confirm the backend accepts a
storefront-URL override.

---

## 4) Pill answer quality (NOT a bug)

User reported: "pdp questions should show correct answers. sometimes yes sometimes NO."

Example captured:

> **Q**: What does SmartTrack do?
> **A**: The TrailFit Alta does not have built-in GPS tracking, but its SmartTrack
> feature automatically recognizes and records select exercises…

**This is a correct answer.** TrailFit Alta is Fitbit Alta HR-equivalent — a basic
fitness wristband without GPS. Its only motion feature is SmartTrack. The LLM
grounded on the product's `shortDescription` and returned truthful "no GPS" plus
correct SmartTrack feature description.

### "Sometimes yes sometimes NO" is BYON grounding non-determinism

The widget hack ships only the `productId` marker:
```
(Viewing product details for inline-widget: 500400)\n\nWhat does SmartTrack do?
```

The BYON action on the agent side pulls the product record for `500400` and feeds
it to the LLM. The LLM then answers from that context. Two sources of variance:

1. **LLM temperature/sampling** — same product record, same question, different
   answer phrasings. Non-deterministic by design.
2. **BYON grounding scope** — if BYON only fetches `shortDescription` (not
   `longDescription`, variants, categories), some answers will say "the product
   details don't mention X" even when X is implicitly true.

### Fix path (deferred — not in this cleanup)

- **(2)** is a BYON config question: what fields does the Commerce Client Action
  include when it hydrates the product? Owned by Chintan/Rishi.
- **(1)** is inherent to LLM — can be reduced with lower temperature, better
  system prompt, or stricter grounding instructions.

Neither is a PWA Kit / inline widget bug. PR-A + PR-B's job is to ship the question
through to BYON — which they do, confirmed by DevTools network payload showing the
`(Viewing product details for inline-widget: 500400)` marker on every outgoing
SCRT2 message.

### What CAN be fixed on our side

Make the LLM grounding stronger by **giving BYON more fields**. If Chintan's
Commerce Client Action currently fetches `shortDescription` + `name` only, we could
request he add `longDescription`, `brand`, `color`, `size`, `c_*` custom attrs, and
category breadcrumbs. That's a one-config-change on the agent-action side, not a
widget change. Deferred follow-up — add to the group chat.

---

## Confirmed working from PR-A + PR-B (so you don't rewrite)

- Opener-pill contract (`pdp-questions` attribute, cap 5, graceful parse-fail)
- Pill render below input, hide on engagement (`hasEngaged` gate)
- Pill click → sends through same `sendMessage` path as typed input
- Product-context marker still fires (`(Viewing product details for inline-widget: <pid>)`)
- SPA-nav re-seeds pills via `RESET_CONVERSATION`
- Rebuilt UMD bundle at `app/static/inline-agent-widget.umd.js` ships the UI
- SCAPI → `c_pdpQuestions` → `productResponse` → `<InlineAgentWidget pdpQuestions={...} />`
- 142 widget tests + 6 utils tests green

PR-A and PR-B do NOT need to be reopened for any of the three defects above. Each
defect sits in a different code owner:

| Defect | Owner | Code location |
|---|---|---|
| Session-init toast | Commerce Client (shopper-agent) | retail-react-app `components/shopper-agent/` |
| Broken images | retail-react-app config | `config/default.js` `proxyConfigs` |
| Tile links → SFRA | Commerce Client backend action | Chintan/Rishi backend config |
| Pill answer variance | BYON action grounding | Chintan/Rishi backend config |

---

## Recommended action order (demo-focused, ~30 min to clean storefront)

### Step 1 — Kill the floating Commerce Client in dev (5 min)

Edit `/Users/surs/pwa-kit/packages/template-retail-react-app/.env`:

```diff
- COMMERCE_AGENT_SETTINGS='{"enabled":"true", ...}'
+ COMMERCE_AGENT_SETTINGS='{"enabled":"false","askAgentOnSearch":"false","embeddedServiceName":"","embeddedServiceEndpoint":"","scriptSourceUrl":"","scrt2Url":"","salesforceOrgId":"","commerceOrgId":"","siteId":""}'
```

(The required-fields validator at `shopper-agent/index.jsx:91-105` demands all keys
present as non-empty strings. Easiest safe-off is set them to `""` with
`"enabled":"false"` — then `isEnabled()` short-circuits at line 146.)

Save → hot-reload → floating launcher disappears → toast gone → tile-link problem gone.

Keep `INLINE_AGENT_WIDGET_COMMERCE_SETTINGS` as-is (inline PDP widget stays).

### Step 2 — Diagnose image URL (10 min)

1. Reload the PDP
2. DevTools → Network → filter `Img`
3. Click one of the broken image rows
4. Note the `Request URL` host and the HTTP status

Report that back and we'll pick between **A: add proxy** vs **B: fix SCAPI config**
vs **C: rewrite client-side**.

### Step 3 — Verify PDP is clean (5 min)

Reload. Expected end-state:
- No red toast
- Inline PDP widget renders with 5 pills (if 500400 has `c_pdpQuestions`)
- No floating Commerce Client bottom-right
- Images render (after Step 2 fix)
- Pills click → stream → correct answer
- SPA-nav to another PDP → pills reset

### Step 4 (deferred to Chintan) — Ping Rishi on BYON grounding scope

> "What fields does the Commerce Client Action's BYON hydration include? If it's
> only `name` + `shortDescription`, we're seeing cases where the LLM says
> 'details don't mention X' when X is in `longDescription` or a `c_*` attr.
> Would adding `longDescription`, `brand`, `c_*` custom attributes, and
> categories improve answer accuracy?"

### Step 5 (deferred) — Chintan: can product-card URL be overridden to localhost in dev?

> "The Commerce Client floating widget's product tiles link to the SFRA storefront
> (`shop.prd.tbdp.sfcc-store-internal.net`). For PWA Kit dev, is there a way to
> override that in the agent action — perhaps via `conversationContext` with a
> `storefrontUrl` key — so dev iterations stay on localhost?"

---

## Appendix — Key files (quick refs)

### Toast dispatch

- `packages/template-retail-react-app/app/components/shopper-agent/index.jsx`
  - `L47-50` SESSION_INIT_ERROR_MESSAGE definition (period variant)
  - `L85-137` validateCommerceAgentSettings
  - `L146-148` isEnabled() — short-circuits when `enabled !== 'true'`
  - `L412-418` failSessionInit() helper
  - `L920-951` performAuthLink error paths (both toasts here)
- `packages/template-retail-react-app/app/constants.js:96-99` API_ERROR_MESSAGE
  (exclamation variant — different code path, not what the user saw)

### Image rendering

- `packages/template-retail-react-app/app/components/image-gallery/index.jsx`
  - `L110` hero `src = disBaseLink || link + ?sw=X&q=60`
  - `L148` thumbnails `src = disBaseLink || link`
- `packages/template-retail-react-app/app/components/dynamic-image/index.jsx:96`
  passes through to `<img>`
- `packages/template-retail-react-app/config/default.js:266-275` proxyConfigs
  (missing image host)

### PR-A + PR-B wiring (already landed, no changes needed)

- `packages/template-retail-react-app/app/pages/product-detail/index.jsx:814`
  — reads `productResponse?.c_pdpQuestions`
- `packages/template-retail-react-app/app/utils/inline-agent-widget-utils.js`
  — `parsePdpQuestions` SSR-safe helper
- `packages/template-retail-react-app/app/components/inline-agent-widget/index.jsx`
  — accepts `pdpQuestions` prop, forwards to hook
- `packages/template-retail-react-app/app/hooks/use-inline-agent-widget.js`
  — seeds at mount + sync effect keyed on `JSON.stringify(pdpQuestions)`
- `packages/template-retail-react-app/app/static/inline-agent-widget.umd.js`
  — rebuilt bundle
