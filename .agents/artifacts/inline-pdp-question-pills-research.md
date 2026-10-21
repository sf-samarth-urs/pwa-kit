# Inline PDP Question Pills — Research + PR Plan

**Owner:** Samarth Urs (CC-Chatty / Shopper & Buyer Agents)
**GUS:** W-24333475 (parent) / **W-24333476 (this PR — PWA Kit)** / W-24333477 (SFRA follow-up)
**Sister track:** Shilpi — SCRT2 Page Context API (unblocks paved-path replacement for the marker HACK)
**Date:** 2026-09-29
**Repos in scope:** `pwa-kit` (`develop`), `inline-agent-widget` (`main`, tag TBD after this cut)

---

## 1. Goal

Show the shopper prepopulated **opener question pills** as soon as they land on a PDP, sourced from the `c_pdpQuestions` custom attribute on the SCAPI product response. Tapping a pill sends that question to the inline agent widget exactly as if the shopper typed it and submitted.

**Phase 2 (later WI, not this PR):** show **follow-up question pills** after each answer.

**Phase 3 (SFRA + SF Next):** replicate the same behavior on `plugin_commerce_client` and SF Next after PWA lands.

---

## 2. What already exists (state of the art)

### 2.1 SCAPI response — the source of truth

`/Users/surs/Documents/c_pdpQuestions.json` (product `500400` "TrailFit Alta") shows the field shape:

```json
"c_pdpQuestions": "[\"What does SmartTrack do?\", \"Does it track sleep automatically?\", \"Tell me about the reminders to move.\", \"Does this track heart rate?\", \"Does this have GPS tracking?\"]"
```

Critical: **it is a JSON‑encoded string, not a JSON array.** The consumer must `JSON.parse(product.c_pdpQuestions)` and defend against non-string / malformed values.

Provenance (from Commerce Content Studio user guide, `/Users/surs/Downloads/Commerce Content Studo - User Guide.pdf`): the Heroku app publishes the `pdpQuestions` custom attribute via OCAPI `sfcc-site-archive-import` in MERGE mode. SCAPI surfaces it as `c_pdpQuestions`. Values are text/string columns holding a serialized JSON array. Delta+publish schedules only write approved products; unapproved FAQs stay `pending`.

### 2.2 Widget internals — `/Users/surs/inline-agent-widget` (branch `main`, HEAD `8a3c303`, PR #13 merged)

- Entry: `src/custom-element.ts` → `<inline-agent-widget>` custom element. Reads attributes → `readConfig()` → `renderInto(shadowRoot, config)`.
- `renderInto` (`src/render.tsx`) mounts `<App config />` inside the Shadow DOM with `styles.css?inline` injected.
- `src/App.tsx`: `WidgetProvider` → header + `<InputBar />` + `<Response />`.
- `src/provider/WidgetProvider.tsx`:
  - `state = { status, answer, streamingText, agentTyping, error, lastQuestion, connectionReady }`.
  - `sendMessage(text)` is the public entry (dispatches `ASK_QUESTION`, warms handshake, sends via SCRT2). Prepends product context via `withProductContext(text, resolveProductId(location, {productIdParam, productIdPattern}))` — this is the **marker HACK** (`"(Viewing product details for inline-widget: <id>)\n\n<text>"`) that `commerce_shopper_agent/byon/agent_node.py:299-309` branches on.
  - `prepareConnection()` is called on first keystroke to warm the SCRT2 handshake behind typing latency.
  - `RESET_CONVERSATION` fires on SPA navigation between PDPs (product-id change detected via `pushState`/`replaceState`/`popstate` hooks).
- `src/components/InputBar.tsx`: textarea + send button. Disabled when `busy || notReady`. Sends via `sendMessage(text)`.
- `src/components/Response.tsx`: renders (a) `state.lastQuestion` as a query bubble, then (b) error, typing indicator, streaming markdown, or final answer.
- `src/styles.css`: has `.slot`, `.query`, `.answer`. **No `.pill` / `.suggestions` class yet.** Theming knobs on `:host` — this PR will add a couple more (`--iaw-pill-*`).
- `src/index.ts`: auto-registers `<inline-agent-widget>` on import; exports `mount`, `defineElement`, and the SDK.

### 2.3 PWA Kit mount — `packages/template-retail-react-app`

- Widget config assembled in `config/default.js:238` from `INLINE_AGENT_WIDGET_COMMERCE_SETTINGS` env (JSON). Fields: `enabled, scrt2Url, orgId, esDeveloperName, placeholder, persistSession, enableLogging`.
- `app/components/inline-agent-widget/index.jsx` — thin React shim: gates on `isConfigured(config)`, injects the UMD via `<Helmet>`, renders a container `<div ref={containerRef} />`.
- `app/hooks/use-inline-agent-widget.js` — `useInlineAgentWidget(config)`:
  - Loads `/static/inline-agent-widget.umd.js`.
  - Waits for `customElements.whenDefined('inline-agent-widget')`.
  - Creates `<inline-agent-widget>` element and copies attrs: `scrt2-url, org-id, es-developer-name, capabilities-version, placeholder, persist-session, enable-logging`.
  - **No product-id attribute today** — the widget derives it from the URL (`/product/<id>` regex) at send time.
- `app/pages/product-detail/index.jsx`:
  - Line 44: imports `InlineAgentWidget`.
  - Line 80: `const inlineAgentWidgetConfig = getConfig()?.app?.inlineAgentWidget`.
  - Line 112: `useProduct({ ...id: urlParams.get('pid') || productId... })` — **`productResponse.c_pdpQuestions` is available here.**
  - Line 810: `<InlineAgentWidget config={inlineAgentWidgetConfig} />` rendered as `actionFooter` prop on `ProductView`.

### 2.4 Deploy shape

- Widget ships as a UMD bundle checked in at `packages/template-retail-react-app/app/static/inline-agent-widget.umd.js` (rebuilt via `chore: rebuild inline agent widget UMD ...` commits from the widget repo, most recently PR #4034 `c27cb1d8`).
- SFRA path (`plugin_commerce_client` cartridge) is separately maintained; it also consumes the same UMD.

---

## 3. Gap analysis

| Gap | Current | Needed |
|---|---|---|
| Widget public API for pill data | none | Accept an ordered list of opener questions (strings) via a new attribute or `mount()` option |
| Rendering | Only input + latest Q/A | New `<QuestionPills>` component above input (or between input and response, TBD in §5.2) |
| Click-to-send | `sendMessage` gated on `notReady`/`busy` | Same gate for pill clicks — reuse `sendMessage` verbatim |
| Dismissal | n/a | Hide pills once first user question is sent; re-appear on `RESET_CONVERSATION` (SPA nav) with the pills for the *new* product |
| PWA Kit plumbing | Widget config is a static site pref | Pass a per-render `pdpQuestions={parseC_pdpQuestions(product.c_pdpQuestions)}` prop through the shim and set it as a widget attribute |
| SCAPI parse | n/a | Defensive `JSON.parse` with `Array.isArray` + string-only filter + max-N cap |
| Themability | 14 CSS vars on `:host` | Add `--iaw-pill-bg`, `--iaw-pill-fg`, `--iaw-pill-border`, `--iaw-pill-hover-bg` |
| Follow-up pills (v2) | n/a | Deferred — needs ICR/agent to emit structured `suggestedFollowUps` alongside the answer (blocked on agent-side WI) |

---

## 4. Design decisions

### 4.1 Passing the pills into the widget — attribute over prop

The widget is a `<inline-agent-widget>` custom element; the PWA React shim only sets attributes. Options:

- **A. String attribute holding JSON** — `pdp-questions='["Q1","Q2",…]'`.
  - **Pro:** matches the existing attribute-only contract (`scrt2-url`, `org-id`, …), no new imperative surface, no `postMessage`, works for SFRA identically.
  - **Con:** JSON round-trip; must budget for size (SCAPI ships ≤ ~5 questions in practice, ~200 B).
- B. `mount()` option — only usable by consumers who imperatively mount, not by the custom-element consumer.
- C. `postMessage` to shadow — new surface, more moving parts.

**Pick A.** Add `pdp-questions` to `observedAttributes`; `readConfig()` parses it defensively; `WidgetProvider` accepts it and holds it in state so it can re-render on attribute change (PDP variant switch, SPA nav).

### 4.2 UX placement

Two candidate placements:

- **Above the input** (opener pills, before shopper types) — matches "opening questions" phrasing and the screenshot Shilpi shared.
- Above the response block (grouped with the Q/A) — less prominent, but composes better with future follow-up pills.

**Pick: above the input, only when `state.lastQuestion === null && state.answer === null && !state.error`.** This gives us "opener pills disappear after first ask" for free using the existing reducer state. When SPA nav fires `RESET_CONVERSATION`, `lastQuestion` and `answer` reset to `null`, so the pills re-appear for the new product — this composes with Shilpi's PDP-nav fix from PR #13.

### 4.3 Follow-up pills (v2, deferred)

Two viable paths, both need agent-side work not in this PR:

- **v2a:** the ICR agent emits a structured trailing block after the answer (e.g., `<!-- suggestedFollowUps: ["Q1","Q2"] -->` in the markdown response, stripped by widget before render, surfaced as pills). Simpler but couples formatting.
- **v2b:** ICR emits a separate SSE event type carrying suggestions; widget listens and dispatches to a new reducer action. Cleaner protocol.

Not in this PR. Recorded here so the reducer/state shape below has a natural extension point.

### 4.4 Product-id/URL context — leave the marker HACK alone

Shilpi's parallel SCRT2 Page Context API replaces the marker HACK with a first-class product-id on the session. This PR **does not touch product-context**: pill click still goes through `sendMessage → withProductContext` and picks up the current URL's product id, same as a typed question. When Shilpi's API lands, the same call path benefits automatically.

---

## 5. PR plan — W-24333476 (PWA Kit + inline-agent-widget)

We ship this as **two PRs** cut together (the UMD PR waits on the widget-repo PR):

1. **PR-A: `inline-agent-widget`** — add `pdp-questions` attribute, render pills, unit tests, publish new UMD.
2. **PR-B: `pwa-kit`** — parse `c_pdpQuestions` on the PDP, pass it through the shim/hook, replace the checked-in UMD with the PR-A build.

### 5.1 PR-A — `SalesforceCommerceCloud/inline-agent-widget`

**Branch:** `feature/pdp-opener-pills`
**Base:** `main` @ `8a3c303`

Edits:

| File | Change |
|---|---|
| `src/custom-element.ts` | Add `"pdp-questions"` to `OBSERVED`; `readConfig()` parses `attr("pdp-questions")` via new helper `parsePdpQuestions(raw?: string): string[]` |
| `src/provider/types.ts` | Extend `WidgetConfig` with `pdpQuestions?: string[]`; add reducer state `pdpQuestions: string[]` + action `SET_PDP_QUESTIONS`; extend `RESET_CONVERSATION` to keep pills (they belong to the product, not the conversation) |
| `src/provider/reducer.ts` | Handle `SET_PDP_QUESTIONS`; ensure `ASK_QUESTION` does **not** clear `pdpQuestions` (we hide via render-time gate, not state clear — cheap re-show on SPA nav) |
| `src/provider/WidgetProvider.tsx` | Effect: when `config.pdpQuestions` changes, dispatch `SET_PDP_QUESTIONS` |
| `src/components/QuestionPills.tsx` | **NEW.** Renders pills; hidden when `state.lastQuestion || state.answer || state.error`. Click → `sendMessage(text)` (respects `notReady`/`busy`). Keyboard: Enter/Space activate |
| `src/App.tsx` | Insert `<QuestionPills />` between `<InputBar />` and `<Response />` |
| `src/styles.css` | New `.pills`, `.pill` selectors; theme vars `--iaw-pill-bg` (default `#fff`), `--iaw-pill-fg` (default `var(--iaw-fg)`), `--iaw-pill-border` (default `var(--iaw-border)`), `--iaw-pill-hover-bg` (default `#f5f5f5`) |
| `tests/provider/pdp-questions.test.ts` | **NEW.** Cover: parse JSON-encoded string, reject non-array / non-string entries, cap at N (say 8), trim whitespace, dedupe |
| `tests/components/question-pills.test.tsx` | **NEW.** Cover: renders N pills, click sends, hidden when `lastQuestion` set, hidden when `notReady`, keyboard access |
| `README.md` | Document the new attribute |

Sketch of `parsePdpQuestions`:

```ts
export function parsePdpQuestions(raw: string | undefined | null, maxCount = 8): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of parsed) {
    if (typeof q !== "string") continue;
    const t = q.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= maxCount) break;
  }
  return out;
}
```

Sketch of `<QuestionPills>` render gate:

```tsx
export function QuestionPills() {
  const { state, sendMessage } = useWidget();
  const hidden = state.lastQuestion !== null || state.answer !== null || state.error !== null;
  if (hidden || state.pdpQuestions.length === 0) return null;
  const disabled = !state.connectionReady;
  return (
    <ul className="pills" aria-label="Suggested questions">
      {state.pdpQuestions.map((q) => (
        <li key={q}>
          <button
            className="pill"
            type="button"
            disabled={disabled}
            onClick={() => { void sendMessage(q); }}
          >
            {q}
          </button>
        </li>
      ))}
    </ul>
  );
}
```

Build/publish (widget repo):
```bash
npm ci
npm run build           # emits dist/inline-agent-widget.umd.js + dist/index.mjs
npm test
```

### 5.2 PR-B — `SalesforceCommerceCloud/pwa-kit`

**Branch:** `feature/inline-pdp-opener-pills`
**Base:** `develop` (currently at `58e6a610`)
**Depends on:** PR-A UMD build committed in.

Edits:

| File | Change |
|---|---|
| `packages/template-retail-react-app/app/pages/product-detail/index.jsx` | Import `parsePdpQuestions` helper; compute `const pdpQuestions = parsePdpQuestions(productResponse?.c_pdpQuestions)`; pass as `<InlineAgentWidget config={inlineAgentWidgetConfig} pdpQuestions={pdpQuestions} />` |
| `packages/template-retail-react-app/app/components/inline-agent-widget/index.jsx` | Accept `pdpQuestions` prop; pass through to `useInlineAgentWidget(config, {pdpQuestions})`; extend `PropTypes` |
| `packages/template-retail-react-app/app/hooks/use-inline-agent-widget.js` | Accept `pdpQuestions`; in the mount effect, `el.setAttribute('pdp-questions', JSON.stringify(pdpQuestions))` when the array is non-empty; add a second effect that updates the attribute on `pdpQuestions` change (SPA nav / variant switch) |
| `packages/template-retail-react-app/app/utils/inline-agent-widget-utils.js` | **NEW.** Home for `parsePdpQuestions` (same defensive parser as widget-side — SSR-safe, no DOM) so the PDP renders pills even before the widget UMD loads (v3 enhancement, listed in §7). For this PR, keep parser inside the same file used only for building the attribute value |
| `packages/template-retail-react-app/app/static/inline-agent-widget.umd.js` | Replace with PR-A build |
| `packages/template-retail-react-app/app/pages/product-detail/index.test.js` | Add case: PDP renders widget with `pdp-questions` attribute when `c_pdpQuestions` is present |
| `packages/template-retail-react-app/CHANGELOG.md` | Note the feature |

Hook update sketch:

```js
useEffect(() => {
    if (!configured || !ready || !containerRef.current) return
    const el = containerRef.current.querySelector('inline-agent-widget')
    if (!el) return
    if (pdpQuestions && pdpQuestions.length > 0) {
        el.setAttribute('pdp-questions', JSON.stringify(pdpQuestions))
    } else {
        el.removeAttribute('pdp-questions')
    }
}, [configured, ready, pdpQuestions])
```

### 5.3 Not doing

- Not changing `withProductContext` / marker-HACK — Shilpi's Page Context API is the paved path.
- Not adding follow-up pills — deferred to a v2 WI once ICR emits suggestions.
- Not touching SFRA (`plugin_commerce_client`) — separate WI (W-24333477), same widget UMD once PR-A merges.
- Not touching FIT tests — pill click enters the same `sendMessage` path already covered by `testInlinePdpDetails*`; adding a `testInlinePdpPillClick` is possible but low value (identical stimulus).

---

## 6. Local test plan (`localhost:3000`)

Prerequisites in `packages/template-retail-react-app/.env`:

```
INLINE_AGENT_WIDGET_COMMERCE_SETTINGS={"enabled":true,"scrt2Url":"<...>","orgId":"<...>","esDeveloperName":"<...>","persistSession":true,"enableLogging":true}
```

Steps:

1. In the widget repo:
   ```bash
   cd /Users/surs/inline-agent-widget
   git checkout -b feature/pdp-opener-pills
   # make edits per §5.1
   npm ci && npm test && npm run build
   ```
2. Copy the UMD to pwa-kit:
   ```bash
   cp /Users/surs/inline-agent-widget/dist/inline-agent-widget.umd.js \
      /Users/surs/pwa-kit/packages/template-retail-react-app/app/static/inline-agent-widget.umd.js
   ```
3. In pwa-kit:
   ```bash
   cd /Users/surs/pwa-kit
   git checkout -b feature/inline-pdp-opener-pills
   # make edits per §5.2
   cd packages/template-retail-react-app && npm run build && npm start
   ```
4. Load a PDP whose SCAPI response includes `c_pdpQuestions` (product `500400` "TrailFit Alta" for NTO Electronics is the reference). Verify:
   - Pills appear above the input, in the order returned by SCAPI.
   - Pills are keyboard-focusable (Tab), submit on Enter/Space.
   - Clicking a pill sets `state.lastQuestion` to the pill text and streams an answer — pills then hide.
   - SPA-navigating to a different PDP (Router-driven, not full reload) clears the answer and re-shows pills for the new product.
   - Full page reload preserves the persisted session (existing behavior); pills re-render from fresh SCAPI response.
   - A product with **no** `c_pdpQuestions` renders no pills, input still works.
   - Malformed `c_pdpQuestions` (e.g., mock an empty string, non-JSON, non-array) → no pills, no console error.
5. Screenshot compare against Shilpi's mocks.

---

## 7. Sandbox / higher-stage rollout

- **Sandbox:** deploy PWA Kit + updated UMD to `nto-electronics` (or the reference storefront), keep same `enabled=true` config. Smoke: opener pills → click → SCRT2 streaming answer.
- **Feature gating (optional):** the widget is already gated by `inlineAgentWidget.enabled`. If we want a separate kill switch for pills without disabling the widget, add `pdpQuestionsEnabled` to the config JSON and gate the parser in the PDP; default **on**. Recommend **not adding a switch** unless SRE asks — the pill code is inert when `c_pdpQuestions` is absent, so it fails closed by data.
- **Metrics:** ask Shilpi's parallel work to wire a `pillClicked` telemetry event on `sendMessage` when the caller marks the message as pill-sourced (deferred; log-only in v1).
- **Rollback:** revert the UMD swap + PDP prop; widget still works without pill data.

---

## 8. Composition with Shilpi's SCRT2 Page Context API

Independent axes:
- **Shilpi:** replaces marker-HACK with a first-class `page_context_data = {product_id}` seeded on session start.
- **This PR:** adds a pill UI + `pdp-questions` attribute. The pill click goes through the same `sendMessage` path, which today uses `withProductContext` and later will use Page Context — no rework needed here.

The two PRs are conflict-free: they touch different files (Shilpi's touch the SDK client + agent; this PR touches provider state + a new component + PDP plumbing).

---

## 9. Follow-up WIs (out of scope for W-24333476)

- **W-24333477 (SFRA):** Update `plugin_commerce_client` cartridge to read `c_pdpQuestions` from the Shopper Products call and set the `pdp-questions` attribute on the widget. Same UMD, no widget changes.
- **W-SF-Next:** replicate on SF Next PDP once storefront route lands.
- **W-follow-up-pills:** ICR agent emits `suggestedFollowUps`; widget renders after each answer using the same `<QuestionPills>` component (parameterized by state slice).
- **W-pill-telemetry:** wire a `sendMessage(text, {source: "pill"})` variant and emit a metric.

---

## 10. Open questions to resolve before cutting PR

1. Max number of pills to render (proposal: 8; SCAPI ships ≤5 today).
2. Pill layout: horizontal wrap vs. vertical stack on mobile. (Proposal: wrap, `flex-wrap: wrap; gap: 8px;` with a fallback to stack < 320 px.)
3. Do we prefetch (`prepareConnection`) on pill hover, like we do on first keystroke? (Proposal: yes — same rationale, hides handshake latency behind hover intent.)
4. Analytics event name (`inline_pdp_pill_click`?) — align with Shilpi + Nayana.
5. Any A11y localization? Pill button aria-label — for now, English only, matches existing widget copy.

Once (1)–(4) are settled, cut PR-A then PR-B. Estimate: ~1 day widget-side + ~½ day pwa-kit-side including test writing.
