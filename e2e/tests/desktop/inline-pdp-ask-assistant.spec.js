/*
 * Copyright (c) 2026, Salesforce, Inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Inline PDP "Ask Assistant" opener-pills end-to-end spec (W-24333476)
 *
 * Automates the four-step journey that was previously verified by hand:
 *   1. Land on a PDP
 *   2. Wait for the inline-widget bundle + opener pills to render
 *      and become clickable (SCRT2 handshake complete)
 *   3. Click a pill
 *   4. Wait for a non-empty streamed answer to appear
 *
 * Design notes:
 * - Discovers candidate PDPs by hitting SCAPI directly for `c_pdpQuestions`
 *   so the spec is NOT hard-coded to a single product id. Products without
 *   that custom attribute are skipped (pills don't render for them —
 *   expected behavior).
 * - All waits are capped: the readiness gate SHOULD open within ~1-2s, and
 *   an answer SHOULD stream within ~5-10s. Hard timeout 60s per test
 *   matches the project default in playwright.config.js.
 * - Intercepts the outbound SCRT2 POST to
 *   /iamessage/api/v2/conversation/<convId>/message to assert the
 *   product-context marker is present — proves the hack from PR-A still
 *   fires correctly when invoked via a pill click.
 * - Does not assert exact answer wording (LLM is non-deterministic). Asserts
 *   that an answer DOM node appears with non-trivial text (>20 chars).
 *
 * Run with:
 *   RETAIL_APP_HOME=http://localhost:3000 \
 *   RETAIL_APP_HOME_SCAPI=https://sandbox-001.api.commercecloud.salesforce.com \
 *   RETAIL_APP_HOME_SITE=NTOManaged \
 *   RETAIL_APP_HOME_ORGANIZATION_ID=f_ecom_tbdp_prd \
 *   RETAIL_APP_HOME_SLAS_CLIENT_ID=af919544-30a2-4c65-9564-2db56fc80fc3 \
 *   npx playwright test inline-pdp-ask-assistant.spec.js --project=chromium
 * ─────────────────────────────────────────────────────────────────────────────
 */

const {test, expect} = require('@playwright/test')
const config = require('../../config')

// Shoppers can configure which product ids to try. Falls back to the known-good
// list from the storefront-cleanup session. Products without c_pdpQuestions are
// skipped automatically.
const CANDIDATE_PRODUCT_IDS = (
    process.env.INLINE_PDP_CANDIDATE_IDS ||
    '500400,500700,503200,502900,5122982,5123362,6010018,6010045'
)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

// Locale segment on the PWA Kit URL. tbdp_prd NTOManaged ships 'us/en-US'.
const LOCALE_PATH = process.env.INLINE_PDP_LOCALE_PATH || 'us/en-US'

// SCAPI config for discovery. Public SLAS client is fine for shopper-products.
const SCAPI_BASE = process.env.RETAIL_APP_HOME_SCAPI || 'https://sandbox-001.api.commercecloud.salesforce.com'
const SCAPI_ORG = process.env.RETAIL_APP_HOME_ORGANIZATION_ID || 'f_ecom_tbdp_prd'
const SCAPI_SITE = process.env.RETAIL_APP_HOME_SITE || 'nto' // SCAPI siteId is lowercase 'nto'; URL siteId is 'NTOManaged'
const SCAPI_CLIENT_ID =
    process.env.RETAIL_APP_HOME_SLAS_CLIENT_ID || 'af919544-30a2-4c65-9564-2db56fc80fc3'

// How long to wait for the pill button to become enabled (handshake done).
const HANDSHAKE_TIMEOUT_MS = 15_000
// How long to wait for an answer to stream back.
const ANSWER_TIMEOUT_MS = 20_000
// Minimum answer length (chars) to count as "a real answer, not an empty bubble".
const MIN_ANSWER_LEN = 20

/**
 * Mint a public SLAS guest access token for product discovery. The call shape
 * matches PWA Kit's own commerce-sdk-react pathway. Returns null on failure so
 * the test can fall back to attempting all CANDIDATE_PRODUCT_IDS blindly.
 */
async function mintSlasGuestToken(request) {
    const url = `${SCAPI_BASE}/shopper/auth/v1/organizations/${SCAPI_ORG}/oauth2/token`
    const body = new URLSearchParams({
        grant_type: 'client_credentials',
        channel_id: SCAPI_SITE
    })
    try {
        const resp = await request.post(url, {
            form: Object.fromEntries(body),
            headers: {
                authorization: `Basic ${Buffer.from(`${SCAPI_CLIENT_ID}:`).toString('base64')}`,
                'content-type': 'application/x-www-form-urlencoded'
            }
        })
        if (!resp.ok()) return null
        const json = await resp.json()
        return json.access_token || null
    } catch (_) {
        return null
    }
}

/**
 * Fetch c_pdpQuestions for candidate product ids via SCAPI's batch endpoint.
 * Returns [{id, questions: string[]}] for products that have a non-empty
 * c_pdpQuestions. If token fetch fails returns null — the caller then falls
 * back to trying candidates directly in the UI.
 */
async function discoverPillProducts(request) {
    const token = await mintSlasGuestToken(request)
    if (!token) return null

    const ids = CANDIDATE_PRODUCT_IDS.join(',')
    const url =
        `${SCAPI_BASE}/product/shopper-products/v1/organizations/${SCAPI_ORG}` +
        `/products?siteId=${SCAPI_SITE}&ids=${encodeURIComponent(ids)}`

    try {
        const resp = await request.get(url, {
            headers: {authorization: `Bearer ${token}`}
        })
        if (!resp.ok()) return null
        const json = await resp.json()
        const data = Array.isArray(json?.data) ? json.data : []
        const products = []
        for (const p of data) {
            let questions = []
            const raw = p?.c_pdpQuestions
            if (Array.isArray(raw)) {
                questions = raw.filter((q) => typeof q === 'string')
            } else if (typeof raw === 'string') {
                // Content Studio writes c_pdpQuestions as a stringified JSON array.
                try {
                    const parsed = JSON.parse(raw)
                    if (Array.isArray(parsed))
                        questions = parsed.filter((q) => typeof q === 'string')
                } catch (_) {
                    // ignore malformed
                }
            }
            if (questions.length > 0 && p?.id) {
                products.push({id: p.id, questions})
            }
        }
        return products
    } catch (_) {
        return null
    }
}

/**
 * Pick a random pill button from inside the widget's open shadow root. The
 * widget renders pills as <button class="pill"> inside <ul class="pills">.
 * Playwright CSS locators automatically pierce open shadow roots, so a plain
 * `widget.locator('button.pill')` works.
 */
async function pickRandomPillButton(widget) {
    const pills = widget.locator('button.pill')
    const count = await pills.count()
    expect(count, 'Widget should render at least one opener pill').toBeGreaterThan(0)
    const idx = Math.floor(Math.random() * count)
    return {button: pills.nth(idx), count, idx}
}

/**
 * Resolve the mounted <inline-agent-widget> element handle. Also fails fast
 * with a clear message if the custom element never shows up (bundle not
 * loaded / enabled: false / wrong env).
 */
async function awaitWidget(page) {
    const widget = page.locator('inline-agent-widget')
    await widget.waitFor({state: 'attached', timeout: 10_000}).catch(() => {
        throw new Error(
            '<inline-agent-widget> never mounted — check INLINE_AGENT_WIDGET_COMMERCE_SETTINGS and that the UMD bundle at /static/inline-agent-widget.umd.js is served'
        )
    })
    return widget
}

/**
 * Browser-side helper injected via page.waitForFunction. Returns true once at
 * least one pill button is NOT disabled, which only happens after the SCRT2
 * handshake completes (WidgetProvider dispatches SET_CONNECTION_READY=true).
 *
 * The widget renders inside an open shadow root (see custom-element.ts
 * `attachShadow({ mode: 'open' })`), so raw `querySelector` from the host
 * element misses the pill buttons. We go through `shadowRoot`.
 */
const pillReadyPredicate = () => {
    const widget = document.querySelector('inline-agent-widget')
    if (!widget || !widget.shadowRoot) return false
    const buttons = widget.shadowRoot.querySelectorAll('button.pill')
    if (buttons.length === 0) return false
    return Array.from(buttons).some((b) => !b.disabled)
}

/**
 * Install a request interceptor to capture the outbound sendMessage POST to
 * SCRT2 at /iamessage/api/v2/conversation/<convId>/message. We assert the body
 * contains the inline-widget product-context marker — proof that
 * withProductContext() wrapping still fires on pill click.
 *
 * We allow enough headroom to cover both a cold handshake (SCRT2 /token + SSE
 * handshake + createConversation) and the pill click + navigation that preceded
 * it. Hence HANDSHAKE_TIMEOUT_MS * 2 plus a small cushion.
 */
async function captureFirstMessagePost(page) {
    return page.waitForRequest(
        (req) =>
            req.method() === 'POST' &&
            /\/iamessage\/api\/v2\/conversation\/[^/]+\/message(\?|$)/.test(req.url()),
        {timeout: HANDSHAKE_TIMEOUT_MS * 2 + 10_000}
    )
}

// -----------------------------------------------------------------------------
// Spec
// -----------------------------------------------------------------------------

test.describe('Inline PDP Ask Assistant — pills end-to-end', () => {
    let pillProducts // [{id, questions}, …] from SCAPI, or null if discovery failed

    test.beforeAll(async ({request}) => {
        pillProducts = await discoverPillProducts(request)
        if (pillProducts && pillProducts.length === 0) {
            test.skip(
                true,
                `No products in [${CANDIDATE_PRODUCT_IDS.join(', ')}] have c_pdpQuestions set — ` +
                    'publish via Content Studio or override INLINE_PDP_CANDIDATE_IDS'
            )
        }
    })

    test('Pills: land → wait ready → click → answer', async ({page}) => {
        test.setTimeout(90_000)

        // 1 — Pick the product. If SCAPI discovery worked, use the first
        // product it confirmed has c_pdpQuestions. Otherwise fall back to the
        // first candidate id and hope the storefront has it.
        const chosen =
            pillProducts && pillProducts.length > 0
                ? pillProducts[0]
                : {id: CANDIDATE_PRODUCT_IDS[0], questions: null}
        const pdpUrl = `${config.RETAIL_APP_HOME.replace(/\/$/, '')}/${LOCALE_PATH}/product/${chosen.id}`

        // Set up the SCRT2 sendMessage interceptor BEFORE navigation so we
        // don't miss it.
        const messagePromise = captureFirstMessagePost(page)

        // 2 — Navigate to the PDP.
        await page.goto(pdpUrl, {waitUntil: 'domcontentloaded'})

        // 3 — Wait for the widget custom element to attach.
        const widget = await awaitWidget(page)

        // 4 — Wait for the SCRT2 handshake to complete AND pills to be
        //     clickable. Readiness is observable only via the disabled
        //     attribute flipping on the pill buttons (public DOM) — we don't
        //     reach into the React state.
        await page.waitForFunction(pillReadyPredicate, undefined, {
            timeout: HANDSHAKE_TIMEOUT_MS,
            polling: 100
        })

        // 5 — Pick a random enabled pill, capture its text (for the marker
        //     assertion later), click.
        const {button: pill, count: pillCount, idx} = await pickRandomPillButton(widget)
        const pillText = (await pill.innerText()).trim()
        // Guard against empty-text pills (shouldn't happen but let's be loud).
        expect(pillText.length, `Pill #${idx}/${pillCount} should have non-empty text`).toBeGreaterThan(0)
        // Hover first — matches the real-user handshake-warming path, and is a
        // safe no-op since the handshake has already completed above.
        await pill.hover()
        await pill.click()

        // 6 — Assert the outbound SCRT2 sendMessage POST carries the product-
        //     context marker + the exact pill text. This is the single tightest
        //     assertion that proves PR-A + PR-B are wired end-to-end:
        //     * PR-B put the right pills on the page (SCAPI → attribute)
        //     * PR-A sent the clicked pill through sendMessage with
        //       withProductContext() wrapping that marker
        //     Body shape (see sdk/client.ts sendMessage):
        //       { message: { id, messageType: 'StaticContentMessage',
        //         staticContent: { formatType: 'Text', text } },
        //         esDeveloperName }
        const req = await messagePromise
        const postBody = req.postDataJSON() || JSON.parse(req.postData() || '{}')
        const sentText = postBody?.message?.staticContent?.text || ''
        expect(sentText, 'Outbound message text should contain the inline-widget marker').toMatch(
            new RegExp(`\\(Viewing product details for inline-widget:\\s*${chosen.id}\\)`)
        )
        expect(sentText, 'Outbound message text should contain the pill question').toContain(pillText)

        // 7 — Wait for the user bubble to render (immediate — ASK_QUESTION
        //     dispatches synchronously inside sendMessage).
        const userBubble = widget.locator('.query', {hasText: pillText})
        await userBubble.waitFor({state: 'visible', timeout: 2_000})

        // 8 — Wait for the agent's answer to stream in. We allow either the
        //     streaming container or the final answer container to count.
        //     Final answer has role="log" with aria-live="polite" and no
        //     aria-busy; the streaming one has aria-busy="true". Both render
        //     Markdown as text content.
        const anyAnswer = widget.locator('.answer').filter({hasNotText: pillText}).first()
        await anyAnswer.waitFor({state: 'visible', timeout: ANSWER_TIMEOUT_MS})

        // Poll for substantive content — streaming can start with ~5 chars
        // and grow. We don't assert exact wording (LLM is non-deterministic);
        // we just want a non-trivial answer. 20 chars = "yes, these fit well."
        await expect
            .poll(async () => (await anyAnswer.innerText()).trim().length, {
                timeout: ANSWER_TIMEOUT_MS,
                intervals: [200, 400, 800]
            })
            .toBeGreaterThanOrEqual(MIN_ANSWER_LEN)

        // 9 — Verify the pills are now hidden (hasEngaged === true in reducer:
        //     lastQuestion + answer are both set, so <QuestionPills> returns null).
        await expect(widget.locator('button.pill')).toHaveCount(0)
    })

    test('Pills do NOT render for a product without c_pdpQuestions', async ({page, request}) => {
        test.setTimeout(60_000)

        // Find a candidate id that SCAPI says does NOT have c_pdpQuestions.
        // Fall back to a known-stale id if discovery failed.
        const token = await mintSlasGuestToken(request)
        let productWithoutPills = null
        if (token) {
            const url =
                `${SCAPI_BASE}/product/shopper-products/v1/organizations/${SCAPI_ORG}` +
                `/products?siteId=${SCAPI_SITE}&ids=${encodeURIComponent(CANDIDATE_PRODUCT_IDS.join(','))}`
            try {
                const resp = await request.get(url, {
                    headers: {authorization: `Bearer ${token}`}
                })
                if (resp.ok()) {
                    const data = (await resp.json())?.data || []
                    for (const p of data) {
                        const raw = p?.c_pdpQuestions
                        const hasPills =
                            Array.isArray(raw) ||
                            (typeof raw === 'string' && raw.trim().length > 0)
                        if (!hasPills && p?.id) {
                            productWithoutPills = p.id
                            break
                        }
                    }
                }
            } catch (_) {
                // ignore
            }
        }
        if (!productWithoutPills) {
            test.skip(
                true,
                'Could not find a product WITHOUT c_pdpQuestions in the candidate list — override INLINE_PDP_CANDIDATE_IDS'
            )
        }

        const pdpUrl = `${config.RETAIL_APP_HOME.replace(/\/$/, '')}/${LOCALE_PATH}/product/${productWithoutPills}`
        await page.goto(pdpUrl, {waitUntil: 'domcontentloaded'})

        const widget = await awaitWidget(page)

        // The widget mounts (the Ask-Assistant input is still useful without pills).
        // But the <ul class="pills"> container should never render, because
        // QuestionPills returns null when state.pdpQuestions.length === 0.
        // Give the attribute-sync effect 2s to run (it never dispatches here).
        await page.waitForTimeout(2_000)
        await expect(widget.locator('button.pill')).toHaveCount(0)
        await expect(widget.locator('ul.pills')).toHaveCount(0)

        // The text input should still render — the widget as a whole is live.
        await expect(widget.locator('textarea.composer-input')).toBeVisible()
    })
})
