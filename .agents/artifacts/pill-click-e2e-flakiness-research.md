# Pill-click → agent reply: end-to-end flakiness research

**Scope**: W-24333476 opener-pills work — three open PRs (`inline-agent-widget#14`, `pwa-kit#4040`, `plugin_commerce_client#71`). Observed on **localhost** PWA Kit dev server:

- Red fallback banner `"Something went wrong. Please try again."` appears, but the DevTools **Network tab shows no failing request** (the POST `.../conversation/{id}/message` returns 2xx).
- Same question (`"What valve types does this fit?"`) sometimes returns a grounded catalog answer, sometimes a hedged "product details not provided" answer.
- User asks: is this a regression we introduced, is it localhost-only, and why don't we see the error on the wire?

Verdict in one line: **the error banner is driven by SSE-stream events (not HTTP responses), the answer-quality drift is server-side (Agentforce planner / RAG retrieval), and neither is a regression introduced by the opener-pills PR.**

---

## TL;DR

1. **Why no network error for the red banner.** The widget's error banner is driven by **three paths that don't show up as failed network calls in the browser Network tab**: (a) SDK-emitted `error` events parsed out of a **2xx SSE stream** (`client.on("error", …)` → `SET_ERROR`); (b) a dropped-and-reconnected SSE stream whose message the welcome-suppression gate silently swallows (no banner, just no answer — the banner then comes from a *subsequent* retry); (c) the `sendMessage` **retry-with-fresh-session** branch, whose first attempt failed on SSE close *after* the POST, so the POST you see in Network is 2xx while the perceived operation failed. See `WidgetProvider.tsx:271` and `WidgetProvider.tsx:395` for the two `SET_ERROR` call sites.
2. **Not a regression from the pills PR.** Pills call the exact same `sendMessage(q)` the input bar does (`QuestionPills.tsx:62` vs. `InputBar.tsx:27,37`). The pills PR added **no code** to `sendMessage`, `ensureConnected`, `SSEReader`, or the SDK error-emit paths. If text input would hit the same banner, pills will too — but the trigger is pre-existing.
3. **Hedged vs grounded answers = server-side.** The widget sends an identical body each time (`"(Viewing product details for inline-widget: 5123162)\n\nWhat valve types does this fit?"`). The variance is in the Agentforce planner / Reasoner / RAG retrieval. Debug there, not in the widget.
4. **Localhost vs remote.** The handshake talks to real SCRT2 either way; behavior is *supposed* to be identical. In practice localhost makes two things worse: (a) the retail-react-app dev server stresses the laptop (SSR + webpack + Vite rebuilds), which lengthens GC pauses and makes the SSE reconnect-timer path more reachable; (b) **stale UMD** (dev forgot to rebuild `inline-agent-widget.umd.js`) is only possible on localhost, and the symptom is "code behaves differently than source says."
5. **Fastest path to a definitive answer**: flip on `enableLogging` in `config/default.js`, filter Network tab by `eventrouter/v1/sse`, and watch for `[Agentforce] sendMessage failed` / `[Agentforce] retry also failed` / `SESSION_EXPIRED` / `MAX_RECONNECT` in the console. See §7 ("What to watch during the next pill click").

---

## 1. End-to-end request trace (pill click → UI update)

### 1a. The click → `sendMessage`

```
user clicks pill
  → <QuestionPills> onClick                                           [QuestionPills.tsx:61]
  → sendMessage(q)                                                    [QuestionPills.tsx:62]
  → WidgetProvider.sendMessage(text)                                  [WidgetProvider.tsx:331]
      • dispatch(ASK_QUESTION)                                        [WidgetProvider.tsx:343]
      • compose body: withProductContext(trimmed, resolveProductId(…))[WidgetProvider.tsx:345-351]
      • connectAndSend():
          • ensureConnected(client, holder, onHandshakeStart, …)      [ensure-connected.ts:75]
              • if conversationId exists → no-op (fast path)
              • else:
                  • persistence.tryRestore() if persistSession=true   [ensure-connected.ts:100]
                     • localStorage read → client.restore()
                       → openSSE() on stored token/conversationId     [client.ts:160]
                  • else: client.connect() → fetchAccessToken → openSSE    [client.ts:134-144]
                  •       client.createConversation()                 [client.ts:238]
          • client.sendMessage(messageBody)                           [client.ts:260]
              • POST /iamessage/api/v2/conversation/{id}/message      [client.ts:280]
              • on non-400 err: tear down session, throw              [client.ts:289-297]
      • catch firstErr → maybe retry with fresh session               [WidgetProvider.tsx:369-399]
      • persistenceRef.current?.save()                                [WidgetProvider.tsx:404]
      • hasUserSentRef.current = true                                 [WidgetProvider.tsx:408]
```

### 1b. The reply → UI

The reply does **NOT** come back on the POST. The POST returns a 2xx envelope `{}`. The actual answer arrives as **server-sent events** over the long-lived GET to `/eventrouter/v1/sse` that was opened during `openSSE()`:

```
SSE stream (keep-alive since the handshake)
  → SSEReader.readStream                                              [sse.ts:91]
  → parseFrame → onEvent(eventType, data)                             [sse.ts:138,159]
  → AgentforceClient.handleSSEEvent                                   [client.ts:453]
      • CONVERSATION_TYPING_STARTED_INDICATOR → emit "typing_started" [client.ts:473]
      • CONVERSATION_STREAMING_TOKEN         → emit "streaming_token" [client.ts:470]
      • CONVERSATION_MESSAGE                 → emit "message"         [client.ts:467]
      • CONVERSATION_TYPING_STOPPED_INDICATOR → emit "typing_stopped" [client.ts:476]
  → WidgetProvider's client.on("message", …) → SET_ANSWER             [WidgetProvider.tsx:235-258]
  → <Response>/<Markdown> renders the final text
```

**Critical observation for the "no network error" question**: everything after the POST happens on an **already-open 2xx GET** (`eventrouter/v1/sse`). Any failure during the reply phase shows up in the Network tab as a *successful* GET that silently closed early (or as nothing at all if the client-side error path kicked in via a parse / timeout). The Network tab's status column stays green.

---

## 2. Issue 1 — "Something went wrong" with no network error

There are **exactly two** `SET_ERROR` call sites in `WidgetProvider.tsx`. Both are reachable without a visible failed request. Ranked most-likely-first for the user's symptom:

### 2.1 ⚠ Most likely — SDK-emitted `error` event from the SSE path or reconnect loop  
`WidgetProvider.tsx:271`:
```ts
client.on("error", (e) => {
  if (e.code === "SESSION_EXPIRED") {
    …                                             // reset + ready, NO banner
    return;
  }
  dispatch({ type: "SET_ERROR", error: "Something went wrong. Please try again." });
  if (e.recoverable === false) clearSession(sessionKey);
});
```

Who emits `client.on("error", …)` with a code OTHER than `SESSION_EXPIRED`? Just one place today:

- `AgentforceClient.attemptReconnect()` after `maxReconnectAttempts` is exhausted — emits
  `{ code: "MAX_RECONNECT", message: "Failed to reconnect after 5 attempts", recoverable: false }`
  (`client.ts:370-376`). **This fires strictly from the SSE path**, so you'd never see a corresponding failed request in the Network tab's main view. The reconnect probe `fetch`es `/eventrouter/v1/sse` under the hood; if those GETs fail silently (connection closed, 503, abort) with a 5-attempt budget, the final event is a React `SET_ERROR` with no accompanying POST failure visible.
  - Default budget: `maxReconnectAttempts = 5`, `reconnectDelay = 2000ms`, capped at 30s with jitter (`client.ts:78-79, 381-384`). Five back-off waves ≈ 2s/4s/8s/16s/30s ≈ **~60s** before the banner.

- There is also a reconnect-side `SESSION_EXPIRED` emission at `client.ts:429-434` for the specific case of a 401 on reopen. That branch takes the recovery path (ready=true, no banner).

**Why it doesn't show in Network tab**:
- The initial POST to `/.../message` returned **2xx**. The *delivery* of the agent reply then happens on the long-lived GET to `/eventrouter/v1/sse`, which is a `fetch`+`ReadableStream` pipe (`sse.ts:46-54`). If the stream dies mid-flight, the Network row for that GET either stays "pending" or quietly ends — never red.
- The reconnect probes are additional GETs to `/eventrouter/v1/sse`. If you filter the Network tab by `eventrouter`, you WILL see multiple attempts; without that filter they're invisible among the frames.

### 2.2 ⚠ Also likely — `connectAndSend` retried once and the retry also failed  
`WidgetProvider.tsx:395`:
```ts
try {
  await connectAndSend();   // retry with fresh session
} catch (retryErr) {
  …
  dispatch({ type: "SET_ERROR", error: toUserMessage(retryErr) });
  dispatch({ type: "SET_STATUS", status: "disconnected" });
  return false;
}
```

This path is taken when the **first** `connectAndSend` threw anything other than `AgentforceApiError(400)` (`WidgetProvider.tsx:371-378`). The SDK's `sendMessage` tears the session down on **any non-400 error** including network timeouts, 5xx, and 401/403 (`client.ts:289-297`). The retry mints a fresh token + conversation and tries again. If that *also* fails, you get the banner.

**Why you may not see a failed network request** for this path:
- If the first failure was a `TypeError` from `fetch` (classic "net::ERR_FAILED" or CORS surprise during a hot-reload), the browser logs it in the console as a CORS/network error but **Chrome's Network tab filter for `message` may show the request as succeeded** if a prior response landed before the stream was severed.
- If both attempts failed at different URLs (first at `/message`, second at `/access-token`), the retry's `/access-token` call *will* show in Network. Look for it under `authorization/unauthenticated/access-token`.
- Transient 5xx from SCRT2 **will** show in Network, but they're easy to miss on localhost where the dev console is covered by HMR output.

**Known amplifier**: Vite / webpack dev-server hot reloads interrupt `fetch` in flight on code change. If you edited any file in `/Users/surs/pwa-kit/packages/template-retail-react-app/app/**` *while* a message was in flight, the fetch will abort and you'll see this path. Mentioned because the user is iterating on localhost and the error is bursty.

### 2.3 Edge — welcome-suppression swallows the real answer

Not a `SET_ERROR` call site, but the user described "no response" sometimes, which can also produce confusion. The sequence:

- `hasUserSentRef = false` after fresh handshake (`WidgetProvider.tsx:140`).
- Agent auto-sends welcome, which arrives on the SSE stream *before* the user's send POST completes.
- `on("message", …)` has a `welcomePendingRef && isChatbot` branch that drops **one** Chatbot message after the user sends, to catch "Agent B" style agents that send the welcome late (`WidgetProvider.tsx:253-256`).
- **Race window**: If the real answer's `message` event arrives before the agent's welcome, but `welcomePendingRef` is still true when the real answer lands, the **real answer is silently dropped**. The user sees typing-indicator → nothing. No `SET_ERROR` fires — it's a silent swallow.

This isn't the banner path, but it's part of the "flaky" perception on localhost (localhost CPU pressure makes event-ordering less deterministic). Flag for a future PR.

### 2.4 Edge — `isMessageTooLong(firstErr)` branch

`WidgetProvider.tsx:371-374` paints the banner immediately with `"Message exceeds the maximum length of 4,000 characters."` on a 400 whose body contains `"maximum length"`. The pill text + product-context prefix is far shorter than 4000, so NOT the user's issue. Noted for completeness.

### Summary table

| Rank | Trigger | Code ref | Shows in Network tab? |
|------|---------|----------|----------------------|
| 1 | SSE reconnect exhausted → `MAX_RECONNECT` → `SET_ERROR` | `client.ts:370-376` → `WidgetProvider.tsx:271` | GET `eventrouter/v1/sse` row only (not a red failure) |
| 2 | `sendMessage` retry failed | `WidgetProvider.tsx:395` | Depends — a 5xx or 401 on the retry *will* show; a stream-close won't |
| 3 | SDK emits any `error` with `code !== "SESSION_EXPIRED"` | `client.ts` (future paths) → `WidgetProvider.tsx:271` | Varies |
| 4 (silent) | Welcome race drops the real answer | `WidgetProvider.tsx:253-256` | Nothing to see — no banner, no answer |

---

## 3. Issue 2 — Did the opener-pills PR introduce a regression?

**No.** Evidence:

- The pills PR touched (`git log origin/main..HEAD`):
  - `src/components/QuestionPills.tsx` (new)
  - `src/styles.css` (new pill rules)
  - `src/provider/pdp-questions.ts` (new)
  - `src/provider/reducer.ts` (new `SET_PDP_QUESTIONS` branch, preserve on `RESET_CONVERSATION`)
  - `src/provider/types.ts` (added `pdpQuestions`)
  - `src/provider/WidgetProvider.tsx` (ONE new effect at lines 70-77 to dispatch `SET_PDP_QUESTIONS` when the config list changes)
  - `src/custom-element.ts` (observe + parse `pdp-questions` attribute)
  - `src/App.tsx` (render `<QuestionPills />`)
  - `tests/provider/*` (new tests)

- What the pills PR did **NOT** touch:
  - `src/sdk/client.ts` — unchanged. All error-emission paths are pre-existing.
  - `src/sdk/sse.ts` — unchanged. The ReadableStream reader, parseFrame, onClose fallback are pre-existing.
  - `src/sdk/errors.ts` — unchanged.
  - `src/provider/ensure-connected.ts` — unchanged.
  - `WidgetProvider.sendMessage` — the body of this callback is unchanged (deps unchanged, error paths unchanged, retry logic unchanged).
  - `WidgetProvider` welcome-suppression refs (`hasUserSentRef`, `welcomePendingRef`, `welcomeTimeoutRef`) and their handlers — unchanged.

- The pill `onClick` goes `void sendMessage(q)` (`QuestionPills.tsx:62`), identical in shape to the input-bar's two call sites (`InputBar.tsx:27, 37`). **If the same question typed by hand triggers the banner, the pills PR is not at fault.** This is the first thing to confirm empirically.

- `disabled={!connectionReady || busy}` on each pill (`QuestionPills.tsx:60`) already prevents double-send during an in-flight question — the same `busy` guard the input bar uses.

**Conclusion**: the opener-pills work surfaces (does not cause) the pre-existing SSE/reconnect/retry fragility of the SDK on an unreliable connection. The fix for the banner is in `sdk/client.ts` + `WidgetProvider.tsx` error handling, independent of the pills work.

---

## 4. Issue 3 — Hedged vs. grounded answers

**Verdict: server-side variance. Not a widget bug.**

Evidence from the widget side:

- The message body is composed deterministically:
  ```ts
  withProductContext(trimmed, resolveProductId(window.location, productContextRef.current))
  ```
  (`WidgetProvider.tsx:345-351`). For a stable URL and the same pill text, this ALWAYS emits the exact same `"(Viewing product details for inline-widget: <id>)\n\n<question>"` string. Byte-for-byte reproducible.
- The widget's `withProductContext` is a pure string prepend (`provider/product-context.ts` — see `tests/provider/product-context.test.ts:101`).
- `product-context.test.ts` locks the format in a unit test. If this ever changed we'd notice.
- The widget does not inspect, embellish, or re-route the question. It is a dumb pipe for text in → text out.

Where the drift actually comes from:

- **Agentforce planner / Reasoner (Daisy++)** — the LLM may route to different tools between runs (catalog-grounded answer vs. unauthenticated general-knowledge answer).
- **RAG retrieval** — if the product-catalog retrieval step misses on one run (indexing lag, token-budget pressure, planner skipping the retrieval tool), you get a hedged "the product details provided do not specify" answer. If it hits, you get the grounded answer.
- **Conversation reuse** — because `persistSession: true` is set in `default.js:246`, the SAME conversation can be reused across page loads until the JWT `exp` runs out. Earlier turns in a conversation can bias later turns (planner using earlier context). This is the single most impactful tunable: setting `persistSession: false` would give every page load a clean conversation.

Where to debug the answer variance (NOT in this repo):

- `commerce-shopper-agent` — the Agentforce plug-in that routes shopping questions to catalog APIs
- `graph-execution-service-fedx` — the planner/Reasoner service
- Use the `shopper-agent-splunk-query` skill with the conversationId (visible in the Network tab's POST request body `conversationEntry.identifier`) to trace a specific hedged response end-to-end across the five Splunk layers.

Fast repro-correlation on your side: capture the conversationId from the SSE event payload for a hedged turn vs. a grounded turn, send to the shopper-agent team. The widget sent identical input in both cases.

---

## 5. Localhost vs. remote — honest answer

**The protocol-level behavior is identical.** SCRT2 is the same production host. CORS/cookies are configured permissively. SSE semantics are the same.

What differs in practice:

| Factor | Localhost | Remote (MRT) | Impact |
|--------|-----------|---------------|--------|
| UMD staleness | Possible — if dev forgot `npm run build:umd` before `npm start`, the host loads an old widget | Not possible — build pipeline is authoritative | **High on localhost**. If the user is testing a fix but seeing the old behavior, this is the first thing to rule out. |
| CPU pressure | High — Vite/webpack + PWA Kit SSR + browser dev-tools open | Low — a lean MRT lambda + CDN | Longer JS pauses → more SSE reconnect pressure → `MAX_RECONNECT` more reachable |
| HMR / fetch interruption | Hot reload cancels in-flight `fetch` on file save | N/A | Only on localhost; can masquerade as "flaky" |
| HTTP/1.1 vs HTTP/2 to SCRT2 | Browser-dependent (modern browsers use H/2 to SCRT2 either way) | Same | No material difference |
| localStorage keying | `buildSessionKey(orgId, esDeveloperName)` is origin-scoped | Same | Switching ports / dev restart changes origin; a prior localStorage session from a different port is unusable (loadSession rejects with "wrong origin") → forces fresh handshake. This can look like flakiness. See `WidgetProvider.tsx:152-168`. |
| Clock skew / token exp | Laptop may be behind on sleep | N/A | On wake, token checks like `Date.now() < tokenExpiresAt` can be off → `SESSION_EXPIRED` path |
| CDN caching UMD | N/A | Possible — `/mobify/caching/static/inline-agent-widget.umd.js` can be cached | Both sides can bite but with opposite polarity |

**Direct answer to the user**: the *code* behaves identically. The *environment* makes some error paths more frequent on localhost (CPU pressure, UMD staleness, HMR, cold laptop → clock skew). The red banner you're seeing is NOT a localhost-only bug; it's just reachable more often there.

---

## 6. Reproduction & next-steps

### 6a. Rebuild the widget first (localhost UMD staleness is the fastest fix)

```bash
cd /Users/surs/inline-agent-widget
npm run build:umd
cp dist/inline-agent-widget.umd.js \
   /Users/surs/pwa-kit/packages/template-retail-react-app/app/static/inline-agent-widget.umd.js

cd /Users/surs/pwa-kit/packages/template-retail-react-app
# hard-reload the page in the browser (Cmd-Shift-R)
```

### 6b. Turn on SDK debug logging

Edit `/Users/surs/pwa-kit/packages/template-retail-react-app/config/default.js:247` → set `enableLogging: true`. Every state transition will print `[Agentforce]` lines to the console. In particular you'll see:

- `Access token acquired`
- `SSE stream connected`
- `Conversation created: <uuid>`
- `Reconnecting in Xms (attempt N/5)...` ← **this is the smoking gun for banner-without-network**
- `Max reconnect attempts (5) reached.` ← **immediately before the banner**
- `sendMessage failed — resetting session: <reason>` ← **first attempt death**
- `first attempt failed, retrying with fresh session:` → `retry also failed:` ← **retry path death**

### 6c. Network tab filters that help

- Filter the Network tab by `eventrouter` to see the SSE stream and reconnect probes. The stream's `Type: eventsource`-ish row stays "pending"; a stall ends it with "canceled" or just vanishes without a status column. Expand it to see the EventStream tab in Chrome — this shows every SSE frame.
- Filter by `message` to see the POSTs — if these are all 2xx, the error is downstream of them (SSE path).
- Preserve log across navigations (`[x] Preserve log`) — otherwise an SPA nav wipes evidence.

### 6d. Pin down "hedged vs grounded" via Splunk

Grab the `conversationId` from any `/conversation/{id}/message` POST URL in the Network tab. For both a hedged turn and a grounded turn, feed them to the `shopper-agent-splunk-query` skill:
```
/shopper-agent-splunk-query <conversationId>
```
The planner's tool-selection trace and the retrieval-step input/output will be in Splunk layers 2-4. The widget emits identical input; the variance is somewhere in those layers.

---

## 7. What to watch during the next pill click

A 60-second checklist for the next repro, in order:

1. **Before clicking**: open DevTools → Console. Make sure `enableLogging: true` is set (per §6b). Reload the page.
2. **Before clicking**: open DevTools → Network. Filter: `eventrouter`. Confirm you see one row for `GET /eventrouter/v1/sse` with status "pending". If NOT present, the handshake hasn't happened yet (lazy connect) — this is normal.
3. **Click the pill**. In Console, watch the `[Agentforce]` lines:
   - Expect: `Access token acquired` → `SSE stream connected` → `Conversation created: <uuid>` → `Message sent: <uuid>`
   - **Problem signal**: `Reconnecting in ...` lines appearing. Count them. If you see "attempt 5/5" followed by `Max reconnect attempts (5) reached.`, that's the Rank-1 banner trigger.
   - **Problem signal**: `sendMessage failed — resetting session: <reason>`. The reason tells you if the POST got a 5xx (`Request POST ... failed (503): ...`) or a timeout (`Request timeout exceeded`) or a network error (`Network error: ...`).
4. **In Network tab**: expand the `eventrouter/v1/sse` row → "EventStream" tab in Chrome. You should see JSON frames flowing. If frames stop before the final `CONVERSATION_MESSAGE`, the stream died — that's the Rank-1 class of bug.
5. **If the banner appears**: screenshot the Console around the moment it appeared. Note the last `[Agentforce]` line. That line names the exact code path.
6. **If no network error appears but banner shows**: this confirms the Rank-1 hypothesis — the banner came from the SSE/reconnect path, not an HTTP response. File a widget-side bug against `sdk/client.ts` (not the pills PR).

---

## Appendix — key file references

- `/Users/surs/inline-agent-widget/src/sdk/client.ts` — AgentforceClient, token/SSE/conversation lifecycle, reconnect, error emission
- `/Users/surs/inline-agent-widget/src/sdk/sse.ts` — SSEReader (fetch + ReadableStream)
- `/Users/surs/inline-agent-widget/src/sdk/errors.ts` — error class hierarchy
- `/Users/surs/inline-agent-widget/src/provider/WidgetProvider.tsx` — React state, event wiring, sendMessage retry, SET_ERROR call sites
- `/Users/surs/inline-agent-widget/src/provider/ensure-connected.ts` — lazy-handshake helper
- `/Users/surs/inline-agent-widget/src/provider/product-context.ts` — URL → productId resolution, body composition
- `/Users/surs/inline-agent-widget/src/provider/reducer.ts` — WidgetState transitions
- `/Users/surs/inline-agent-widget/src/components/QuestionPills.tsx` — pill rendering + click handler
- `/Users/surs/inline-agent-widget/src/components/InputBar.tsx` — text input send path (for comparison)
- `/Users/surs/pwa-kit/packages/template-retail-react-app/app/hooks/use-inline-agent-widget.js` — attribute wiring, UMD loader
- `/Users/surs/pwa-kit/packages/template-retail-react-app/config/default.js:240-248` — host config (`embeddedAgent`)
