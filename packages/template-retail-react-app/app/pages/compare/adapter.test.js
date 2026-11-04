/*
 * Copyright (c) 2026, Salesforce, Inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import {
    adaptComparisonResponse,
    safeWebUrl
} from '@salesforce/retail-react-app/app/pages/compare/adapter'
import fixture from '@salesforce/retail-react-app/app/pages/compare/trailfit-response.json'

test('maps real product facts, prose and comparison rows without inventing a winner', () => {
    const model = adaptComparisonResponse(fixture)
    expect(model.products.map(({id, price}) => ({id, price}))).toEqual([
        {id: '500500', price: 134.96},
        {id: '500600', price: 179.96}
    ])
    expect(model.advice).toContain('If you want GPS')
    expect(model.rows.find(({label}) => label === 'GPS').cells).toEqual([
        {productId: '500500', value: 'No'},
        {productId: '500600', value: 'Connected GPS'}
    ])
    expect(model.products[0].image).toMatch(/^https:\/\//)
    expect(model).not.toHaveProperty('recommendedProductId')
})

test('preserves three-product column alignment when an invalid product is skipped', () => {
    const model = adaptComparisonResponse({
        response: [
            {
                type: 'product_comparison',
                data: {
                    products: [{id: 'a'}, null, {id: 'b'}, {id: 'c'}],
                    table: [{row_name: 'GPS', values: ['Yes', 'invalid', 'No']}]
                }
            }
        ]
    })
    expect(model.rows[0].cells).toEqual([
        {productId: 'a', value: 'Yes'},
        {productId: 'b', value: 'No'},
        {productId: 'c', value: null}
    ])
})

test.each([
    null,
    {},
    {response: []},
    {
        response: [
            {
                type: 'product_comparison',
                data: {
                    products: [{id: 'a'}, {id: 'a'}]
                }
            }
        ]
    }
])('rejects absent or ambiguous comparison data: %p', (payload) => {
    expect(adaptComparisonResponse(payload)).toBeNull()
})

test('unwraps pasted URLs and excludes unsafe image sources', () => {
    expect(safeWebUrl('[photo](https://example.com/a.jpg)')).toBe('https://example.com/a.jpg')
    expect(safeWebUrl('large/a.jpg', 'https://example.com/images/')).toBe(
        'https://example.com/images/large/a.jpg'
    )
    expect(safeWebUrl('javascript:alert(1)')).toBeUndefined()
    expect(safeWebUrl('data:text/html,test')).toBeUndefined()
})
