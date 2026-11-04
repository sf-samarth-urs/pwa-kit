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

test('accepts a first comparison reply with product cards but no specifications only for a compare request', () => {
    const payload = JSON.parse(JSON.stringify(fixture))
    const block = payload.response.find(({type}) => type === 'product_comparison')
    block.type = 'product_carousel'
    delete block.data.table
    expect(adaptComparisonResponse(payload)).toBeNull()
    expect(adaptComparisonResponse(payload, 'Show me winter jackets')).toBeNull()
    const model = adaptComparisonResponse(
        payload,
        'Could you compare the first two Insulated Winter Jackets from your result'
    )
    expect(model.products).toHaveLength(2)
    expect(model.rows).toEqual([])
    expect(model.detailsUnavailable).toBe(true)
    expect(model.introduction).toBeTruthy()
})

test('combines separate product tiles in one compare reply without duplicating a product', () => {
    const products = fixture.response.find(({type}) => type === 'product_comparison').data.products
    const payload = {
        response: [
            {type: 'markdown', data: {content: 'A limited comparison'}},
            {type: 'product_tile', data: {id: products[0].id, data: products[0]}},
            {type: 'product_tile', data: {id: products[1].id, data: products[1]}},
            {type: 'product_carousel', data: {products: [products[0]]}}
        ]
    }
    expect(
        adaptComparisonResponse(payload, 'Compare these watches').products.map((p) => p.id)
    ).toEqual(['500500', '500600'])
    expect(adaptComparisonResponse(payload, 'Show me watches')).toBeNull()
})

test('retains the names and prices nested in product-tile data', () => {
    const products = fixture.response.find(({type}) => type === 'product_comparison').data.products
    const payload = {
        response: products.map((product) => ({
            type: 'product_tile',
            data: {id: product.id, data: product}
        }))
    }
    const model = adaptComparisonResponse(payload, 'Compare these watches')
    expect(model.products[0].name).toBe('TrailFit Charge 2')
    expect(model.products[0].price).toBe(134.96)
    expect(model.products[0].image).toMatch(/^https:/)
})

test('maps the SDK carousel contract including nested names, images and expanded prices', () => {
    const payload = {
        response: [
            {
                type: 'product_carousel',
                data: {
                    products: [
                        {
                            id: '4070962BB3',
                            data: {
                                name: 'Mountain 25 Tent',
                                description: 'Mountain tent',
                                imageUrl: 'https://images.example/mountain.jpg',
                                price: 689.95,
                                currencyCode: 'USD'
                            }
                        },
                        {
                            id: '4070960BB3',
                            data: {
                                name: 'Bastion 4 Tent',
                                imageUrl: 'https://images.example/bastion.jpg',
                                price: 949.95,
                                discountPrice: 899,
                                currencyCode: 'EUR'
                            }
                        }
                    ]
                }
            }
        ]
    }
    const model = adaptComparisonResponse(
        payload,
        'Could you compare the 2nd and 4th tents from your results'
    )
    expect(model.products[0]).toMatchObject({
        id: '4070962BB3',
        name: 'Mountain 25 Tent',
        description: 'Mountain tent',
        image: 'https://images.example/mountain.jpg',
        price: 689.95,
        currency: 'USD'
    })
    expect(model.products[1]).toMatchObject({
        id: '4070960BB3',
        name: 'Bastion 4 Tent',
        image: 'https://images.example/bastion.jpg',
        price: 899,
        currency: 'EUR'
    })
    expect(model.detailsUnavailable).toBe(true)
    expect(model.rows).toEqual([])
    expect(adaptComparisonResponse(payload, 'Show me tents')).toBeNull()
})
