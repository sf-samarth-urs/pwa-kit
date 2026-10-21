# Inline PDP Agent Widget — Architecture Notes

W-24333476 — written 2026-10-05 as a reference for future me.

## 1. The two repos, and how they talk

```
┌─────────────────────────────────┐          ┌────────────────────────────────┐
│  inline-agent-widget            │   UMD    │  pwa-kit (storefront)          │
│  (the chat UI library)          │  ──────► │  template-retail-react-app     │
│                                 │  bundle  │                                │
│  React + TypeScript             │          │  React + Express SSR           │
│  Builds → dist/*.umd.js         │          │  Imports via <script> tag      │
└─────────────────────────────────┘          └────────────────────────────────┘
                                                           │
                                                           │ SSE / HTTPS
                                                           ▼
                                              ┌────────────────────────────┐
                                              │  Agentforce (SCRT2)        │
                                              │  Salesforce's agent engine │
                                              └────────────────────────────┘
```

**Key insight:** pwa-kit does NOT `import` the widget as an npm package. It consumes
it as a **custom element** loaded from a static file. Why?
- The widget needs to work with SFRA storefronts too (which aren't React). A custom
  element is a browser-native API, framework-agnostic.
- It isolates the widget's React runtime from pwa-kit's React runtime — no
  version-skew hell, no shared state surprises.

---

## 2. UMD — what it is, why we build one

**UMD = Universal Module Definition.** A single JavaScript file that works in any
environment: `<script>` tag, CommonJS `require`, AMD `define`. Think "a library
you can drop into any page."

Our widget's `vite.umd.config.ts` builds `dist/inline-agent-widget.umd.js` — a
**346 KB file (108 KB gzipped) that bundles everything**: React, our components,
the reducer, the Agentforce SDK, the CSS (via `<style>` injection), the
custom-element registration.

In pwa-kit:
```html
<script src="/static/inline-agent-widget.umd.js" async></script>
<inline-agent-widget scrt2-url="..." org-id="..." pdp-questions='["Q1","Q2"]'></inline-agent-widget>
```

The browser sees `<inline-agent-widget>`, the UMD has already called
`customElements.define('inline-agent-widget', ...)`, and the custom element
bootstraps a React tree inside its own Shadow DOM. **pwa-kit's React never knows
this React exists.**

---

## 3. Custom element — the bridge between React and HTML

`src/custom-element.ts` is a plain Web Components class extending `HTMLElement`.
Three responsibilities:

```ts
class InlineAgentWidget extends HTMLElement {
  // 1. Declare which attributes to watch
  static get observedAttributes() {
    return ['scrt2-url', 'org-id', 'pdp-questions', 'product-name', ...]
  }

  // 2. Mount a React tree into a Shadow DOM when the element enters the page
  connectedCallback() {
    const shadow = this.attachShadow({ mode: 'open' })
    this.root = ReactDOM.createRoot(shadow)
    this.root.render(<WidgetProvider config={readConfig(this)}><App/></WidgetProvider>)
  }

  // 3. Re-render when attributes change (e.g. SPA PDP nav swaps `pdp-questions`)
  attributeChangedCallback() { this.root.render(...) }
}
```

The attribute-sync hooks on the pwa-kit side (`use-inline-agent-widget.js`) call
`el.setAttribute('product-name', productName)` whenever the shopper picks a
variant — the custom element's `attributeChangedCallback` fires, the React tree
re-renders, the InputBar placeholder updates. **No widget teardown, no SCRT2
session loss.**

---

## 4. Inside the widget — the React/reducer architecture

```
┌────────────────────────────────────────────────────────────────┐
│  <WidgetProvider>  (src/provider/WidgetProvider.tsx)           │
│                                                                │
│  • Owns the SCRT2 client (Agentforce SDK)                      │
│  • Subscribes to SSE events (message, streaming_token, error)  │
│  • Translates events → reducer dispatches                      │
│  • Exposes sendMessage() to children                           │
│                                                                │
│  State (useReducer):                                           │
│  ┌──────────────────────────────────────────┐                  │
│  │  WidgetState (src/provider/types.ts)     │                  │
│  │  • status, answer, streamingText         │                  │
│  │  • agentTyping, error, lastQuestion      │                  │
│  │  • pdpQuestions, askedQuestions          │                  │
│  └──────────────────────────────────────────┘                  │
│                                                                │
│  Reducer (src/provider/reducer.ts):                            │
│  ┌──────────────────────────────────────────┐                  │
│  │  (state, action) => newState             │                  │
│  │  pure, deterministic, unit-testable      │                  │
│  └──────────────────────────────────────────┘                  │
└────────────────────────────────────────────────────────────────┘
             │
             │ context + hooks
             ▼
┌────────────────────────────────────────────────────────────────┐
│  <App>  (src/App.tsx) — layout only                            │
│    <InputBar/>                                                 │
│    <Response/>         ← user bubble + answer                  │
│    <QuestionPills/>    ← drains                                │
└────────────────────────────────────────────────────────────────┘
```

### 4a. What a reducer is

A reducer is a **pure function** `(oldState, action) => newState`. It is the
ONLY way state changes. Every event in the app is expressed as an action, like:

```ts
{ type: "ASK_QUESTION", question: "What size should I get?" }
{ type: "SET_ANSWER", content: "I recommend size M" }
{ type: "RESET_CONVERSATION" }
```

The reducer switches on `action.type` and returns a new state object. React's
`useReducer` hook gives you `[state, dispatch]`; components `dispatch(action)`
and re-render when state changes.

**Why this pattern:** every state transition is in one file, pure, no I/O, no
network. You can unit-test the whole state machine with
`expect(reducer(state, action)).toEqual(expected)` — which is exactly what
`tests/provider/reducer.test.ts` does.

### 4b. The `useRef` siblings

Reducer state is for **"things the UI should re-render when they change"**.
There's a parallel world of state that handlers read but shouldn't trigger
re-renders — the welcome-handoff booleans, timers, the SCRT2 client itself.
Those live in `useRef`:

```ts
const hasUserSentRef = useRef(false)      // "has shopper engaged?"
const welcomeDroppedRef = useRef(false)   // "has the welcome been consumed?"
const welcomeGateRef = useRef(new WelcomeGate())
```

A ref is `{ current: value }` that persists across renders without triggering
them. The SSE handlers read `.current` to decide what to do with each incoming
event.

---

## 5. The "pure module" pattern — why we extracted `welcome-tracker.ts`

Before the TDD refactor, the welcome-handoff logic lived inline inside the
`WidgetProvider`'s SSE message handler as nested `if`s:

```ts
// ⚠️ The brittle shape — inside a long-lived SSE handler
client.on("message", (e) => {
  if (!hasUserSentRef.current) {
    if (sender === "chatbot") {
      if (welcomeGateRef.current.pending) { /* ... */ }
      else { /* ... another branch ... */ }
    }
  } else { /* post-send branch */ }
})
```

Problems:
- Can't unit-test (needs real SDK, real SSE, real DOM).
- Every bug fix meant adding another `if` and praying the window didn't collide
  with an existing one. **Two regressions in two days proved this didn't work.**

The refactor **extracted the pure logic** — just the "given these booleans,
what should I do?" decision — into its own file:

```ts
// src/provider/welcome-tracker.ts — pure, no I/O
export function classifyMessage(sender, ctx): MessageVerdict {
  if (!ctx.hasUserSent) {
    if (sender === "chatbot") return { action: "drop-welcome", wasPending: ctx.gatePending }
    return { action: "ignore" }
  }
  // post-send branches...
}
```

Now `WidgetProvider` is a thin dispatcher:

```ts
client.on("message", (e) => {
  const verdict = classifyMessage(sender, { hasUserSent, welcomeDropped, gatePending })
  if (verdict.action === "drop-welcome") { /* flip refs */ }
  else if (verdict.action === "render-answer") { dispatch({ type: "SET_ANSWER", content: e.content }) }
})
```

And `tests/provider/welcome-tracker.test.ts` can test every timing window with
plain function calls — no React, no SDK, no DOM.

**This is the "module" architecture:** separate the pure decision from the
impure glue, test the pure part exhaustively, keep the glue thin enough to
eyeball-verify.

---

## 6. How pwa-kit consumes the widget, end-to-end

```
app/pages/product-detail/index.jsx       ← PDP page component
  └─ <InlineAgentWidget pdpQuestions={..} productName={productResponse.name}/>
       │
       ▼
app/components/inline-agent-widget/      ← thin React wrapper
  index.jsx
  └─ const containerRef = useInlineAgentWidget(config, { pdpQuestions, productName })
     return <div ref={containerRef}/>
       │
       ▼
app/hooks/use-inline-agent-widget.js     ← the actual plumbing
  • ensureWidget(): makes sure <script src="/static/inline-agent-widget.umd.js">
    is in <head> and customElements.whenDefined('inline-agent-widget') resolved
  • creates <inline-agent-widget scrt2-url="..." pdp-questions='[..]' ...>
  • appendChild into containerRef.current
  • Separate useEffect for each attribute: when productName changes, call
    el.setAttribute('product-name', ...) → widget re-renders via its
    attributeChangedCallback → no teardown, no SCRT2 session loss
       │
       ▼
app/static/inline-agent-widget.umd.js    ← widget bundle
  • Served by Express at /static/*
  • Checked into pwa-kit for easy consumption
  • Rebuilt and copied whenever widget-side ships a feature
```

Chain: **PDP page passes product data → pwa-kit wrapper → hook translates to
custom-element attributes → widget's custom element observes attributes →
React re-renders → UI updates.**

---

## 7. Agentforce — the agent engine

Agentforce (API-named `SCRT2` for historical reasons: "Salesforce Chat Runtime
v2") is Salesforce's conversational AI backend. Our widget talks to it as an
**anonymous shopper** — no login required.

Handshake flow (lives in `src/scrt2/`):

```
1. POST /iamessage/api/v2/authorization/unauthenticated/accessToken
   → short-lived JWT bound to this device

2. GET  /eventrouter/v1/sse?...   (Server-Sent Events)
   → persistent stream for inbound events (messages, typing, errors)

3. POST /iamessage/api/v2/conversation
   → creates a conversation; the agent emits a welcome greeting immediately

4. POST /iamessage/api/v2/conversation/{id}/message
   → sends the shopper's question
```

The **welcome greeting at step 3 is why the welcome-handoff state machine
exists.** Agentforce auto-emits it the moment a conversation is created, and
we drop it so an idle PDP never shows unsolicited bot text. The three timing
windows the classifier covers all come from this: "welcome arrives before user
POST", "welcome arrives after user POST", "welcome arrives after the 5s safety
timeout but before/after the real answer".

---

## 8. The hierarchy, from shopper click to agent answer

1. Shopper clicks a pill → `QuestionPills` calls `sendMessage(text)` (from
   `useWidget()` hook)
2. `WidgetProvider.sendMessage` dispatches `ASK_QUESTION` (reducer updates
   `lastQuestion`, clears `answer`, adds to `askedQuestions`)
3. `sendMessage` `await`s the `welcomeGate` (blocks until the welcome resolves
   or 5s timeout)
4. `sendMessage` POSTs to Agentforce via the SCRT2 client
5. Agentforce streams `streaming_token` events over SSE →
   `shouldAppendStreamingToken()` says yes → reducer appends to `streamingText`
   → UI shows live typing
6. Agentforce fires final `message` event → `classifyMessage()` returns
   `render-answer` → reducer sets `answer` → UI shows the final answer
7. `QuestionPills` filters `lastQuestion` out of its render list → the clicked
   pill drains

**Every arrow in that chain is a boundary we unit-tested** — parser, gate,
tracker, reducer — because the SSE/DOM glue layer in between is the part we
can't test without a browser and a real agent.

---

## 9. Where `c_pdpQuestions` comes from (Commerce Content Studio)

The widget doesn't generate the opener questions — it just renders a list the
host hands it. The list lives on each product as the SCAPI custom attribute
`c_pdpQuestions` (string-array JSON). It's produced by a separate app:

**Commerce Content Studio** (Heroku app, `ba-money-game-69bce417c5e2.herokuapp.com`):

1. **Crawl** — authenticated as a SCAPI/SLAS Shopper client, walks the storefront
   catalog (categories + leaf products) and stores each product's full SCAPI
   JSON locally.
2. **Discovery** — scans the stored JSON for merchant-defined `c_*` custom
   attributes and lets the operator map the useful ones (facets, prose,
   sizing) into the generation prompt.
3. **Generate** — LLM pass per product; emits a best-first ordered array of
   FAQ question strings (plus answers kept server-side for export). The
   generation uses standard SCAPI fields (name, descriptions, brand, category)
   plus whichever custom attributes were mapped in Discovery.
4. **Review & approve** — human-in-the-loop UI; each product is `pending`,
   `approved`, or `needs changes`. Nothing publishes until approved.
5. **Publish (OCAPI write-back)** — a second credential (Account Manager API
   client, not the SCAPI one) mints one OAuth token good for both:
   - **WebDAV PUT** of a catalog-import archive to `/Impex/src/instance`
   - **OCAPI `sfcc-site-archive-import` job** triggered via
     `POST /s/-/dw/data/v23_2/jobs/sfcc-site-archive-import/executions`
   The archive writes a JSON string array into the `pdpQuestions` product
   custom attribute in **MERGE** mode (never deletes), which SCAPI/OCAPI then
   expose as `c_pdpQuestions`. A post-import `GET /products/{id}` read-back
   verifies the attribute landed.
6. **Schedules** — recurring delta sync (crawl → regenerate changed products →
   publish approved) runs unattended; freshly generated FAQs stay `pending`
   until human-approved, so hands-off operation only ever publishes already-
   approved content.

Net effect for the pwa-kit side: the SCAPI Shopper Products response on a PDP
now returns `c_pdpQuestions` as a JSON string array, which
`parsePdpQuestions()` in `app/utils/inline-agent-widget-utils.js` validates,
caps at 5, and hands to the widget as the `pdp-questions` attribute.
