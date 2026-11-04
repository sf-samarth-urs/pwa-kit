/*
 * Copyright (c) 2026, Salesforce, Inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import {act, renderHook} from '@testing-library/react'
import {useComparisonHandoff} from '@salesforce/retail-react-app/app/hooks/use-comparison-handoff'
import fixture from '@salesforce/retail-react-app/app/pages/compare/trailfit-response.json'
const mockNavigate = jest.fn()
let mockLocation = {pathname: '/us/en-US/product/500500', search: ''}
jest.mock('@salesforce/retail-react-app/app/hooks/use-navigation', () => ({
    __esModule: true,
    default: () => mockNavigate
}))
jest.mock('@salesforce/retail-react-app/app/hooks/use-multi-site', () => ({
    __esModule: true,
    default: () => ({site: {id: 'NTO'}})
}))
jest.mock('react-router-dom', () => ({useLocation: () => mockLocation}))
const response = (id) => ({
    messageId: id,
    conversationId: 'conversation',
    content: JSON.stringify(fixture)
})

beforeEach(() => {
    mockNavigate.mockClear()
    mockLocation = {pathname: '/us/en-US/product/500500', search: ''}
    window.matchMedia = jest.fn(() => ({matches: true}))
})

test('opens the live route on desktop once and drops demo parameters on the comparison page', () => {
    const {result, rerender} = renderHook(() =>
        useComparisonHandoff({cc_enableComparisonPage: 'true', salesforceOrgId: 'hook-desktop'})
    )
    act(() => result.current.onAgentResponse(response('first')))
    expect(mockNavigate).toHaveBeenLastCalledWith('/compare', 'push')
    act(() => result.current.onAgentResponse(response('first')))
    expect(mockNavigate).toHaveBeenCalledTimes(1)
    mockLocation = {pathname: '/us/en-US/compare', search: '?demo=trailfit'}
    rerender()
    act(() => result.current.onAgentResponse(response('second')))
    expect(mockNavigate).toHaveBeenLastCalledWith('/compare', 'replace')
})

test('does not redirect mobile shoppers or disabled integrations', () => {
    window.matchMedia = jest.fn(() => ({matches: false}))
    const {result} = renderHook(() =>
        useComparisonHandoff({cc_enableComparisonPage: 'true', salesforceOrgId: 'hook-mobile'})
    )
    act(() => result.current.onAgentResponse(response('mobile')))
    const disabled = renderHook(() => useComparisonHandoff({salesforceOrgId: 'hook-disabled'}))
    act(() => disabled.result.current.onAgentResponse(response('disabled')))
    expect(mockNavigate).not.toHaveBeenCalled()
})
