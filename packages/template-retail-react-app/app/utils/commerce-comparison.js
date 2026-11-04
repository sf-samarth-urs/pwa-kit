/*
 * Copyright (c) 2026, Salesforce, Inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import {adaptComparisonResponse} from '@salesforce/retail-react-app/app/pages/compare/adapter'

const UPDATE_EVENT = 'commerce:comparison-update'
const snapshots = new Map()
const streamTimers = new Map()
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
        (snapshot.products.length < 2 && !snapshot.isStreaming && !snapshot.streamFailed) ||
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

const publish = (scope, snapshot, persist = true) => {
    if (snapshot) snapshots.set(scope, snapshot)
    else snapshots.delete(scope)
    try {
        if (snapshot && persist)
            window.sessionStorage.setItem(storageKey(scope), JSON.stringify(snapshot))
        else window.sessionStorage.removeItem(storageKey(scope))
    } catch {
        // The active page still updates when browser storage is unavailable.
    }
    window.dispatchEvent(new CustomEvent(UPDATE_EVENT, {detail: {scope}}))
}

export const receiveComparison = (scope, response) => {
    if (typeof window === 'undefined' || !response?.conversationId || !response.messageId)
        return false
    const previous = readComparison(scope)
    if (response.isStreaming && previous?.seenMessageIds?.includes(response.messageId)) return false
    let comparison
    let payload
    try {
        payload = JSON.parse(response.content)
        comparison = adaptComparisonResponse(payload, response.requestText)
    } catch {
        if (response.isStreaming) return false
    }
    const isCompareRequest =
        typeof response.requestText === 'string' &&
        /\b(compare|comparison|versus|vs)\b/i.test(response.requestText)
    if (response.isStreaming) {
        if (!comparison && !isCompareRequest) return false
        const sameStream =
            previous?.isStreaming &&
            previous.messageId === response.messageId &&
            previous.conversationId === response.conversationId
        const introduction = Array.isArray(payload?.response)
            ? payload.response
                  .filter(
                      (block) =>
                          block?.type === 'markdown' && typeof block.data?.content === 'string'
                  )
                  .map((block) => block.data.content)
                  .join('\n\n')
            : ''
        publish(
            scope,
            {
                ...(comparison || {products: [], rows: [], introduction, advice: ''}),
                isStreaming: true,
                conversationId: response.conversationId,
                messageId: response.messageId,
                seenMessageIds:
                    previous?.conversationId === response.conversationId
                        ? previous.seenMessageIds || []
                        : [],
                receivedAt: Date.now()
            },
            false
        )
        window.clearTimeout(streamTimers.get(scope))
        streamTimers.set(
            scope,
            window.setTimeout(() => {
                const pending = readComparison(scope)
                if (pending?.isStreaming && pending.messageId === response.messageId)
                    publish(scope, {...pending, isStreaming: false, streamFailed: true}, false)
                streamTimers.delete(scope)
            }, 60000)
        )
        return !sameStream
    }
    window.clearTimeout(streamTimers.get(scope))
    streamTimers.delete(scope)
    if (!comparison) {
        if (previous?.isStreaming && previous.conversationId === response.conversationId)
            publish(scope, {...previous, isStreaming: false, streamFailed: true}, false)
        return false
    }
    const seen =
        previous?.conversationId === response.conversationId ? previous.seenMessageIds || [] : []
    if (seen.includes(response.messageId)) return false
    publish(scope, {
        ...comparison,
        isStreaming: false,
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
        window.clearTimeout(streamTimers.get(scope))
        streamTimers.delete(scope)
        publish(scope, null)
    }
}
