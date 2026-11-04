# Storefront comparison page

Preview the supplied TrailFit agent response at `/us/en-US/compare?demo=trailfit`.
The plain `/us/en-US/compare` route displays the latest live comparison, or an
empty state until the agent returns one. Demo data is never substituted for a live result.

From `packages/template-retail-react-app`:

```sh
cp config/compare-agent.env.example .env
PORT=3012 npm start
```

`adapter.js` maps the existing `response` envelope to `ComparisonView`. It keeps
product and cell order aligned, accepts two or more products, and treats absent
attributes as unspecified. `trailfit-response.json` contains the supplied response
with pasted Markdown URL wrappers removed and the unused payment URL omitted.

The page retains the storefront header, uses local PDP routes, and scrolls wide
cards and specifications on narrow screens. It does not infer ratings, inventory
or a recommended product from prose. The advice panel displays the supplied advice.

With `cc_enableComparisonPage` enabled, the messaging SDK's `onAgentResponse`
callback delivers completed agent replies to PWA. A valid `product_comparison`
block updates the page and navigates desktop shoppers to `/compare`, preserving
an open widget. There is no second agent request or conversation. Follow-up
comparisons replace the current result; ordinary replies leave it unchanged.
This delivers completed structured replies, rather than partial JSON tokens.

The display model is kept in tab session storage for up to four hours, scoped by
org, deployment and site. Session reset/end or a different conversation clears it.
Message IDs prevent replayed replies from reopening the page.

The local example requires the unpublished SDK changes on Cimulate branch
`codex/comparison-response-handoff`. From its `javascript/copilot-widget` directory:

```sh
WIDGET_LIB_FORMAT=umd VITE_WIDGET_LIB_FORMAT=umd npm exec vite build -- --mode production --config vite.messaging.config.ts
cp dist/messaging.umd.js /path/to/pwa-kit-compare/packages/template-retail-react-app/app/static/comparison-messaging.umd.js
```

The generated bundle is ignored by Git. The example loads it through
`commerceClientScriptSourceUrl`; replace this override with a published SDK version
when the callback is released. The page does not create or end conversations.

This worktree reuses dependency directories from the original checkout through
local symlinks. Run the normal repository dependency setup in a fresh clone.

The example enables the NTO sandbox deployment `NTO_SFRA_sdb601_CC_ES` in org
`00Dfi800001CByP`. PWA maps the agent endpoint and org through `scrt2Url` and
`salesforceOrgId`. The storefront uses the same NTOManaged site, NTO commerce API and private SLAS client as the original checkout. The private client secret must be supplied through PWA_KIT_SLAS_CLIENT_SECRET in the local .env; it is not committed.

When the correlated `requestText` asks for a comparison but the agent returns
product cards instead of a comparison table, the page shows those returned products
and prose with an explicit missing-specifications notice. Both carousels and
individual product tiles are supported. Search carousels without a comparison
request remain in chat; replayed replies cannot acquire a later request's intent.
