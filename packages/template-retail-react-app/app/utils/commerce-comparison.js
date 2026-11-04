/*
 * Copyright (c) 2026, Salesforce, Inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import {adaptComparisonResponse} from '@salesforce/retail-react-app/app/pages/compare/adapter'

const UPDATE_EVENT = 'commerce:comparison-update'
const snapshots = new Map()
const MAX_AGE = 4 * 60 * 60 * 1000
const storageKey = (scope) => `commerce-comparison:${scope}`

export const comparisonScope = (config, siteId) =>
    `${config.salesforceOrgId || ''}:${
        config.cc_esDeveloperName || config.embeddedServiceName || ''
    }:${siteId || ''}`

export const readComparison = (scope) => {
    if (typeof window === 'undefined') return null
    let snapshot = snapshots.get(scope)
    if (!snapshot) {
        try {
            snapshot = JSON.parse(window.sessionStorage.getItem(storageKey(scope)))
        } catch {
            return null
        }
    }
    if (
        !snapshot ||
        !Array.isArray(snapshot.products) ||
        snapshot.products.length < 2 ||
        !Array.isArray(snapshot.rows) ||
        !Number.isFinite(snapshot.receivedAt) ||
        Date.now() - snapshot.receivedAt > MAX_AGE
    )
        return null
    return snapshot
}

export const subscribeComparison = (scope, listener) => {
    const handle = (event) => {
        if (event.detail?.scope === scope) listener(readComparison(scope))
    }
    window.addEventListener(UPDATE_EVENT, handle)
    return () => window.removeEventListener(UPDATE_EVENT, handle)
}

const publish = (scope, snapshot) => {
    if (snapshot) snapshots.set(scope, snapshot)
    else snapshots.delete(scope)
    try {
        if (snapshot) window.sessionStorage.setItem(storageKey(scope), JSON.stringify(snapshot))
        else window.sessionStorage.removeItem(storageKey(scope))
    } catch {
        // The active page still updates when browser storage is unavailable.
    }
    window.dispatchEvent(new CustomEvent(UPDATE_EVENT, {detail: {scope}}))
}

export const receiveComparison = (scope, response) => {
    if (typeof window === 'undefined' || !response?.conversationId || !response.messageId)
        return false
    let comparison
    try {
        comparison = adaptComparisonResponse(JSON.parse(response.content), response.requestText)
    } catch {
        return false
    }
    if (!comparison) return false
    const previous = readComparison(scope)
    const seen =
        previous?.conversationId === response.conversationId ? previous.seenMessageIds || [] : []
    if (seen.includes(response.messageId)) return false
    publish(scope, {
        ...comparison,
        conversationId: response.conversationId,
        messageId: response.messageId,
        seenMessageIds: [...seen, response.messageId].slice(-100),
        receivedAt: Date.now()
    })
    return true
}

export const reconcileComparisonSession = (scope, update) => {
    const previous = readComparison(scope)
    if (!previous) return
    if (
        ['ended', 'reset'].includes(update?.reason) ||
        (update?.snapshot?.conversationId &&
            update.snapshot.conversationId !== previous.conversationId)
    ) {
        publish(scope, null)
    }
}
