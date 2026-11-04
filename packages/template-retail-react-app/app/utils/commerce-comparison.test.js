/*
 * Copyright (c) 2026, Salesforce, Inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import {
    comparisonScope,
    readComparison,
    receiveComparison,
    reconcileComparisonSession,
    subscribeComparison
} from '@salesforce/retail-react-app/app/utils/commerce-comparison'
import fixture from '@salesforce/retail-react-app/app/pages/compare/trailfit-response.json'

let scope
beforeEach(() => {
    scope = `scope-${Math.random()}`
    sessionStorage.clear()
})
const response = (
    messageId = 'message-1',
    conversationId = 'conversation-1',
    payload = fixture
) => ({
    messageId,
    conversationId,
    content: JSON.stringify(payload)
})

test('publishes the real comparison and persists display data without raw credentials', () => {
    const listener = jest.fn()
    const unsubscribe = subscribeComparison(scope, listener)
    expect(receiveComparison(scope, response())).toBe(true)
    expect(listener.mock.calls[0][0].products[0].name).toBe('TrailFit Charge 2')
    const snapshot = readComparison(scope)
    expect(snapshot.conversationId).toBe('conversation-1')
    expect(JSON.parse(sessionStorage.getItem(`commerce-comparison:${scope}`))).toEqual(snapshot)
    expect(JSON.stringify(snapshot)).not.toContain('expressPaymentUrl')
    unsubscribe()
    receiveComparison(scope, response('message-2'))
    expect(listener).toHaveBeenCalledTimes(1)
})

test('ignores malformed replies and ordinary messages without replacing the comparison', () => {
    receiveComparison(scope, response())
    expect(receiveComparison(scope, {...response('bad'), content: 'not JSON'})).toBe(false)
    expect(
        receiveComparison(
            scope,
            response('plain', 'conversation-1', {
                response: [{type: 'markdown', data: {content: 'Hello'}}]
            })
        )
    ).toBe(false)
    expect(readComparison(scope).messageId).toBe('message-1')
})

test('deduplicates reconnect replays including older messages after a newer comparison', () => {
    receiveComparison(scope, response())
    receiveComparison(scope, response('message-2'))
    expect(receiveComparison(scope, response())).toBe(false)
    expect(readComparison(scope).messageId).toBe('message-2')
})

test('new comparison replies replace the visible product selection', () => {
    receiveComparison(scope, response())
    const payload = JSON.parse(JSON.stringify(fixture))
    payload.response[1].data.products[1].name = 'Another Watch'
    receiveComparison(scope, response('message-2', 'conversation-1', payload))
    expect(readComparison(scope).products[1].name).toBe('Another Watch')
})

test('clears comparison on session reset or a different conversation, and isolates sites', () => {
    receiveComparison(scope, response())
    expect(readComparison(`${scope}-other-site`)).toBeNull()
    reconcileComparisonSession(scope, {
        reason: 'resumed',
        snapshot: {conversationId: 'conversation-1'}
    })
    expect(readComparison(scope)).not.toBeNull()
    reconcileComparisonSession(scope, {
        reason: 'created',
        snapshot: {conversationId: 'conversation-2'}
    })
    expect(readComparison(scope)).toBeNull()
    receiveComparison(scope, response('new', 'conversation-2'))
    reconcileComparisonSession(scope, {reason: 'reset', snapshot: null})
    expect(readComparison(scope)).toBeNull()
})

test('updates the page even when sessionStorage is unavailable', () => {
    const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('blocked')
    })
    expect(receiveComparison(scope, response())).toBe(true)
    expect(readComparison(scope).products).toHaveLength(2)
    spy.mockRestore()
})

test('scopes snapshots by agent deployment and storefront site', () => {
    const config = {salesforceOrgId: 'org', cc_esDeveloperName: 'agent'}
    expect(comparisonScope(config, 'NTO')).not.toBe(comparisonScope(config, 'RefArch'))
})

test('streams provisional prose and products without persisting partial results, then accepts the final reply', () => {
    const progress = {
        ...response('stream'),
        isStreaming: true,
        requestText: 'Compare these watches',
        content: JSON.stringify({
            response: [{type: 'markdown', index: 0, data: {content: 'Starting the comparison'}}]
        })
    }
    expect(receiveComparison(scope, progress)).toBe(true)
    expect(readComparison(scope)).toMatchObject({
        isStreaming: true,
        products: [],
        introduction: 'Starting the comparison'
    })
    expect(sessionStorage.getItem(`commerce-comparison:${scope}`)).toBeNull()
    expect(receiveComparison(scope, {...progress, content: JSON.stringify(fixture)})).toBe(false)
    expect(readComparison(scope).products).toHaveLength(2)
    expect(readComparison(scope).isStreaming).toBe(true)
    expect(receiveComparison(scope, response('stream'))).toBe(true)
    expect(readComparison(scope).isStreaming).toBe(false)
    expect(sessionStorage.getItem(`commerce-comparison:${scope}`)).toBeTruthy()
    expect(receiveComparison(scope, progress)).toBe(false)
})

test('does not start a comparison stream for ordinary searches and finishes a failed final reply', () => {
    const progress = {
        ...response('stream-error'),
        isStreaming: true,
        requestText: 'Show me watches',
        content: JSON.stringify({response: []})
    }
    expect(receiveComparison(scope, progress)).toBe(false)
    expect(receiveComparison(scope, {...progress, requestText: 'Compare these watches'})).toBe(true)
    receiveComparison(scope, {
        ...response('stream-error'),
        content: 'Sorry, details are unavailable'
    })
    expect(readComparison(scope)).toMatchObject({isStreaming: false, streamFailed: true})
})

test('bounds an interrupted stream and clears its timer when the session resets', () => {
    jest.useFakeTimers()
    const progress = {
        ...response('timeout'),
        isStreaming: true,
        requestText: 'Compare these watches',
        content: JSON.stringify({response: []})
    }
    receiveComparison(scope, progress)
    jest.advanceTimersByTime(60000)
    expect(readComparison(scope)).toMatchObject({isStreaming: false, streamFailed: true})
    receiveComparison(scope, {...progress, messageId: 'reset'})
    reconcileComparisonSession(scope, {reason: 'reset'})
    jest.advanceTimersByTime(60000)
    expect(readComparison(scope)).toBeNull()
    jest.useRealTimers()
})
