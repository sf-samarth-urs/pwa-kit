# Inline PDP Ask Assistant — end-to-end call flow

**Scope** W-24333476 (Opener-Pills) + inline PDP Ask Assistant on PWA Kit (tbdp_prd / NTOManaged).
Covers everything from shopper click on a product tile → pill render → pill click → BYON grounding
→ LLM response streamed back.

**Repos involved** (all local checkouts under `/Users/surs/`):

| Alias | Path | Role |
|---|---|---|
| **pwa-kit** | `/Users/surs/pwa-kit/packages/template-retail-react-app/` | Storefront (SSR + CSR). Reads `c_pdpQuestions` from SCAPI, hosts the inline-widget web component. |
| **inline-agent-widget** | `/Users/surs/inline-agent-widget/` | Framework-agnostic custom element `<inline-agent-widget>`. Owns readiness gate, pill UI, product-context marker, SCRT2 handshake. |
| **commerce-shopper-agent (ICR)** | `/Users/surs/inference-code-runtime-packages/apps/commerce-shopper-agent/` | BYON agent on Hawking ICR. Marker-sniffing, topic override, deterministic product-details prefetch, LLM response. |
| **graph-execution-service-fedx (GES)** | `/Users/surs/graph-execution-service-fedx/` *(not inspected this session)* | SCRT2 → agent orchestrator. Signs the agent response, delegates tool calls to Apex. |

---

## 0. Config & env — what the two sides are actually pointing at

**pwa-kit** `packages/template-retail-react-app/config/default.js:171-189`:
```js
commerceAPI: {
    proxyPath: '/mobify/proxy/api',
    parameters: {
        clientId: 'af919544-30a2-4c65-9564-2db56fc80fc3',
        organizationId: 'f_ecom_tbdp_prd',
        shortCode: 'sandbox-001',
        siteId: 'NTOManaged'
    }
}
```

`packages/template-retail-react-app/.env`:
```
INLINE_AGENT_WIDGET_COMMERCE_SETTINGS='{
  "enabled": true,
  "scrt2Url": "https://q3sdb60111062025mp1.test1.my.pc-rnd.salesforce-scrt.com",
  "orgId":   "00Dfi800001CByP",
  "esDeveloperName": "BYONCommerceClientAPI",
  "persistSession": true,
  "enableLogging": false
}'
```

**ICR agent** — nto_agent_script.yaml wires `GetB2CProductDetails`:
```
siteId: "NTOManaged"
userLocale: "en-US"
shopperApiNamedCredential: "NTOManaged"
```
Resolves via SCAPI token endpoint:
```
https://sandbox-001.api.commercecloud.salesforce.com/shopper/auth/v1/organizations/f_ecom_tbdp_prd/oauth2/token
```

So three independent components all agree on `(tbdp_prd, NTOManaged, sandbox-001)` end-to-end.

---

## 1. Shopper lands on PDP — SSR + CSR hydration

**URL** `http://localhost:3000/us/en-US/product/500400`

### 1a. SSR (Node → first HTML)

`packages/template-retail-react-app/app/pages/product-detail/index.jsx`:

- **`ProductDetail.getProps`** (SSR + initial CSR) prefetches:
  - `useProduct(productId, { expand: 'availability,promotions,options,images,prices,variations,set_products,bundled_products,page_meta_tags' })`
  - `useCategory(primaryCategoryId)` (dependent, after product resolves)
- Response is embedded as `__PRELOADED_STATE__` in the HTML.
- `productResponse.c_pdpQuestions` is a stringified JSON array
  (e.g. `'["Will these stay in during exercise?", "How is the fit?", …]'`) — set by Content Studio
  publish to the `pdpQuestions` BM custom attribute on the product.

### 1b. CSR hydration

- React hydrates. `useProduct` is backed by `commerce-sdk-react`'s TanStack `useQuery` wrapper, so
  the prefetched preloaded state is served synchronously — no refetch.
- `product-detail/index.jsx:814`:
  ```jsx
  <InlineAgentWidget pdpQuestions={parsePdpQuestions(productResponse?.c_pdpQuestions)} />
  ```
- `parsePdpQuestions` (`app/utils/inline-agent-widget-utils.js`) is SSR-safe: tolerates string,
  array, or null; drops non-strings; caps at 5. Graceful parse-fail returns `[]` so the UI never
  throws on malformed data.

### 1c. Widget mount — `app/hooks/use-inline-agent-widget.js`

Two useEffects, both run after hydration:

1. **Load the UMD bundle once per page** (`ensureWidget`):
   - Checks `customElements.get('inline-agent-widget')` — if defined, resolves.
   - Else injects `<script src="/static/inline-agent-widget.umd.js" async>` and awaits
     `customElements.whenDefined('inline-agent-widget')`.
   - A module-level `readyPromise` memoizes so SPA-navs between PDPs do not re-inject.

2. **Create the `<inline-agent-widget>` element and seed attributes:**
   ```html
   <inline-agent-widget
     scrt2-url="https://q3sdb60111062025mp1.…"
     org-id="00Dfi800001CByP"
     es-developer-name="BYONCommerceClientAPI"
     capabilities-version="…"
     persist-session
     pdp-questions='["Will these stay in during exercise?", …]'
   />
   ```
   - `pdp-questions` is seeded at create time so the pills paint in the same frame — no
     visible pop-in.

3. **Attribute-sync effect** keeps `pdp-questions` in sync with `JSON.stringify(questionsKey)` as
   the host swaps products (variant change, SPA-nav). The element stays mounted across these so
   the SCRT2 session is preserved — only the attribute changes.

**At the end of 1c:** DOM has the widget, SCRT2 is NOT yet contacted, pills are visible,
`connectionReady: true` (initial state).

---

## 2. Widget bootstrap — `inline-agent-widget` custom element

### 2a. Custom-element → React render

`inline-agent-widget/src/custom-element.ts` → `mount.ts` → `render.tsx` → `WidgetProvider` wrapping
`<InputBar/>`, `<QuestionPills/>`, `<Response/>`.

Attribute parsing:
- `pdp-questions` → `JSON.parse` → `string[]` → `config.pdpQuestions`.
- Everything else → config fields consumed by `WidgetProvider`.

### 2b. WidgetProvider mount effect
`inline-agent-widget/src/provider/WidgetProvider.tsx:122-296`

Idempotent setup fires on first mount (and never again unless a connection-defining attribute
changes):

1. Build `AgentforceClient` (`new AgentforceClient({ baseURL: scrt2Url, orgId, esDeveloperName })`).
   **No network yet.** The client is lazy.
2. Reset `hasUserSentRef = false`, `welcomePendingRef = false`, `connectPromiseRef = null`.
3. Build session-persistence adapter (localStorage, keyed by `orgId + esDeveloperName`).
4. Register SSE handlers for `connected`, `disconnected`, `reconnecting`, `typing_started`,
   `typing_stopped`, `streaming_token`, `message`, `error`.
5. The `message` and `streaming_token` handlers are **gated on `hasUserSentRef.current`** —
   anything the agent emits before the user sends is dropped. This is how the auto-welcome
   greeting is swallowed.

**Current state at the end of 2b:**
```
connectionReady: true        ← initial state (reducer.ts:11)
hasUserSentRef:  false       ← no user send yet
welcomePendingRef: false     ← no handshake in flight
```

Pills visible AND clickable. Send button enabled (but input is empty, so still disabled by
`text.trim().length === 0`).

---

## 3. Pill render + hover warm-up (optional, cost-hiding)

### 3a. Pill render — `inline-agent-widget/src/components/QuestionPills.tsx`

Gate for whether to show pills at all:
```ts
const hasEngaged =
  state.lastQuestion !== null ||
  state.answer !== null ||
  state.streamingText.length > 0 ||
  state.agentTyping ||
  state.error !== null;
if (hasEngaged || state.pdpQuestions.length === 0) return null;
```

Pills ride through from `config.pdpQuestions` → `pdpQuestionsKey` effect → `SET_PDP_QUESTIONS`
dispatch → `state.pdpQuestions`.

Each pill button:
```tsx
<button
  disabled={!state.connectionReady}
  onClick={() => void sendMessage(q)}
  onMouseEnter={prepareConnection}   // ← warm-up on hover
  onFocus={prepareConnection}        // ← warm-up on keyboard focus
>
  {q}
</button>
```

### 3b. `prepareConnection` — hidden handshake under user intent

`WidgetProvider.tsx:306-329`

```
prepareConnection()
  └─ ensureConnected(client, connectPromiseRef, onHandshakeStart, persistence)
        ├─ onHandshakeStart() dispatches:
        │     SET_STATUS: "connecting"
        │     SET_CONNECTION_READY: false       ← pills + send button go DISABLED
        │     welcomePendingRef = true
        │     welcomeTimeoutRef = setTimeout(ready=true, 5000ms)
        │
        ├─ persistence.tryRestore()
        │     ├─ loadSession(sessionKey)
        │     ├─ if hit → client.restore({ accessToken, conversationId, lastEventId })
        │     │        → SSE re-opens on existing conversation (no new welcome)
        │     │        → SET_CONNECTION_READY: true   ← fast path (~200ms)
        │     └─ if miss → fall through to fresh handshake
        │
        └─ fresh handshake:
              ├─ POST {scrt2Url}/token
              │     body: { orgId, esDeveloperName, deviceId, authorizationType: "User" }
              │     resp: { accessToken, lastEventId }   (~150-400ms)
              │
              ├─ Open EventSource at {scrt2Url}/sse?orgId=…&accessToken=…
              │     awaits "connected" SSE event      (~50-150ms)
              │
              └─ POST {scrt2Url}/conversation
                    body: { conversationId: uuid(), routingAttributes }
                    agent-side auto-emits welcome Chatbot message over SSE
                    (~200-400ms)
```

**When the welcome Chatbot message arrives** — `WidgetProvider.tsx:235-258`:
```ts
client.on("message", (e) => {
  const isChatbot = e.sender.role !== "EndUser";
  if (!hasUserSentRef.current) {
    if (welcomePendingRef.current && isChatbot) {
      welcomePendingRef.current = false;
      clearTimeout(welcomeTimeoutRef.current);
      dispatch({ type: "SET_CONNECTION_READY", ready: true });  // ← gate reopens
    }
    return;  // ← welcome is DROPPED, not rendered
  }
  // ...
});
```

Safety timeout: if welcome never arrives, gate reopens after 5s so the UI isn't stuck.

### 3c. What the user sees

| T (ms, example) | Visual |
|---|---|
| 0    | PDP renders, pills visible, pills clickable |
| 50   | User moves mouse near a pill → `onMouseEnter` fires |
| 51   | `connectionReady: false` → pills + send briefly dim |
| 450  | SSE `connected` + welcome message arrive → `connectionReady: true` |
| 500  | Pills back to clickable |
| 700  | User clicks pill |
| 701+ | `sendMessage` dispatches `ASK_QUESTION` → UI shows the user's bubble immediately |

That 50-500ms dim window is the "few SSE events before I could click" the user noticed. By design.

---

## 4. User clicks pill → sendMessage

`QuestionPills.tsx:36` → `WidgetProvider.sendMessage(q)` — `WidgetProvider.tsx:331-411`.

```
sendMessage("Will these stay in during exercise?")
  ├─ dispatch ASK_QUESTION, question: trimmed
  │     Reducer:
  │       lastQuestion ← trimmed
  │       answer       ← null
  │       streamingText ← ""
  │       error        ← null
  │     (Response.tsx renders the "query bubble" immediately —
  │      lastQuestion is sufficient for `hasActivity`)
  │
  ├─ messageBody = withProductContext(trimmed, productId)
  │     productId extracted from URL via productIdPattern or productIdParam config
  │     (e.g. productId "500400" from path `/product/500400`)
  │     messageBody =
  │       "(Viewing product details for inline-widget: 500400)\n\nWill these stay in during exercise?"
  │
  ├─ ensureConnected() — idempotent, short-circuits since conversation now exists
  │
  ├─ POST {scrt2Url}/messages
  │     Authorization: Bearer <accessToken>
  │     body: {
  │       message: {
  │         id: "<uuid>",
  │         messageType: "StaticContentMessage",
  │         staticContent: { formatType: "Text", text: messageBody }
  │       },
  │       esDeveloperName: "BYONCommerceClientAPI"
  │     }
  │     ← This is the exact payload you saw in DevTools.
  │
  ├─ hasUserSentRef.current = true   ← SSE handlers un-gate
  └─ persistence.save()
```

---

## 5. Server-side — SCRT2 → ICR → BYON → LLM

### 5a. SCRT2 → ICR routing

SCRT2 receives the `/messages` POST, routes to the agent runtime (ICR / Hawking). The agent is
registered under `esDeveloperName: BYONCommerceClientAPI` → selects the correct bundle.

### 5b. ICR agent entry — `commerce_shopper_agent/byon/agent_node.py`

```python
# agent_node.py:266-278  (commit d03acd9)
if not is_resume and topic != "shopper_agent_inline_pdp":
    last_msg = _get_last_user_message(request)
    if last_msg and "Viewing product details for inline-widget:" in last_msg:
        topic = "shopper_agent_inline_pdp"       # ← topic OVERRIDE
```

Topic override pulls in the concise inline-PDP config:
- Template: `prompts/templates/pdp_response.md.j2`
- Word budget: 80
- No `<suggestions>` component
- Tool allowlist: deterministic PDP prefetch only, no agent-side search

### 5c. Build initial graph input — `commerce_shopper_agent/byon/node_helpers.py:591-618`

Regex extracts product id from the marker:
```python
re.search(r"\(Viewing product details for.*?:\s*(.+?)\)", last_user_msg)
# → "500400"
current_page_context = PageContext.from_product_id("pdp", "500400")
```

The OR-check in commit `2969764` means this fires whenever the inline-widget marker is present —
even if `page_context_type` isn't declared in state_variables (which it isn't on PWA Kit).

### 5d. PopulateContextNode — `commerce_shopper_agent/graph/nodes/populate_context.py`

Reads `ctx.requires_fetch == True`, calls `ctx._pdp_invocations(tools, config)`:
```python
# page_context.py:551-598
return [PendingToolCall(
    tool_name="…GetB2CProductDetails",
    tool_args={"productIds": "500400"},
)]
```

Checks the session-scoped `ToolResultsStore` first (keyed by `x-external-session-id`):
- **Cache hit** (second+ turn on same product in same session): payload served from Redis,
  no interrupt. ~5ms.
- **Cache miss** (first turn): LangGraph `interrupt()` round-trips to Apex via the standard
  invocable action pipeline. ~200-500ms.

### 5e. Apex action → SCAPI → tbdp_prd

Agent-script wiring — `commerce_shopper_agent/configs/agent_script/nto_agent_script.yaml:443-540`:

```yaml
GetB2CProductDetails:
    source: "CommerceGuidedShoppingB2C__GetB2CProductDetails"
    target: "standardInvocableAction://b2cProductDetailsAction"
    inputs:
        orgId: string                      # bound from @variables
        siteId: "NTOManaged"
        userLocale: "en-US"
        shopperApiNamedCredential: "NTOManaged"
        authToken: string                  # bound from @variables
        productIds: string                 # from pending tool call
    outputs:
        b2cProductDetailsActionResult: object
```

Apex action calls SCAPI through the `NTOManaged` named credential:
```
GET https://sandbox-001.api.commercecloud.salesforce.com
      /product/shopper-products/v1/organizations/f_ecom_tbdp_prd
      /products/500400?siteId=nto&expand=…
Authorization: Bearer <SLAS shopper token>
```

Returns the full product record: name, descriptions, variants, images, prices, categories,
`c_*` custom attrs.

### 5f. Context rendering — `commerce_shopper_agent/graph/page_context.py:510-522`

```
This is the product details page the user is currently looking at

<pretty-printed JSON of the b2cProductDetailsActionResult>
```

Rendered copy is injected into the LLM chat history BEFORE the user utterance.

### 5g. ReactDecide → LLM — `commerce_shopper_agent/graph/nodes/react_decide.py`

Builds the final messages:

| Role | Content |
|---|---|
| system | pdp_response.md.j2 → "Your final response is **short Markdown prose** — nothing else." + rules (80-word budget, bold key fact, no suggestions, stay on product, confident facts from the record given) |
| user | "This is the product details page …" + product JSON |
| user | "(Viewing product details for inline-widget: 500400)\n\nWill these stay in during exercise?" |

Model: `OpenAIGPT41` by default (per commit `6c70dc3`, overrideable via Gater config).
Streaming on.

### 5h. Response streams back through SSE

Agent streams token-by-token through SCRT2 → EventSource on the widget client:

```
event: streaming_token    → APPEND_STREAMING_TOKEN  → <Response> renders live text
event: streaming_token    → APPEND_STREAMING_TOKEN
...
event: message            → SET_ANSWER             → <Response> replaces with final text
                                                    agentTyping = false
                                                    streamingText = ""
```

`SET_ANSWER` runs `extractMessageText(action.content)` which unwraps a BYON `{response:[…]}`
envelope if present, so the UI renders Markdown, not JSON.

---

## 6. Steady state after one answer

`<Response>` shows the final Markdown. `<QuestionPills>` is hidden by its `hasEngaged` check
(`lastQuestion` and `answer` are both set). Send button is re-enabled (`connectionReady: true`,
`busy: false`).

### 6a. User asks another question

- Typed input or (if `hasEngaged` were reset) another pill — same `sendMessage` path.
- `ensureConnected` short-circuits (conversation exists).
- `GetB2CProductDetails` for the same product id → `ToolResultsStore` cache hit → no second SCAPI
  call. ~5ms grounding, straight to LLM.

### 6b. SPA-nav to another PDP

- `WidgetProvider.tsx:92-115` monkey-patches `history.pushState`/`replaceState` + listens to
  `popstate` → detects product-id change → dispatches `RESET_CONVERSATION`.
- Reducer clears `lastQuestion`, `answer`, `streamingText`, `error`. Pills reappear.
- The host's `pdp-questions` attribute is swapped by the pwa-kit attribute-sync effect
  (`use-inline-agent-widget.js:98-108`) → `SET_PDP_QUESTIONS` → new pill list.
- SSE session is NOT torn down; the SCRT2 conversation persists across SPA navs.

### 6c. Full page reload

- `persistSession: true` saved `{ accessToken, conversationId, lastEventId }` to localStorage
  keyed by `orgId:esDeveloperName`.
- On next mount, `persistence.tryRestore()` picks it up → `client.restore()` → SSE re-opens on
  the EXISTING conversation (no new welcome message, no new token). ~200ms.
- `SET_CONNECTION_READY: true` immediately (fast-path at line 183).

---

## 7. Error paths (what triggers which toast)

| Trigger | Code | UI |
|---|---|---|
| `/token` 4xx/5xx | `sendMessage` catch → `SET_ERROR` | "Something went wrong. Please try again." (period, from WidgetProvider.tsx:271) rendered inside `<Response>` as `<p class="error">` |
| SSE `error` with `recoverable: false` | reducer | Same error line, session cleared |
| SSE `error` with `code: SESSION_EXPIRED` | reducer | Session wiped, gate re-opened, no error toast |
| Message > 4000 chars | sendMessage early-return | "Message exceeds the maximum length of 4,000 characters." |
| Network/timeout mid-send | ensureConnected catch, retry once | On retry fail: same generic error |

**Not from this widget**: the red "Something went wrong. Try again." (period variant) seen earlier
on the FLOATING Commerce Client. That lives in `app/components/shopper-agent/index.jsx:47-50`
(`SESSION_INIT_ERROR_MESSAGE`) and fires during the auth-link / token-bridge handshake — a
separate component. Disabled in dev via `COMMERCE_AGENT_SETTINGS: { enabled: "false" }`.

---

## 8. Readiness-gate guarantees (what the two PRs did NOT weaken)

| Property | Enforced by | PR-A touched? | PR-B touched? |
|---|---|---|---|
| Send button disabled until SCRT2 handshake done | `InputBar.tsx:17, 64` reading `state.connectionReady` | no | no |
| Pill click disabled until handshake done | `QuestionPills.tsx:26, 35` reading `state.connectionReady` | **added** (same signal) | no |
| Agent welcome message dropped before first user send | `WidgetProvider.tsx:235-258` gated on `hasUserSentRef` | no | no |
| Handshake short-circuited for existing conversation | `ensureConnected` + `connectPromiseRef` memoization | no | no |
| Session restored across full-page reload | `persistence.tryRestore()` → `client.restore()` | no | no |
| 5s safety timeout re-opens gate if welcome never comes | `WidgetProvider.tsx:311-314` | no | no |

**PR-A** added `QuestionPills.tsx`. The only new interactions are reading `connectionReady`
(same signal the send button reads) and calling `prepareConnection` on hover/focus (same warm-up
`InputBar.onChange` already does on first keystroke). No new state writer, no new SDK call shape.

**PR-B** touched only pwa-kit host code — `use-inline-agent-widget.js` attribute wiring and
`parsePdpQuestions` utility. Zero paths cross into the widget's connection state machine.

---

## 9. Latency inventory (first-shot vs steady-state)

| Hop | First shot on PDP | Subsequent shot, same session, same product |
|---|---|---|
| SSR render + hydrate | 150-300ms | n/a (same page) |
| UMD bundle load | 50-200ms (cached after) | 0 |
| Pill render | <5ms | <5ms |
| SCRT2 `/token` | 150-400ms | 0 (reused) |
| SSE `connected` | 50-150ms | 0 (persisted stream) |
| `createConversation` + welcome drop | 200-400ms | 0 (persisted conversation) |
| `/messages` POST | 50-100ms | 50-100ms |
| ICR routing + topic override | <5ms | <5ms |
| `GetB2CProductDetails` → Apex → SCAPI | 200-500ms | ~5ms (ToolResultsStore cache hit) |
| LLM round-trip (80-word budget) | 1000-2500ms streaming | 1000-2500ms streaming |
| **Total "pill-click → first visible token"** | **~1.5-3s** | **~1.1-2.6s** |

Levers (none require PWA Kit changes):
- Smaller/faster model for `shopper_agent_inline_pdp` topic (Gater config).
- Trim `GetB2CProductDetails` output (Apex action config — fewer fields = less prompt).
- Lower `max_tokens` ceiling on the LLM call (ICR config).

---

## 10. Full ASCII call diagram

```
┌─────────────┐  GET /us/en-US/product/500400
│   Shopper   │ ───────────────────────────────────────────────────────────┐
└─────────────┘                                                            │
                                                                           ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ pwa-kit SSR (template-retail-react-app)                                      │
│   useProduct('500400', expand=all) ──POST──> SCAPI /product/shopper-products │
│       └─ productResponse.c_pdpQuestions = '["Will these stay…", …]'          │
│   render(<InlineAgentWidget pdpQuestions={parsePdpQuestions(...)} />)        │
└──────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼ HTML + __PRELOADED_STATE__
┌──────────────────────────────────────────────────────────────────────────────┐
│ Browser hydration                                                            │
│   use-inline-agent-widget.js:                                                │
│     ensureWidget() → <script src="/static/inline-agent-widget.umd.js">       │
│     <inline-agent-widget scrt2-url=… org-id=… es-developer-name=…            │
│                          pdp-questions='[…]' persist-session />              │
└──────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼ custom-element connected
┌──────────────────────────────────────────────────────────────────────────────┐
│ inline-agent-widget mount (WidgetProvider)                                   │
│   new AgentforceClient({ baseURL: scrt2Url, orgId, esDeveloperName })        │
│   register SSE handlers (gated on hasUserSentRef)                            │
│   dispatch SET_PDP_QUESTIONS(questions)                                      │
│   connectionReady=true, hasUserSentRef=false                                 │
│   <QuestionPills> renders 5 pills, enabled                                   │
└──────────────────────────────────────────────────────────────────────────────┘
                                      │
                   user hovers pill   │
                                      ▼
                        prepareConnection() → ensureConnected()
                                      │
                   SET_CONNECTION_READY=false (pills + send disabled)
                                      │
          ┌───────────────────────────┼─────────────────────────────┐
          ▼                                                          ▼
   persistence.tryRestore()                                 fresh handshake
          │                                                          │
          │ hit → client.restore(…)        miss                       │
          │ → SET_CONNECTION_READY=true    ─────────────────────────► POST {scrt2}/token
          │   (fast-path ~200ms)                                     │  → accessToken
          │                                                          │
          │                                               open EventSource /sse
          │                                                          │  "connected"
          │                                                          ▼
          │                                              POST {scrt2}/conversation
          │                                                          │
          │                                        agent-side welcome Chatbot msg
          │                                                          │  (SSE)
          │                                              handler: welcomePending=true
          │                                              + !hasUserSent → drop,
          │                                              SET_CONNECTION_READY=true
          └──────────────────────────────┬───────────────────────────┘
                                         ▼
                        pills + send button clickable again
                                         │
                            user clicks pill
                                         ▼
   sendMessage("Will these stay in during exercise?")
      ├─ dispatch ASK_QUESTION → UI shows user bubble
      ├─ withProductContext() → "(Viewing product details for inline-widget: 500400)\n\n…"
      ├─ ensureConnected() short-circuits (conversation exists)
      ├─ POST {scrt2}/messages { StaticContentMessage, esDeveloperName }
      └─ hasUserSentRef = true, persistence.save()
                                         │
                                         ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ SCRT2 → ICR (Hawking)                                                        │
│   routes by esDeveloperName → BYONCommerceClientAPI bundle                   │
└──────────────────────────────────────────────────────────────────────────────┘
                                         │
                                         ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ commerce-shopper-agent (ICR BYON)                                            │
│   agent_node.py: marker → topic = "shopper_agent_inline_pdp"                 │
│   node_helpers.py: regex → PageContext.from_product_id("pdp", "500400")      │
│   PopulateContextNode:                                                       │
│     if cache miss →  interrupt() → GetB2CProductDetails(productIds="500400") │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
                                         │
                                         ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Apex standard invocable action → SCAPI via NTOManaged named credential       │
│   GET sandbox-001.api…/product/shopper-products/v1/organizations/            │
│         f_ecom_tbdp_prd/products/500400?siteId=nto&expand=…                  │
└──────────────────────────────────────────────────────────────────────────────┘
                                         │
                                         ▼ product record JSON
                        store in ToolResultsStore (session-scoped)
                                         │
                                         ▼
                        page_context.render() →
                           "This is the product details page …" + JSON
                                         │
                                         ▼
                        react_decide → LLM (OpenAIGPT41)
                           system = pdp_response.md.j2 (80 words, bold, confident)
                           user   = product JSON
                           user   = user utterance
                                         │
                                         ▼ streaming
                        SSE: streaming_token, streaming_token, …, message
                                         │
                                         ▼
                        <Response> renders live Markdown, then final answer
```

---

## 11. Session memory diff — what changed in this cleanup

- `config/default.js:183-189` — Einstein `einsteinId` blanked; `siteId` moved to NTOManaged.
- `app/ssr.js:233` — `hybridProxy.sfccOrigin` moved from `zzrf-001` → `sandbox-001` (dormant).
- `.env` — `COMMERCE_AGENT_SETTINGS.enabled` flipped to `"false"` to kill the floating Commerce
  Client (clears the red toast + SFRA tile links). Inline PDP widget untouched.

Everything else stale-looking in the tree (`app/mocks/*`, `*.test.*`, `*.mock.*`, `test-utils.js`)
is captured fixture data from the RefArch training site and should NOT be changed.
