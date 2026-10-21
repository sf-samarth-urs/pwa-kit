# PDP → `inline-agent-widget`: how product data + opener pills flow across storefronts

Scope: trace the path from "shopper clicks a product tile" to "`<inline-agent-widget>` has its `pdp-questions` + `product-name` attributes set", for **PWA Kit**, **SFRA**, and **SF Next**.

Everything downstream of SCAPI is identical (the widget is one UMD bundle). Only the storefront-side fetch mechanism and the mount point differ.

---

## 0. The shared contract

| Layer | Key | Shape |
|---|---|---|
| Business Manager Attribute Definition | `pdpQuestions` | string (JSON-encoded array) |
| SFRA `pdict.product.custom` | `pdpQuestions` | string (same JSON) |
| SCAPI `/product/shopper-products/v1/.../products/{id}` JSON | `c_pdpQuestions` | string (same JSON — SCAPI prefixes custom attrs with `c_`) |
| Host-side parsed form | `pdpQuestions` | `string[]`, deduped, trimmed, cap 5 |
| Widget attribute | `pdp-questions` | JSON-encoded `string[]` |
| Widget state (`WidgetState.pdpQuestions`) | `pdpQuestions` | `string[]` |

Content Studio is upstream of all of this. It generates the FAQ, keeps it behind a human review gate, and publishes via OCAPI `sfcc-site-archive-import` (MERGE) into the `pdpQuestions` attribute. Not a storefront concern — the three paths below just read what Content Studio wrote.

Widget hard-cap: `MAX_PDP_QUESTIONS = 5` (`/Users/surs/inline-agent-widget/src/provider/pdp-questions.ts`). The host also trims/dedupes/caps so a malformed publish doesn't leak into the widget.

---

## 1. PWA Kit

Fetch happens entirely in the browser (TanStack Query, SSR-hydrated). No loader; the PDP page component calls `useProduct` directly.

### Data flow

```
PLP tile click
    │
    ▼
Link navigates to /product/<pid>
    │
    ▼
app/pages/product-detail/index.jsx mounts
    │
    ▼
useProduct({ parameters: { id: productId, expand: [...], perPricebook: true, ... }})
    │   (packages/commerce-sdk-react/src/hooks/ShopperProducts/query.ts:72)
    │
    ▼
commerce-sdk-isomorphic → shopperProducts.getProduct({ path: {id} })
    │
    ▼
GET https://<shortcode>.api.commercecloud.salesforce.com
      /product/shopper-products/v1/organizations/<orgId>/products/<pid>
      ?siteId=<site>&expand=...&allImages=true&perPricebook=true
    │
    ▼
SCAPI response → productResponse (includes c_pdpQuestions when present)
    │
    ▼
<InlineAgentWidget
    config={embeddedAgentConfig}
    pdpQuestions={parsePdpQuestions(productResponse?.c_pdpQuestions)}  ← injection point
    productName={productResponse?.name}
/>
```

### Key files

| File | Role |
|---|---|
| `packages/template-retail-react-app/app/pages/product-detail/index.jsx:113` | Calls `useProduct({ parameters: { id: urlParams.get('pid') \|\| productId, ... }})` |
| `packages/template-retail-react-app/app/pages/product-detail/index.jsx:812-818` | **Injection site** — `<InlineAgentWidget config={...} pdpQuestions={parsePdpQuestions(productResponse?.c_pdpQuestions)} productName={productResponse?.name} />` passed as `actionFooter` so it sits directly below Add-to-Cart |
| `packages/template-retail-react-app/app/utils/inline-agent-widget-utils.js:40` | `parsePdpQuestions` — SCAPI string → sanitized `string[]` (trim/dedupe/cap at 5) |
| `packages/template-retail-react-app/app/components/inline-agent-widget/index.jsx` | React wrapper: renders `<Helmet><script src="/static/inline-agent-widget.umd.js" async/></Helmet>` + a `containerRef` div |
| `packages/template-retail-react-app/app/hooks/use-inline-agent-widget.js` | Script-load gate (`readyPromise`) + two sync effects for `pdp-questions` and `product-name` that update attributes without re-mounting the custom element (preserves SCRT2 session) |
| `packages/commerce-sdk-react/src/hooks/ShopperProducts/query.ts:72` | Underlying `useProduct` → `shopperProducts.getProduct` |

### Why this shape

- `useProduct` is a TanStack `useQuery` wrapper. On SSR it fetches, serializes into the client payload, and the client picks up from the cache on hydration — no second network call for the first paint.
- The widget is injected as `actionFooter` on `ProductCartActions` so it visually sits in the buy-flow stack (same column as Add-to-Cart + Express Checkout).

---

## 2. SFRA (plugin_commerce_client)

Fetch happens server-side in the controller before ISML renders. The `pdpQuestions` attribute lives on `product.custom.pdpQuestions`, but SFRA's `ProductFullPageModel` **does not project `custom.*` onto `pdict.product`** — so the ISML has to re-fetch via `ProductMgr.getProduct(pid)`.

### Data flow

```
PLP tile click
    │
    ▼
Browser navigates to /<locale>/<pid>.html → Product-Show controller
    │
    ▼
Product-Show pipeline runs, builds pdict.product via ProductFullPageModel
    │   (pdict.product.custom is NOT populated — SFRA model omits custom.*)
    │
    ▼
productDetails.isml renders, which <isinclude/>'s cimulate/inlineAgentWidget.isml
    │
    ▼
<isscript> block runs in B/E (Rhino):
    pdpProductRaw = ProductMgr.getProduct(pdict.product.id)
    pdpQuestions  = String(pdpProductRaw.custom.pdpQuestions)   ← same JSON string as SCAPI's c_pdpQuestions
    pdpProductName = pdpProductRaw.name
    │
    ▼
<script> block (B/E-rendered, F/E-executed) builds the element inline:
    el = document.createElement('inline-agent-widget')
    el.setAttribute('pdp-questions', "${pdpQuestions}")        ← injection point
    el.setAttribute('product-name', "${pdpProductName}")
    el.setAttribute('scrt2-url', ...), ('org-id', ...), ('es-developer-name', ...), etc
    │
    ▼
Mount: find host = document.querySelector('.product-detail[data-pid]')
       insertBefore(el, host.querySelector('.prices-add-to-cart-actions').nextSibling)
```

### Key files

| File | Role |
|---|---|
| `cartridges/plugin_commerce_client/cartridge/templates/default/cimulate/inlineAgentWidget.isml:19-55` | **Injection site (B/E).** `<isscript>` re-fetches via `ProductMgr.getProduct(pdict.product.id)` and extracts `custom.pdpQuestions` + `name` |
| `cartridges/plugin_commerce_client/cartridge/templates/default/cimulate/inlineAgentWidget.isml:66-111` | **Injection site (F/E).** Builds `<inline-agent-widget>`, sets attributes (incl. `pdp-questions`, `product-name`), inserts right after `.prices-add-to-cart-actions` |
| `cartridges/plugin_commerce_client/cartridge/scripts/cimulate/configHelper.js` | Reads `cc_embeddedAgent_config` site preference (JSON blob in BM) and exposes `getEmbeddedAgentConfig` + `isEmbeddedAgentConfigured` |
| `cartridges/plugin_commerce_client/cartridge/static/default/js/inlineAgent/inline-agent-widget.umd.js` | Self-hosted UMD, served via `URLUtils.staticURL` |

### Why this shape

- No DOM-ready widget wrapper component; the ISML owns the lifecycle entirely. Mount runs once on `DOMContentLoaded`, guarded by `data-iaw-pdp` to avoid double-mount if the include is re-invoked.
- `.product-detail[data-pid]` is the SFRA PDP anchor; the widget is inserted immediately after Add-to-Cart to match PWA/SF Next placement.
- `ProductMgr.getProduct(pid)` is the authoritative read of `custom.*` on the backend — the SFRA `pdict.product` is a model, not the raw platform product.

---

## 3. SF Next (storefront-next)

Fetch happens on the server in a route loader (`loader` export of the PDP route). The loader result is handed to the component tree synchronously, so there is no client-side re-fetch for the initial render.

### Data flow

```
PLP tile click
    │
    ▼
Browser navigates to /<site>/<locale>/p/<pid>
    │
    ▼
React Router v7: _app.p.$ route → export async function loader(args)
    │   (routes/_app.p.$.tsx:142)
    │
    ▼
fetchProductById(context, productLookupId, { expand: [...], allImages, perPricebook, ... })
    │   (lib/api/products.server.ts:134)
    │
    ▼
clients.shopperProducts.getProduct({ params: { path: {id}, query: options }})
    │
    ▼
GET https://<shortcode>.api.commercecloud.salesforce.com
      /product/shopper-products/v1/organizations/<orgId>/products/<pid>
      ?siteId=<site>&expand=...&allImages=true&perPricebook=true
    │
    ▼
Loader returns { product, page, ... } → React Router hydrates
    │
    ▼
<ProductView product={product} /> renders
    │   (components/product-view/product-view.tsx)
    │
    ▼
Inside ProductView:
    embeddedAgent = useRouteLoaderData('root')?.appConfig?.commerce?.embeddedAgent
    pdpQuestions = parsePdpQuestions((product as any).c_pdpQuestions)
    │
    ▼
<EmbeddedAgentWidget
    config={embeddedAgent}
    pdpQuestions={pdpQuestions}            ← injection point
    productName={product.name}
/>
```

### Key files

| File | Role |
|---|---|
| `packages/template/src/routes/_app.p.$.tsx:142` | Route loader — awaits `fetchProductById`, returns `product` to the component tree |
| `packages/template/src/lib/api/products.server.ts:134` | `fetchProductById` → `clients.shopperProducts.getProduct({ params: {path:{id}, query: options}})` |
| `packages/template/src/components/product-view/product-view.tsx:61-109` | **Injection site.** Reads `embeddedAgent` from the root loader + `c_pdpQuestions` from `product`, mounts `<EmbeddedAgentWidget>` inside the `order-2` right column directly below `<ProductCartActions>` |
| `packages/template/src/components/embedded-agent/embedded-agent.utils.ts:101` | `parsePdpQuestions` — SCAPI string → sanitized `string[]` |
| `packages/template/src/components/embedded-agent/embedded-agent-widget.tsx` | React wrapper: injects `<script src=…/inline-agent-widget.umd.js>` once, mounts the custom element with all attributes, and runs two separate attribute-sync effects for `pdp-questions` and `product-name` so variant swaps / SPA PDP nav don't drop the SCRT2 session |

### Why this shape

- Route loaders in RRv7 run on the server, so the SCAPI call is server-side; the first HTML paint already has the product.
- The `product-view.tsx` component (right column, under Express Checkout) matches the SFRA/PWA buy-flow placement rather than mounting at the page-level — which would stretch the widget to full width.
- The attribute-sync effects depend on primitive config fields, not the config object — root-loader revalidation produces a new config object even when nothing material changed, and re-mounting the element would drop the SCRT2 conversation.

---

## 4. Comparison at a glance

| | PWA Kit | SFRA | SF Next |
|---|---|---|---|
| **Where product fetch runs** | Browser (TanStack Query, SSR-hydrated) | Backend (`Product-Show` controller, Rhino) | Server loader (RR v7) |
| **SDK / API** | `commerce-sdk-react` → `shopperProducts.getProduct` (SCAPI) | `dw/catalog/ProductMgr.getProduct(id)` (platform direct) | `@salesforce/scapi` → `shopperProducts.getProduct` (SCAPI) |
| **URL grammar** | `/product/<pid>` | `/<pid>.html` (or `Product-Show?pid=…`) | `/<site>/<locale>/p/<pid>` |
| **Where `pdpQuestions` lives in that fetch's response** | `response.c_pdpQuestions` (SCAPI custom attrs are `c_`-prefixed) | `product.custom.pdpQuestions` (platform object; the ISML has to call `ProductMgr.getProduct` because the model omits `custom.*`) | `response.c_pdpQuestions` |
| **Host-side parser** | `parsePdpQuestions` in `inline-agent-widget-utils.js` | `String(product.custom.pdpQuestions)` passed through; widget-side parser (`src/provider/pdp-questions.ts`) does the sanitization | `parsePdpQuestions` in `embedded-agent.utils.ts` |
| **Injection file (the single source where `pdp-questions` is set)** | `packages/template-retail-react-app/app/pages/product-detail/index.jsx:812` | `cartridges/plugin_commerce_client/cartridge/templates/default/cimulate/inlineAgentWidget.isml:82` | `packages/template/src/components/product-view/product-view.tsx:104` |
| **Mount DOM anchor** | `<InlineAgentWidget>` as `actionFooter` on `ProductCartActions` | `.product-detail[data-pid]` → `insertBefore(el, .prices-add-to-cart-actions.nextSibling)` | Inside `ProductView`'s `order-2` right column, directly after `<ProductCartActions>` |
| **Script tag** | `<Helmet><script src="/static/inline-agent-widget.umd.js" async/></Helmet>` (SSR'd into `<head>`) | `<script src="${URLUtils.staticURL('/js/inlineAgent/inline-agent-widget.umd.js')}">` emitted inline by the ISML | `document.head.appendChild(<script src=/inline-agent-widget.umd.js async>)` from the component effect |
| **Attribute-sync strategy for variant / SPA PDP nav** | Two effects on `pdpQuestionsKey` + `productName` — set/remove attributes without re-creating the element | None — SFRA full-page nav re-runs the ISML mount, which re-creates the element every PDP. Side effect: SCRT2 session re-handshakes per PDP. | Two effects on `questionsKey` + `productName` — same as PWA Kit |

---

## 5. One-liner: "which file injects `pdp-questions` into the widget?"

- **PWA Kit** → `packages/template-retail-react-app/app/pages/product-detail/index.jsx` (line 812, inside the `<InlineAgentWidget>` JSX — passed as a prop; the hook `use-inline-agent-widget.js` is what calls `el.setAttribute('pdp-questions', ...)`)
- **SFRA** → `cartridges/plugin_commerce_client/cartridge/templates/default/cimulate/inlineAgentWidget.isml` (`el.setAttribute('pdp-questions', ...)` on line 82)
- **SF Next** → `packages/template/src/components/product-view/product-view.tsx` (line 104, inside the `<EmbeddedAgentWidget>` JSX — passed as a prop; the component `embedded-agent-widget.tsx` is what calls `el.setAttribute('pdp-questions', ...)`)

---

## 6. SCAPI endpoint reference (used by PWA Kit + SF Next)

Both PWA Kit and SF Next hit the same Shopper Products endpoint:

```
GET https://<shortcode>.api.commercecloud.salesforce.com
    /product/shopper-products/v1/organizations/<orgId>/products/<productId>
    ?siteId=<siteId>
    &expand=availability,bundled_products,images,options,page_meta_tags,prices,promotions,set_products,variations
    &allImages=true
    &perPricebook=true
Authorization: Bearer <SLAS shopper token>
```

Response includes `c_pdpQuestions` as a JSON-encoded string whenever Content Studio has published it for that SKU. Absence → widget renders without pills (empty pill shelf hidden by `MAX_PDP_QUESTIONS = 0` branch).

SFRA bypasses SCAPI entirely for this read — `ProductMgr.getProduct(pid).custom.pdpQuestions` is a direct platform API call inside the storefront JVM, so the same string reaches the widget without crossing the SCAPI boundary.
