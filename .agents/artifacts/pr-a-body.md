## Summary

Adds an opener **question pills** UI to the inline agent widget, driven by a new `pdp-questions` attribute on the custom element. On a PDP where the merchant has published questions (via Content Studio → SCAPI `c_pdpQuestions`), the widget renders up to **5** clickable pills below the input bar. Clicking a pill sends it as the shopper's first message. The pills disappear once the shopper engages (types a question, receives an answer, or the agent is streaming/typing/errored).

Contract:
- `pdp-questions` — JSON-encoded string array of questions, e.g. `'["Q1?","Q2?"]'`
- Parser trims whitespace, drops empty entries, caps at **5** items (`MAX_PDP_QUESTIONS`)
- Invalid JSON / non-array / non-string entries fall back to an empty list (no crash, no pills)
- SPA-navigation between PDPs re-seeds pills (already covered by the existing `RESET_CONVERSATION` handler)

Companion PR in `pwa-kit`: **@W-24333476 - Add opener question pills to inline PDP widget** (plumbs `c_pdpQuestions` through the PDP shim into this attribute).

## Changes

- `src/provider/pdp-questions.ts` — new `parsePdpQuestions` helper + `MAX_PDP_QUESTIONS = 5`
- `src/provider/types.ts` — `pdpQuestions?: string[]` on `WidgetConfig`, `pdpQuestions: string[]` on `WidgetState`, new `SET_PDP_QUESTIONS` action
- `src/provider/reducer.ts` — `pdpQuestions: []` initial state, `SET_PDP_QUESTIONS` case
- `src/custom-element.ts` — `pdp-questions` added to `OBSERVED`, parsed on mount + attribute changes
- `src/provider/WidgetProvider.tsx` — effect syncs config → reducer, keyed on `JSON.stringify(pdpQuestions)`
- `src/components/QuestionPills.tsx` — new component. Renders when `pdpQuestions.length > 0` **and** `!hasEngaged` (`lastQuestion`, `answer`, `streamingText`, `agentTyping`, `error` are all falsy). `onMouseEnter` / `onFocus` call `prepareConnection` for a warm handshake before click.
- `src/App.tsx` — mounts `<QuestionPills />` between `<InputBar />` and `<Response />`
- `src/styles.css` — `.pills`, `.pill` classes + `--iaw-pill-*` theme variables
- `tests/provider/pdp-questions.test.ts` — 9 unit tests (happy path, whitespace, empty, non-array, non-string entries, `MAX_PDP_QUESTIONS` cap, malformed JSON, null/undefined)
- `README.md` — documents the new attribute

## Test plan

- [x] `npm test` — 142 tests pass (9 new tests in `pdp-questions.test.ts`, existing suite green)
- [x] `npm run build` — clean build, no TS errors
- [x] Manual — PDP with `pdp-questions='[...]'` renders pills below input bar
- [x] Manual — Click pill: sends message, pills disappear, response streams normally
- [x] Manual — Type your own question: pills disappear (`hasEngaged` gate)
- [x] Manual — SPA-navigate between PDPs: pills re-seed for the new product
- [x] Manual — Malformed JSON on attribute: no pills, no console error, widget still works
- [x] Manual — Empty array or missing attribute: no pills rendered
- [x] Manual — More than 5 questions in JSON: only first 5 render

## Follow-ups (not in this PR)

- Analytics event `inline_pdp_pill_click` (deferred to a follow-up)
- Optional pill-count tuning per merchant (currently hard-capped at 5)
- Mobile layout polish (long questions wrap; horizontal scroll TBD)
- Follow-up pills v2 (questions surfaced after an answer streams)
