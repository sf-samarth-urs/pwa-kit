# Storefront comparison page

Preview the supplied TrailFit agent response at `/us/en-US/compare?demo=trailfit`.
The plain `/us/en-US/compare` route displays an empty state. Demo data is never
substituted silently for a live result.

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

Live messaging result delivery, automatic navigation, comparison persistence and
conversation-bound follow-up actions are the next integration step. The page does
not create, end or alter a messaging conversation.

This worktree reuses dependency directories from the original checkout through
local symlinks. Run the normal repository dependency setup in a fresh clone.

The example enables the NTO sandbox deployment `NTO_SFRA_sdb601_CC_ES` in org
`00Dfi800001CByP`. PWA maps the agent endpoint and org through `scrt2Url` and
`salesforceOrgId`. Storefront catalog configuration is independent.
