/*
 * Copyright (c) 2026, Salesforce, Inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import React from 'react'
import {render, screen, within} from '@testing-library/react'
import {IntlProvider} from 'react-intl'
import {MemoryRouter} from 'react-router-dom'
import {ChakraProvider} from '@chakra-ui/react'
import ComparePage, {ComparisonView} from '@salesforce/retail-react-app/app/pages/compare'
import {adaptComparisonResponse} from '@salesforce/retail-react-app/app/pages/compare/adapter'
import {act} from '@testing-library/react'
import {
    receiveComparison,
    reconcileComparisonSession,
    comparisonScope
} from '@salesforce/retail-react-app/app/utils/commerce-comparison'
import {getCommerceAgentConfig} from '@salesforce/retail-react-app/app/utils/config-utils'
import fixture from '@salesforce/retail-react-app/app/pages/compare/trailfit-response.json'

jest.mock('@salesforce/retail-react-app/app/hooks/use-multi-site', () => ({
    __esModule: true,
    default: () => ({site: {id: 'NTO'}, buildUrl: (path) => `/us/en-US${path}`})
}))

const renderPage = (element, path = '/compare') =>
    render(
        <MemoryRouter initialEntries={[path]}>
            <IntlProvider locale="en-US" defaultLocale="en-US">
                <ChakraProvider>{element}</ChakraProvider>
            </IntlProvider>
        </MemoryRouter>
    )

test('renders the fixture with accurate table values and local PDP links', () => {
    renderPage(<ComparePage />, '/compare?demo=trailfit')
    expect(screen.getByRole('heading', {level: 1})).toHaveTextContent(
        'TrailFit Charge 2 vs TrailFit Blaze'
    )
    const table = screen.getByRole('table', {name: 'Product specifications comparison'})
    expect(within(table).getByText('Connected GPS')).toBeInTheDocument()
    expect(
        screen.getByRole('link', {name: /View full details.*TrailFit Charge 2/})
    ).toHaveAttribute('href', '/us/en-US/product/500500')
    expect(screen.queryByText('Top pick')).not.toBeInTheDocument()
    expect(screen.queryByText(/reviews/)).not.toBeInTheDocument()
})

test('does not silently present demo data as a live comparison', () => {
    renderPage(<ComparePage />)
    expect(screen.getByRole('heading', {name: 'Find your perfect fit'})).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.getByRole('link', {name: 'Explore a sample comparison'})).toHaveAttribute(
        'href',
        '/us/en-US/compare?demo=trailfit'
    )
})

test('renders a third product and labels missing cells as unspecified', () => {
    const payload = JSON.parse(JSON.stringify(fixture))
    const data = payload.response.find(({type}) => type === 'product_comparison').data
    data.products.push({...data.products[0], id: 'third-watch', name: 'Third Watch'})
    renderPage(<ComparisonView comparison={adaptComparisonResponse(payload)} />)
    const table = screen.getByRole('table')
    expect(within(table).getAllByRole('columnheader')).toHaveLength(4)
    expect(within(table).getByRole('columnheader', {name: 'Third Watch'})).toBeInTheDocument()
    expect(within(table).getAllByText('Not specified')).not.toHaveLength(0)
})

test('live responses replace the empty page and later comparisons update in place', () => {
    const scope = comparisonScope(getCommerceAgentConfig(), 'NTO')
    reconcileComparisonSession(scope, {reason: 'reset'})
    renderPage(<ComparePage />)
    const payload = JSON.parse(JSON.stringify(fixture))
    payload.response[1].data.products[1].name = 'Live Watch'
    act(() =>
        receiveComparison(scope, {
            conversationId: 'live-test',
            messageId: 'live-1',
            content: JSON.stringify(payload)
        })
    )
    expect(screen.getByRole('heading', {level: 1})).toHaveTextContent('Live Watch')
    payload.response[1].data.products[1].name = 'Updated Watch'
    act(() =>
        receiveComparison(scope, {
            conversationId: 'live-test',
            messageId: 'live-2',
            content: JSON.stringify(payload)
        })
    )
    expect(screen.getByRole('heading', {level: 1})).toHaveTextContent('Updated Watch')
    act(() => reconcileComparisonSession(scope, {reason: 'ended'}))
    expect(screen.getByRole('heading', {name: 'Find your perfect fit'})).toBeInTheDocument()
})

test('shows a limited comparison explicitly when specifications were not returned', () => {
    const payload = JSON.parse(JSON.stringify(fixture))
    const block = payload.response.find(({type}) => type === 'product_comparison')
    block.type = 'product_carousel'
    delete block.data.table
    renderPage(
        <ComparisonView comparison={adaptComparisonResponse(payload, 'Compare these jackets')} />
    )
    expect(screen.getByRole('status')).toHaveTextContent(
        'Detailed specifications were not returned'
    )
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', {level: 1})).toHaveTextContent(
        'TrailFit Charge 2 vs TrailFit Blaze'
    )
})

test('shows streamed prose and skeletons before products arrive', () => {
    const scope = comparisonScope(getCommerceAgentConfig(), 'NTO')
    reconcileComparisonSession(scope, {reason: 'reset'})
    renderPage(<ComparePage />)
    act(() =>
        receiveComparison(scope, {
            conversationId: 'stream-view',
            messageId: 'stream-view',
            requestText: 'Compare these watches',
            isStreaming: true,
            content: JSON.stringify({
                response: [{type: 'markdown', data: {content: 'Comparing the watches now'}}]
            })
        })
    )
    expect(screen.getByRole('status')).toHaveTextContent('Building your comparison')
    expect(screen.getByText('Comparing the watches now')).toBeInTheDocument()
    act(() =>
        receiveComparison(scope, {
            conversationId: 'stream-view',
            messageId: 'stream-view',
            content: JSON.stringify(fixture)
        })
    )
    expect(screen.queryByText('Building your comparison…')).not.toBeInTheDocument()
    expect(screen.getByRole('table')).toBeInTheDocument()
    act(() => reconcileComparisonSession(scope, {reason: 'reset'}))
})
