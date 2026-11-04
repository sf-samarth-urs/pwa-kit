/*
 * Copyright (c) 2026, Salesforce, Inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

export const safeWebUrl = (value, base) => {
    if (typeof value !== 'string' || !value.trim()) return undefined
    const unwrapped = value.match(/^\[[^\]]+\]\((https?:\/\/[^)]+)\)$/)?.[1] || value
    try {
        const url = new URL(unwrapped, base)
        return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined
    } catch {
        return undefined
    }
}

const unwrapProduct = (product) =>
    product?.data && typeof product.data === 'object' && !Array.isArray(product.data)
        ? {...product.data, id: product.id || product.data.id}
        : product

export const adaptComparisonResponse = (payload, requestText) => {
    const blocks = payload?.response
    if (!Array.isArray(blocks)) return null
    let comparisonIndex = blocks.findIndex((block) => block?.type === 'product_comparison')
    const detailsUnavailable = comparisonIndex < 0
    let comparison = blocks[comparisonIndex]?.data
    if (detailsUnavailable) {
        if (
            typeof requestText !== 'string' ||
            !/\b(compare|comparison|versus|vs)\b/i.test(requestText)
        )
            return null
        const products = []
        const seen = new Set()
        blocks.forEach((block, index) => {
            let candidates = []
            if (block?.type === 'product_carousel' && Array.isArray(block.data?.products))
                candidates = block.data.products
            else if (block?.type === 'product_tile') {
                candidates = [block.data]
            }
            candidates.forEach((candidate) => {
                const product = unwrapProduct(candidate)
                if (typeof product?.id !== 'string' || !product.id.trim() || seen.has(product.id))
                    return
                if (comparisonIndex < 0) comparisonIndex = index
                seen.add(product.id)
                products.push(product)
            })
        })
        comparison = {products}
    }
    if (!Array.isArray(comparison?.products)) return null
    const entries = comparison.products
        .map((product, index) => ({product: unwrapProduct(product), index}))
        .filter(({product}) => product && typeof product.id === 'string' && product.id.trim())
    if (
        entries.length < 2 ||
        new Set(entries.map(({product}) => product.id)).size !== entries.length
    ) {
        return null
    }
    const products = entries.map(({product}) => {
        const base = safeWebUrl(product.baseUrl) || safeWebUrl(product.productPageUrl)
        const fallbackImage = product.imgGroups?.find((group) => group.viewType === 'large')
            ?.imgs?.[0]?.url
        return {
            id: product.id,
            name: product.name || product.id,
            description: product.dscr || product.description || '',
            category: product.primaryCategoryId?.replace(/[-_]/g, ' ') || '',
            image: safeWebUrl(product.imageUrl, base) || safeWebUrl(fallbackImage, base),
            price: [product.discountPrice, product.pr?.cur, product.price].find(Number.isFinite),
            currency: product.ccy || product.currencyCode || 'USD'
        }
    })
    const markdown = (slice) =>
        slice
            .filter((block) => block.type === 'markdown' && typeof block.data?.content === 'string')
            .map((block) => block.data.content)
            .join('\n\n')
    return {
        products,
        detailsUnavailable,
        introduction: markdown(blocks.slice(0, comparisonIndex)),
        advice: markdown(blocks.slice(comparisonIndex + 1)),
        rows: (Array.isArray(comparison.table) ? comparison.table : [])
            .filter((row) => typeof row?.row_name === 'string')
            .map((row) => ({
                label: row.row_name,
                cells: entries.map(({product, index}) => ({
                    productId: product.id,
                    value:
                        typeof row.values?.[index] === 'string' && row.values[index].trim()
                            ? row.values[index]
                            : null
                }))
            }))
    }
}
