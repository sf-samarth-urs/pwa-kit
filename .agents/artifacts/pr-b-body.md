## Summary

Plumbs SCAPI's `c_pdpQuestions` custom attribute from the Shopper Products response into the inline agent widget's new `pdp-questions` attribute. On a PDP where the merchant has published up to 5 opener questions via Content Studio, shoppers now see clickable question pills below the widget's input bar. Clicking a pill sends it as the first message.

Depends on the widget-side change: **@W-24333476 - Add opener question pills (pdp-questions attribute)** in `SalesforceCommerceCloud/inline-agent-widget` (the rebuilt UMD bundle is included here in `app/static/inline-agent-widget.umd.js`).

## Changes

- `app/utils/inline-agent-widget-utils.js` — new SSR-safe `parsePdpQuestions` helper (mirrors the widget-side parser: trims, drops empties, caps at 5, defensive on non-JSON / non-array / non-string)
- `app/utils/inline-agent-widget-utils.test.js` — 6 unit tests, 100 % file coverage
- `app/pages/product-detail/index.jsx` — reads `productResponse?.c_pdpQuestions`, parses it, passes to `<InlineAgentWidget pdpQuestions={...} />`
- `app/components/inline-agent-widget/index.jsx` — accepts `pdpQuestions` prop, forwards to the hook, PropTypes updated
- `app/hooks/use-inline-agent-widget.js` — seeds `pdp-questions` at element creation; separate sync effect keyed on `pdpQuestionsKey = JSON.stringify(pdpQuestions)` for variant switches
- `app/static/inline-agent-widget.umd.js` — rebuilt bundle carrying the widget-side pills UI
- `CHANGELOG.md` — feature entry `@W-24333476`

## Test plan

- [x] `npm test -- product-detail inline-agent-widget-utils use-inline-agent-widget` — 24 PDP + hook tests pass, 6 new utils tests pass
- [x] Manual — PDP for a product where SCAPI returns `c_pdpQuestions` as JSON-encoded string: pills render, click sends the question, response streams
- [x] Manual — PDP for a product with no `c_pdpQuestions`: widget renders normally, no pills
- [x] Manual — Malformed `c_pdpQuestions` (bad JSON, non-array): no crash, widget still works, no pills
- [x] Manual — SPA-navigation between two PDPs with different pill sets: pills re-seed correctly
- [x] Manual — Variant selection on a product-set / bundle: hook re-syncs when `pdpQuestions` reference changes

## Notes

- `parsePdpQuestions` is duplicated between the widget and PWA Kit intentionally: the PWA Kit shim must run in SSR (Node) without importing widget browser code. The two parsers are behaviour-equivalent and are covered by their own tests on each side.
- Widget contract: attribute `pdp-questions` is a JSON-encoded string array. This is a stable contract in the widget's README.
- Uses `productResponse?.c_pdpQuestions` — `c_` prefix denotes an SCAPI custom attribute; the site data manager (Content Studio) is the source of truth.

## Follow-ups (not in this PR)

- SFRA companion work: **W-24333477** (equivalent plumbing for SFRA storefronts)
- Analytics event `inline_pdp_pill_click` on the widget side
- Localization via Commerce Content Studio (merchant-published questions per locale)
