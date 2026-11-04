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
import fixture from '@salesforce/retail-react-app/app/pages/compare/trailfit-response.json'

jest.mock('@salesforce/retail-react-app/app/hooks/use-multi-site', () => ({
    __esModule: true,
    default: () => ({buildUrl: (path) => `/us/en-US${path}`})
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
