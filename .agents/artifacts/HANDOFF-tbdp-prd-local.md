# Inline PDP Ask Assistant — localhost:3000 handoff

**W-24333476** — PR-A (`inline-agent-widget#14`) + PR-B (`pwa-kit#4040`) on tbdp_prd / NTOManaged.

Target: `http://localhost:3000/us/en-US/product/500400` → opener pills render → click → streamed answer.

Realistic time: **~2 min warm, ~6 min cold** (bottleneck is `npm ci`).

---

## What you need from Surs (shared out-of-band)

1. `tbdp-prd-local.patch` — the 4-file config swap (RefArch → tbdp_prd / NTOManaged + private-client flags). Ships next to this file.
2. `.env` — contains `PWA_KIT_SLAS_CLIENT_SECRET` for tbdp_prd + both widget JSON blobs. Gitignored on purpose; secret is known to the whole team. Grab from Surs' Slack DM.

Everything else — both PRs, both repos, the widget UMD bundle — you pull directly from upstream `SalesforceCommerceCloud/*`. **No fork URLs needed anywhere.**

> Why: PR #14's head branch lives on Surs' fork, but GitHub exposes every open PR's head at `refs/pull/N/head` **on the upstream repo** regardless. `gh pr checkout 14` run against the upstream clone pulls it transparently.

---

## Steps

```bash
# ─── Terminal 1 — build the widget UMD bundle from PR #14 ────────────────────
gh repo clone SalesforceCommerceCloud/inline-agent-widget
cd inline-agent-widget
gh pr checkout 14                       # pulls Surs' fork branch via upstream
npm ci && npm run build:umd             # → dist/inline-agent-widget.umd.js
cd ..

# ─── Terminal 2 — pwa-kit with PR #4040 + tbdp_prd config ────────────────────
gh repo clone SalesforceCommerceCloud/pwa-kit
cd pwa-kit
gh pr checkout 4040
git apply /path/to/tbdp-prd-local.patch

# Drop in the env + the UMD bundle you just built
cp /path/to/.env packages/template-retail-react-app/.env
mkdir -p packages/template-retail-react-app/public/static
cp ../inline-agent-widget/dist/inline-agent-widget.umd.js \
   packages/template-retail-react-app/public/static/

npm ci
cd packages/template-retail-react-app && npm start
```

Open `http://localhost:3000/us/en-US/product/500400`. Pills should render within ~1–2s of the SCRT2 handshake completing (observe the brief disabled state → clickable). Click one → user bubble renders → agent answer streams in ~5–10s.

**No `gh` CLI?** Replace `gh pr checkout N` with:
```bash
git fetch origin pull/N/head:pr-N && git checkout pr-N
```
Works against the upstream clone — same mechanism `gh` uses underneath.

---

## What the patch actually changes (4 files, ~95 lines)

| File | Change |
|---|---|
| `config/default.js` | `defaultSite`: `RefArchGlobal` → `NTOManaged`; `siteAliases`: `{NTOManaged: 'us'}`; `commerceAPI.parameters` → tbdp_prd / `sandbox-001` / `af919544-…`; blank `einsteinAPI.einsteinId` (not provisioned); `proxyConfigs` hosts → `sandbox-001.*` |
| `config/sites.js` | Replace RefArch + RefArchGlobal with the single NTOManaged / en-US site |
| `app/ssr.js` | `useSLASPrivateClient: true` (requires the secret in `.env`); dormant `hybridProxy.sfccOrigin` repointed to `sandbox-001.dx.*` for correctness |
| `app/components/_app-config/index.jsx` | `enablePWAKitPrivateClient={true}` — PWA Kit routes auth through `/mobify/slas/private` |

**Not touched by this patch:**
- PR-A changes (sit on `inline-agent-widget` branch `pr-14`)
- PR-B changes (sit on `pwa-kit` branch `pr-4040`)
- `.env` (gitignored, shared separately — do not commit)
- `inline-agent-widget.umd.js` (built locally, lands under `public/static/`)

---

## Troubleshooting

**Widget never mounts / `<inline-agent-widget>` not in DOM.** The UMD bundle isn't being served from `/static/inline-agent-widget.umd.js`. Check that it exists under `packages/template-retail-react-app/public/static/`. If missing or stale, rerun `npm run build:umd` inside the `inline-agent-widget` repo (on branch `pr-14`) and recopy `dist/inline-agent-widget.umd.js`.

**SLAS 501 on login.** `useSLASPrivateClient: true` + no `PWA_KIT_SLAS_CLIENT_SECRET` in `.env`. The private-client proxy returns 501 when the secret env var is missing. Confirm `.env` is at `packages/template-retail-react-app/.env` (that's where `npm start` auto-loads it via `set -a; . ./.env`).

**Pills never flip from disabled → enabled.** SCRT2 handshake is failing. DevTools → Network → look for POST `/iamessage/api/v2/authorization/unauthenticated/token` and the SSE stream at `/eventrouter/v1/sse`. Confirm `INLINE_AGENT_WIDGET_COMMERCE_SETTINGS.scrt2Url` + `orgId` + `esDeveloperName` match what's in your `.env`.

**Pills render but no answer streams back.** The ICR BYON side is wedged — check the Chatter channel for the ICR agent script `nto_agent_script.yaml` deploy status. Not a PWA Kit issue; message Rishi/Chintan.

**Red "Something went wrong" toast on first load.** The floating Commerce Client is enabled. In `.env`, confirm `COMMERCE_AGENT_SETTINGS.enabled` is `"false"` (string, not boolean) — this short-circuits before the provider-specific validator and clears the toast + SFRA product-tile links. The inline PDP widget is unaffected.

**Product 500400 has no pills.** Content Studio hasn't pushed `c_pdpQuestions` for that id yet, or the push went to the wrong site. Verify with:
```bash
curl -s 'https://sandbox-001.api.commercecloud.salesforce.com/product/shopper-products/v1/organizations/f_ecom_tbdp_prd/products?siteId=nto&ids=500400' \
  -H "authorization: Bearer <any-slas-shopper-token>" | jq '.data[].c_pdpQuestions'
```
Known-good ids (as of 2026-10-01): `500400, 500700, 503200, 5122982, 5123362, 6010018, 6010045`.

---

## Full call-flow reference

See `.agents/artifacts/inline-pdp-ask-assistant-e2e-call-flow.md` in Surs' tree for the full 11-section e2e trace (bootstrap → readiness gate → marker injection → ICR → BYON → Apex → SCAPI → LLM → rendering). Covers every latency hop and the handshake state machine.
