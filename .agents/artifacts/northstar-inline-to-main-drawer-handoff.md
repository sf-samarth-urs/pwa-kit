# North Star — PDP inline widget → main Shopper Agent drawer handoff

**Goal.** When a shopper interacts with the inline embedded-agent surface on the PDP (clicks an opener pill or submits the inline input), the Shopper Agent **main drawer** opens with that question already asked, and the entire conversation (follow-ups, product tiles, escalation) continues in the drawer. The inline PDP surface never hosts a live SCRT2 conversation in this mode.

Reference images:

- **Current (Image #10)** — inline `<inline-agent-widget>` mounted below PDP image, Commerce Client drawer open separately on the right. Two independent widgets, two independent conversations.
- **North Star (Image #11, Shiseido Beauty Advisor)** — PDP shows opener questions as pills; clicking one opens the main drawer with the question appearing as the first shopper turn, agent reply streaming in the drawer.
- **UX Control Panel (Image #12)** — toggles the merchant will own: Product Selection {Drawer | In chat}, Suggestions {Carousel | List}, PDP inline widget {Agent redirect | Inline answer}, Position {Left under image | Right rail}.

---

## 1. Current state (grounded)

| Surface | File | What it is today |
|---|---|---|
| Inline PDP widget mount | `app/pages/product-detail/index.jsx:812-819` | Renders `<InlineAgentWidget config={embeddedAgentConfig} pdpQuestions={...} productName={...} />` as `actionFooter` of `ProductView` |
| Inline widget component | `app/components/inline-agent-widget/index.jsx` | Thin React wrapper. Loads `/static/inline-agent-widget.umd.js` via Helmet, mounts `<inline-agent-widget>` custom element |
| Inline widget hook | `app/hooks/use-inline-agent-widget.js` | Boots the UMD custom element with its OWN SCRT2 session (`scrt2Url`, `orgId`, `esDeveloperName`). Owns opener-pill + product-name attribute sync |
| Main drawer | `app/components/shopper-agent/index.jsx` | Two providers: MIAW (`ShopperAgentWindow`) and Commerce Client (`CommerceClientAgentWindow`). Commerce Client calls `window.CimulateMessaging.injectMessagingWidget` |
| Drawer open API | `app/utils/shopper-agent-utils.js:216 openShopperAgentWidget` | Detects provider and routes — `window.CimulateMessaging.eventHandlers.components.toggleWidgetOpen(true)` or MIAW `launchChat()` |
| Drawer FAB | `app/components/shopper-agent/commerce-client-fab.jsx` | Floating button that calls `openCommerceClientWidget(true)` |

**Key fact — two conversations today.** The inline widget UMD and the main-drawer Commerce Client bundle each initialize their own SCRT2 conversation with the same org, so a shopper who types in the inline widget and then opens the main drawer sees an empty drawer. That's exactly what the North Star eliminates.

---

## 2. Target state

### 2.1 New config mode on `embeddedAgent`

Add a mode selector that controls what the inline PDP surface *does*. Both modes continue to use the existing `commerce.embeddedAgent` config block.

```
commerce.embeddedAgent = {
  enabled: 'true',
  scrt2Url: '...',
  orgId: '...',
  esDeveloperName: '...',
  // NEW:
  mode: 'inline' | 'agent-redirect',   // default 'inline' — preserves today's behavior
  position: 'under-image' | 'right-rail' // placement toggle from Image #12; already partially supported
}
```

- `mode = 'inline'` (default) — today's behavior unchanged. The `<inline-agent-widget>` UMD mounts and runs its own SCRT2 session on the PDP.
- `mode = 'agent-redirect'` — the inline component renders a **non-conversational** prompt surface (opener pills + input + CTA). On submit, it opens the main drawer and seeds the question there. **No local SCRT2 session is created on the PDP.**

The merchant toggle in Image #12 maps 1-to-1: "Agent redirect" ⇒ `mode='agent-redirect'`, "Inline answer" ⇒ `mode='inline'`.

### 2.2 Component split

Keep `InlineAgentWidget` as the public PDP-facing component (so `product-detail/index.jsx` is unchanged except by `commerce.embeddedAgent.mode`). Internally branch:

```
<InlineAgentWidget config pdpQuestions productName>
├── mode === 'inline'          → existing <InlineAgentWidgetUMD /> path (today's code)
└── mode === 'agent-redirect'  → new <InlineAgentRedirectShim />
```

`InlineAgentRedirectShim` is small and intentionally has no SCRT2 dependency:
- Renders a question label ("Ask me anything about {productName}"), a horizontal strip of opener-question pills (same source: `pdpQuestions` from `c_pdpQuestions`), and an input + submit.
- Click handler calls a new util `handoffToShopperAgent({ question, productId, productName, pdpQuestions })`.

### 2.3 Handoff util — `handoffToShopperAgent`

New file: `app/utils/shopper-agent-handoff.js`.

Contract (single public export):

```js
export function handoffToShopperAgent({ question, productContext }) {
  // 1. Open main drawer (provider-aware; reuses openShopperAgentWidget)
  // 2. Attach product context (routing attributes OR conversationContext — see §3)
  // 3. Seed the question into the drawer's composer and send
}
```

Internally two provider branches:

**Commerce Client (preferred)** — the Cimulate widget is where we can seed a message programmatically.
- Open: `openCommerceClientWidget(true)` (already in `shopper-agent-utils.js:113`).
- Seed: dispatch via `window.CimulateMessaging.eventHandlers.session.sendMessage?.(question)` **IF the widget exposes that API** (needs confirmation with Chintan/Shilpi — see Open Questions). Fallback if `sendMessage` is not available: set `promptsConfig.staticQuestions = [question]` on next `injectMessagingWidget` call, or dispatch a `cimulate:send-user-message` CustomEvent and let the widget pick it up.
- Product context: pass via `routingAttributes.productContext = JSON.stringify({productId, productName})` so Agentforce has it (same channel the widget already uses for `isCartMgmtSupported`).

**MIAW** — MIAW does not expose a programmatic "send shopper message" API; its public surface is `userVerificationAPI` + `prechatAPI`. Options, in preference order:
1. Hide `mode='agent-redirect'` when the active provider is MIAW (log a one-time console warning so merchants know). Simplest, honest.
2. Use `prechatAPI.setHiddenPrechatFields({ InitialQuestion: question, ProductId: productId })` and let the Agentforce flow pick it up as a hidden prechat field. Requires server-side agent config to greet with that question — a merchant conversation, not a code-only change.

Default: option 1 for v1. MIAW support is explicitly out-of-scope and documented.

### 2.4 Context carryover

Beyond the question text, the drawer needs enough context to show product-aware answers:

| Field | Where it goes | Source |
|---|---|---|
| `productId` | `routingAttributes.productId` | `product?.id` on PDP |
| `productName` | `routingAttributes.productName` | `product?.name` |
| `pdpQuestions[]` | `promptsConfig.staticQuestions` (fed before send) | `c_pdpQuestions` |
| current URL | `routingAttributes.pdpUrl` | `window.location.href` |

The widget already supports a `routingAttributes` passthrough (see `shopper-agent/index.jsx:1118`), so this is additive — no SDK change.

---

## 3. UX toggles (Image #12 → config mapping)

| Panel toggle | Config field | Lives where |
|---|---|---|
| Product Selection: Drawer / In chat | `embeddedAgent.productSelectionIn = 'drawer' \| 'chat'` | Drawer-side; probably `cc_openLinksInNewTab=false` plus a new `cc_productSelectionTarget` the widget team owns |
| Suggestions: Carousel / List | `embeddedAgent.cc_showProductCaptions` + a new `cc_suggestionsLayout` | Already partially supported; widget-side |
| PDP inline widget: Agent redirect / Inline answer | `embeddedAgent.mode = 'agent-redirect' \| 'inline'` | **This WI's scope** |
| Position: Left under image / Right rail | `embeddedAgent.position = 'under-image' \| 'right-rail'` | Pure placement in `product-detail/index.jsx` |

Only `mode` and `position` need code in this WI; the other two are widget-side configuration the UX team controls separately.

---

## 4. File touch list

**Code**
- `app/components/inline-agent-widget/index.jsx` — branch on `config.mode`
- `app/components/inline-agent-widget/InlineAgentRedirectShim.jsx` *(new)* — non-conversational shim
- `app/components/inline-agent-widget/InlineAgentRedirectShim.test.jsx` *(new)*
- `app/utils/shopper-agent-handoff.js` *(new)* — provider-aware handoff
- `app/utils/shopper-agent-handoff.test.js` *(new)*
- `app/pages/product-detail/index.jsx` — unchanged markup; may wrap in positioning column driven by `embeddedAgent.position`
- `app/components/_app-config/index.jsx` — surface new config fields (if validation is centralized there)
- `config/default.js` — document new fields on `commerce.embeddedAgent`

**Tests**
- Unit: `InlineAgentRedirectShim` renders pills, submits via handoff
- Unit: `shopper-agent-handoff` — Commerce Client path opens widget + seeds; MIAW path logs warn + opens widget without seed
- Unit: `InlineAgentWidget` branches correctly on `config.mode`
- Existing `inline-agent-widget` tests continue to cover `mode='inline'` default
- E2E (optional stretch): `e2e/tests/desktop/inline-pdp-ask-assistant.spec.js` already covers inline mode; add a parallel spec `inline-pdp-agent-redirect.spec.js` for the handoff

**Docs**
- `.agents/artifacts/northstar-inline-to-main-drawer-handoff.md` *(this file)*
- Changelog + README snippet on the new `mode` field

Target ~90% unit coverage on new files, per the standing PR test-coverage expectation.

---

## 5. Phased delivery

**Phase 1 — scaffolding and Commerce Client happy path (this WI)**
1. Add `mode` + `position` to the config contract.
2. Build `InlineAgentRedirectShim` with pills + input + submit (no SCRT2).
3. Build `shopper-agent-handoff` util. Confirm the Cimulate `sendMessage` API with Chintan/Shilpi before wiring (Open Question #1). If unavailable, use `promptsConfig.staticQuestions` seeding on injection + a user-triggered submit.
4. Wire `InlineAgentWidget` to branch on mode.
5. Ship behind `mode='agent-redirect'` opt-in. Default `inline`.

**Phase 2 — hardening** (follow-up WIs, not this ticket)
- MIAW support (prechat-field path) if the product team wants it.
- `position='right-rail'` layout changes (needs ProductView API surface for a side column).
- Analytics event on handoff for merchant funnel measurement.

---

## 6. Open questions

1. ~~**Does `window.CimulateMessaging.eventHandlers.session` expose a programmatic send?**~~ **RESOLVED 2026-10-21** — Cimulate `1.44.2` ships `session.sendMessage(question)` as a public handler. Confirmed via `Object.keys(window.CimulateMessaging.eventHandlers.session)` on the running widget: `['resetConversation', 'endConversation', 'sendMessage']`. The primary seed path in `trySendViaCimulate` lands here; the CustomEvent + sessionStorage channels are now belt-and-suspenders fallbacks for future SDK versions. **No `sendUserMessage` / `sendUserText` aliases exist in 1.44.2** — the fallback names in `trySendViaCimulate` are defensive against future renames and should be kept.
2. **Should the question appear as a shopper turn before the agent responds?** **RESOLVED** — yes, and that is the observed behavior. `session.sendMessage(question)` renders the question as the first shopper turn immediately, then the agent streams a reply. Matches the Shiseido reference.
3. **Position = right-rail** requires `ProductView` to accept a side-column slot; today `InlineAgentWidget` is passed as `actionFooter` which is below the image. Confirm with design whether we restructure `ProductView` or wrap outside it.
4. **Agentforce routing**: do we want the agent to greet with the product name immediately on handoff, or wait for the first shopper message? Routing attributes carry productId regardless.
5. **Carousel / tile relevance.** Observed on 2026-10-21: when the inline pill is "How does this compare to the TrailFit Charge 2 or Surge?", the agent's streamed response includes a product carousel that mixes in unrelated models (e.g. a Casio-style watch). This is an agent-side retrieval/grounding issue (Agentforce product search over `BYONCommerceClientAPI`), not a template bug — the question text and `productContext` (`productId=500400`, `productName=TrailFit Alta`) are both delivered correctly. Flag to Chintan/Shilpi + the Agentforce prompt owner. One StaticContentMessage with a mismatch example: `conversationEntries.id = a854934f-340f-4ec5-ae76-521bcc75f30b` (esDeveloperName `BYONCommerceClientAPI`).

---

## 7. Rollout + risk

- **Default stays `inline`** → zero regression risk for existing deployments.
- **New mode is opt-in via config** → merchants adopt when ready.
- **No SDK changes** → everything is template-side.
- Rollback is a one-line config flip to `mode: 'inline'`.
- ~~Risk: Cimulate widget API confirmation blocks Phase 1 completion.~~ **Cleared 2026-10-21** — `session.sendMessage` confirmed on `cc_cdnVersion: '1.44.2'`. Primary seed path is live.
- New risk (minor, agent-side not template-side): a question hands off correctly but the drawer's streamed response may surface a product carousel with partially off-topic tiles (observed with the Charge-2/Surge compare pill). Owner is Agentforce prompt / product-search config, not this WI.

---

## 8. Phase-1 prototype — status (2026-10-21)

**W-24604411** — "PDP inline widget: Agent-redirect mode (hand off to main Shopper Agent drawer)". Status: `New`. Assignee Samarth Urs, Product Tag CC-Chatty (ECOMConcierge), Epic `a3QEE000002jfYv2AI`.

**Files landed on `develop` (uncommitted)**:

- `app/utils/shopper-agent-handoff.js` + `.test.js` — handoffToShopperAgent + consumePersistedSeed. 12 unit tests. Tries Cimulate `sendMessage`/`sendUserMessage`/`sendUserText`, falls through to CustomEvent + sessionStorage seed on any name mismatch.
- `app/components/inline-agent-widget/InlineAgentRedirectShim.jsx` + `.test.jsx` — the non-conversational PDP shim. 8 unit tests.
- `app/components/inline-agent-widget/index.jsx` — now branches on `config.mode`. New `productId` prop forwarded from PDP.
- `app/components/inline-agent-widget/index.test.jsx` — branch coverage.
- `app/pages/product-detail/index.jsx` — passes `productId={productResponse?.id}` to `InlineAgentWidget`.
- `config/default.js` — documents the new `mode` field; defaults to `'inline'`.

**Local dev server**: `http://localhost:3000/us/en-US/product/500400` (NTO electronics "TrailFit Alta"). The SSR HTML carries `data-testid="inline-agent-redirect-shim"`, "Have a question?" title, "Ask me anything about TrailFit Alta" placeholder. `__APP_CONFIG__.commerce.embeddedAgent.mode === 'agent-redirect'`. Both widgets co-exist: inline shim below the image, main Shopper Agent FAB on the right rail. Clicking the pill (or submitting the input) fires `handoffToShopperAgent`, which (a) opens the Commerce Client drawer, (b) seeds via **`window.CimulateMessaging.eventHandlers.session.sendMessage(question)`** — confirmed working on `cc_cdnVersion: '1.44.2'` — so the question renders immediately as the first shopper turn and the agent streams a reply, (c) also fires a `shopper-agent:seed-question` CustomEvent and stashes the seed in `sessionStorage` as resilience channels for future SDK versions or alternate drawer providers.

**Primary path verified (2026-10-21)** — on the running widget:

```js
Object.keys(window.CimulateMessaging.eventHandlers.session)
// → ['resetConversation', 'endConversation', 'sendMessage']
```

So `trySendViaCimulate` matches `sendMessage` on its first attempt. `sendUserMessage` / `sendUserText` fallbacks never fire today but stay in the code as defense against future renames.

**sessionStorage persistence note**: `shopper-agent-seed-question` is intentionally **not** consumed when `sendMessage` succeeds — `consumePersistedSeed()` is wired for a future drawer-side listener that would reads it on first mount. If we never add that listener (which we probably won't now that `sendMessage` works), the stale entry is harmless: it's overwritten on the next handoff and cleared on tab close. Open follow-up: either delete the sessionStorage branch when we're sure, or add a `.consumePersistedSeed()` call inside `handoffToShopperAgent` right after a successful `sendMessage` to tidy up. Mild preference for the latter — it's 2 lines.

**Minor agent-side gap** (not blocking, not a template fix): on pills like "How does this compare to the TrailFit Charge 2 or Surge?", the drawer's response can include a product carousel with partially off-topic tiles (e.g. an unrelated watch). The question text + `productContext` arrive at the agent correctly — this is an Agentforce prompt / product-search tuning issue. One example to share with the agent-side owner: `conversationEntries.id = a854934f-340f-4ec5-ae76-521bcc75f30b`, `esDeveloperName = BYONCommerceClientAPI`, `messageType = StaticContentMessage`.

**Test run**: 23/23 passing — `shopper-agent-handoff.test.js` (12), `InlineAgentRedirectShim.test.jsx` (8), `index.test.jsx` (3). The pre-existing global coverage threshold in `jest.config.js` fails on scoped runs because other packages aren't exercised; a full suite run keeps it green.

**Prod-URL inspection (reference)**: on any live PWA Kit storefront, these DevTools Console snippets confirm the handoff surface:

```js
window.__APP_CONFIG__?.commerce?.embeddedAgent                                   // config block
Object.keys(window.CimulateMessaging?.eventHandlers?.session || {})              // ['resetConversation','endConversation','sendMessage'] on 1.44.2
sessionStorage.getItem('shopper-agent-seed-question')                            // seed JSON if a pill was just clicked
window.addEventListener('shopper-agent:seed-question', e => console.log(e.detail)) // live-listen for the CustomEvent
document.querySelector('[data-testid="inline-agent-redirect-shim"]')             // true iff mode === 'agent-redirect'
```

---

## 9. GUS work item (draft — awaiting user approval)

```
RecordTypeId  = 0129000000006gDAAQ    # User_Story
Assignee__c   = 005EE000004mM0jYAE    # Samarth Urs
Product_Tag__c= a1aEE000000XwBhYAK    # CC - Chatty (ECOMConcierge)
Scrum_Team__c = a00EE00000v6l3RYAQ    # same team as W-24333475/-77
Epic__c       = a3QEE000002jfYv2AI    # PDP Epic (parent)
Status__c     = New
Subject__c    = PDP inline widget: Agent-redirect mode (hand off to main Shopper Agent drawer)
Details__c    = See .agents/artifacts/northstar-inline-to-main-drawer-handoff.md.
                Add a new `mode` field to commerce.embeddedAgent with values 'inline' (default,
                today's behavior) and 'agent-redirect'. In agent-redirect mode the PDP shows a
                non-conversational opener-pills + input shim; clicking a pill or submitting
                opens the main Shopper Agent drawer with the question seeded and product
                context attached via routingAttributes. Commerce Client provider is in scope;
                MIAW is out-of-scope for v1 (opt-out with console warning). ~90% unit coverage
                on new files. Rollback = flip config back to 'inline'.
```
