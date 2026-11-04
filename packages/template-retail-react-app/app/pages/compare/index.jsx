/*
 * Copyright (c) 2026, Salesforce, Inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import React, {useEffect, useState} from 'react'
import PropTypes from 'prop-types'
import {useLocation} from 'react-router-dom'
import {useIntl} from 'react-intl'
import {Table, Thead, Tbody, Tr, Th, Td} from '@chakra-ui/react'
import {
    Box,
    Button,
    Flex,
    Grid,
    Heading,
    Image,
    Skeleton,
    Text
} from '@salesforce/retail-react-app/app/components/shared/ui'
import Link from '@salesforce/retail-react-app/app/components/link'
import Seo from '@salesforce/retail-react-app/app/components/seo'
import {adaptComparisonResponse} from '@salesforce/retail-react-app/app/pages/compare/adapter'
import trailfitResponse from '@salesforce/retail-react-app/app/pages/compare/trailfit-response.json'

import {getCommerceAgentConfig} from '@salesforce/retail-react-app/app/utils/config-utils'
import useMultiSite from '@salesforce/retail-react-app/app/hooks/use-multi-site'
import {
    comparisonScope,
    readComparison,
    subscribeComparison
} from '@salesforce/retail-react-app/app/utils/commerce-comparison'

const green = '#1d3b20'
const border = '#e6e1d9'

const renderEmphasis = (content) =>
    content.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).map((part, index) => {
        if (part.startsWith('**') && part.endsWith('**'))
            return <strong key={index}>{part.slice(2, -2)}</strong>
        if (part.startsWith('*') && part.endsWith('*'))
            return <em key={index}>{part.slice(1, -1)}</em>
        return part
    })

const ProductImage = ({src, name}) => {
    const [failed, setFailed] = useState(false)
    return (
        <Flex aspectRatio={1} bg="#f5f4f0" align="center" justify="center" overflow="hidden">
            {src && !failed ? (
                <Image
                    src={src}
                    alt={name}
                    width="100%"
                    height="100%"
                    objectFit="contain"
                    onError={() => setFailed(true)}
                />
            ) : (
                <Text color="gray.600" px={6} textAlign="center">
                    {name}
                </Text>
            )}
        </Flex>
    )
}
ProductImage.propTypes = {src: PropTypes.string, name: PropTypes.string.isRequired}

export const ComparisonView = ({comparison}) => {
    const intl = useIntl()
    const {products, rows, introduction, advice} = comparison
    const title = products.map((product) => product.name).join(' vs ')
    const detailsLabel = intl.formatMessage({
        id: 'compare.action.details',
        defaultMessage: 'View full details →'
    })
    const price = (product) => {
        if (product.price === undefined) return undefined
        try {
            return intl.formatNumber(product.price, {style: 'currency', currency: product.currency})
        } catch {
            return `${product.price} ${product.currency}`
        }
    }
    const columns = `repeat(${products.length}, minmax(260px, 1fr))`
    return (
        <>
            <Seo title={title} noIndex />
            <Text color={green} fontWeight="bold" fontSize="sm" letterSpacing="0.08em" mb={4}>
                {intl.formatMessage({
                    id: 'compare.eyebrow',
                    defaultMessage: '✦ AI PRODUCT COMPARISON'
                })}
            </Text>
            <Heading
                as="h1"
                fontFamily="Georgia, serif"
                fontSize={{base: '3xl', lg: '5xl'}}
                fontWeight="600"
                lineHeight="1.15"
                mb={4}
            >
                {title}
            </Heading>
            {introduction && (
                <Text color="#667085" fontSize="lg" maxWidth="900px" mb={10}>
                    {renderEmphasis(introduction)}
                </Text>
            )}
            <Box overflowX="auto" pb={2} mb={10}>
                <Grid templateColumns={columns} gap={{base: 4, lg: 7}}>
                    {products.map((product) => (
                        <Box
                            key={product.id}
                            border="1px solid"
                            borderColor={border}
                            borderRadius="24px"
                            overflow="hidden"
                        >
                            <ProductImage
                                key={product.image}
                                src={product.image}
                                name={product.name}
                            />
                            <Flex direction="column" p={{base: 5, lg: 6}} gap={3}>
                                {product.category && (
                                    <Text color="#667085" fontSize="sm" textTransform="capitalize">
                                        {product.category}
                                    </Text>
                                )}
                                <Flex justify="space-between" gap={3} align="baseline" wrap="wrap">
                                    <Heading as="h2" fontSize="xl">
                                        {product.name}
                                    </Heading>
                                    <Text fontWeight="bold" color={green} fontSize="xl">
                                        {price(product)}
                                    </Text>
                                </Flex>
                                <Text color="#667085" fontSize="sm">
                                    {product.description}
                                </Text>
                                <Button
                                    as={Link}
                                    href={`/product/${encodeURIComponent(product.id)}`}
                                    bg={green}
                                    color="white"
                                    borderRadius="full"
                                    mt={3}
                                    _hover={{bg: '#2e5132', color: 'white', textDecoration: 'none'}}
                                    aria-label={`${detailsLabel} ${product.name}`}
                                >
                                    {detailsLabel}
                                </Button>
                            </Flex>
                        </Box>
                    ))}
                </Grid>
            </Box>
            {advice && (
                <Box
                    bg="#eaf3e9"
                    border="1px solid #cee3cd"
                    borderRadius="20px"
                    p={{base: 5, lg: 7}}
                    mb={10}
                >
                    <Heading as="h2" fontSize="lg" color={green} mb={3}>
                        {intl.formatMessage({
                            id: 'compare.advice.heading',
                            defaultMessage: '✦ Find your best fit'
                        })}
                    </Heading>
                    <Text whiteSpace="pre-line" lineHeight="tall" color="#344054">
                        {renderEmphasis(advice)}
                    </Text>
                </Box>
            )}
            {comparison.detailsUnavailable && !comparison.isStreaming && (
                <Text role="status" mb={8} color="gray.600">
                    {intl.formatMessage({
                        id: 'compare.details_unavailable',
                        defaultMessage:
                            'Detailed specifications were not returned. Showing the products and summary supplied by the assistant.'
                    })}
                </Text>
            )}
            {rows.length > 0 && (
                <Box
                    overflowX="auto"
                    border="1px solid"
                    borderColor={border}
                    borderRadius="20px"
                    mb={10}
                >
                    <Table variant="unstyled" minWidth={`${220 + products.length * 240}px`}>
                        <Box
                            as="caption"
                            position="absolute"
                            width="1px"
                            height="1px"
                            overflow="hidden"
                        >
                            {intl.formatMessage({
                                id: 'compare.table.caption',
                                defaultMessage: 'Product specifications comparison'
                            })}
                        </Box>
                        <Thead bg="#f6f5f1">
                            <Tr>
                                <Th scope="col" p={5} color="#667085">
                                    {intl.formatMessage({
                                        id: 'compare.specifications',
                                        defaultMessage: 'Specifications'
                                    })}
                                </Th>
                                {products.map((product) => (
                                    <Th
                                        key={product.id}
                                        scope="col"
                                        p={5}
                                        color={green}
                                        textAlign="center"
                                        textTransform="none"
                                        fontSize="md"
                                    >
                                        {product.name}
                                    </Th>
                                ))}
                            </Tr>
                        </Thead>
                        <Tbody>
                            {rows.map((row, index) => (
                                <Tr
                                    key={`${row.label}-${index}`}
                                    borderTop="1px solid"
                                    borderColor={border}
                                >
                                    <Th scope="row" p={5} color="#667085" fontWeight="500">
                                        {row.label}
                                    </Th>
                                    {row.cells.map((cell) => (
                                        <Td
                                            key={cell.productId}
                                            p={5}
                                            textAlign="center"
                                            lineHeight="tall"
                                        >
                                            {cell.value ||
                                                intl.formatMessage({
                                                    id: 'compare.value.unavailable',
                                                    defaultMessage: 'Not specified'
                                                })}
                                        </Td>
                                    ))}
                                </Tr>
                            ))}
                        </Tbody>
                    </Table>
                </Box>
            )}
            <Grid
                templateColumns={{base: '1fr', md: `repeat(${products.length}, minmax(0, 1fr))`}}
                gap={5}
            >
                {products.map((product) => (
                    <Box
                        key={product.id}
                        p={6}
                        border="1px solid"
                        borderColor={border}
                        borderRadius="20px"
                    >
                        <Heading
                            as="h2"
                            fontSize="sm"
                            color="#667085"
                            textTransform="uppercase"
                            mb={3}
                        >
                            {product.name}
                        </Heading>
                        <Text color="#475467" lineHeight="tall" mb={5}>
                            {product.description}
                        </Text>
                        <Link
                            href={`/product/${encodeURIComponent(product.id)}`}
                            color={green}
                            fontWeight="600"
                        >
                            {intl.formatMessage(
                                {id: 'compare.action.choose', defaultMessage: 'Choose {name}'},
                                {name: product.name}
                            )}{' '}
                            →
                        </Link>
                    </Box>
                ))}
            </Grid>
        </>
    )
}
ComparisonView.propTypes = {comparison: PropTypes.object.isRequired}

const ComparePage = () => {
    const {search} = useLocation()
    const intl = useIntl()
    const isDemo = new URLSearchParams(search).get('demo') === 'trailfit'
    const {site} = useMultiSite()
    const scope = comparisonScope(getCommerceAgentConfig(), site?.id)
    const [liveComparison, setLiveComparison] = useState(null)
    useEffect(() => {
        setLiveComparison(readComparison(scope))
        return subscribeComparison(scope, setLiveComparison)
    }, [scope])
    const comparison = isDemo ? adaptComparisonResponse(trailfitResponse) : liveComparison
    return (
        <Box
            data-testid="compare-page"
            bg="white"
            color="#101828"
            px={{base: 4, md: 8}}
            py={{base: 8, lg: 12}}
        >
            <Box maxWidth="1280px" mx="auto">
                <Flex
                    as="nav"
                    aria-label={intl.formatMessage({
                        id: 'compare.breadcrumb',
                        defaultMessage: 'Breadcrumb'
                    })}
                    gap={3}
                    mb={10}
                    color="#667085"
                    fontSize="sm"
                >
                    <Link href="/">
                        {intl.formatMessage({id: 'compare.home', defaultMessage: 'Home'})}
                    </Link>
                    <Text aria-hidden="true">/</Text>
                    <Text aria-current="page">
                        {intl.formatMessage({id: 'compare.title', defaultMessage: 'Compare'})}
                    </Text>
                </Flex>
                {comparison?.isStreaming && (
                    <Text role="status" mb={4} color="gray.600">
                        {intl.formatMessage({
                            id: 'compare.streaming',
                            defaultMessage: 'Building your comparison…'
                        })}
                    </Text>
                )}
                {comparison?.streamFailed && (
                    <Text role="status" mb={4} color="gray.600">
                        {intl.formatMessage({
                            id: 'compare.stream_failed',
                            defaultMessage:
                                'The comparison could not be completed. Check the assistant’s reply or try again.'
                        })}
                    </Text>
                )}
                {comparison && comparison.products.length < 2 ? (
                    <Box aria-busy={comparison.isStreaming}>
                        <Heading as="h1" mb={6}>
                            {intl.formatMessage({id: 'compare.title', defaultMessage: 'Compare'})}
                        </Heading>
                        <Text mb={6} whiteSpace="pre-line">
                            {renderEmphasis(comparison.introduction || '')}
                        </Text>
                        {comparison.isStreaming && (
                            <Grid
                                templateColumns="repeat(2, minmax(0, 1fr))"
                                gap={6}
                                aria-hidden="true"
                            >
                                <Skeleton height="320px" borderRadius="24px" />
                                <Skeleton height="320px" borderRadius="24px" />
                            </Grid>
                        )}
                    </Box>
                ) : comparison ? (
                    <ComparisonView comparison={comparison} />
                ) : (
                    <Box py={16} textAlign="center">
                        <Seo title="Compare products" noIndex />
                        <Heading as="h1" fontFamily="Georgia, serif" mb={4}>
                            {intl.formatMessage({
                                id: 'compare.empty.heading',
                                defaultMessage: 'Find your perfect fit'
                            })}
                        </Heading>
                        <Text color="#667085" mb={8}>
                            {intl.formatMessage({
                                id: 'compare.empty.description',
                                defaultMessage:
                                    'Your product comparison will appear here when it is ready.'
                            })}
                        </Text>
                        <Button
                            as={Link}
                            href="/compare?demo=trailfit"
                            bg={green}
                            color="white"
                            borderRadius="full"
                            _hover={{bg: '#2e5132', color: 'white'}}
                        >
                            {intl.formatMessage({
                                id: 'compare.demo.action',
                                defaultMessage: 'Explore a sample comparison'
                            })}
                        </Button>
                    </Box>
                )}
            </Box>
        </Box>
    )
}
ComparePage.getTemplateName = () => 'compare'
export default ComparePage
