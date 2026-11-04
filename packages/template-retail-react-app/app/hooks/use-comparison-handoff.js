/*
 * Copyright (c) 2026, Salesforce, Inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import {useCallback, useRef} from 'react'
import {useLocation} from 'react-router-dom'
import useNavigation from '@salesforce/retail-react-app/app/hooks/use-navigation'
import useMultiSite from '@salesforce/retail-react-app/app/hooks/use-multi-site'
import {
    comparisonScope,
    receiveComparison,
    reconcileComparisonSession
} from '@salesforce/retail-react-app/app/utils/commerce-comparison'

export const useComparisonHandoff = (config) => {
    const {site} = useMultiSite()
    const navigate = useNavigation()
    const location = useLocation()
    const locationRef = useRef(location)
    locationRef.current = location
    const scope = comparisonScope(config, site?.id)
    const enabled = config.cc_enableComparisonPage === 'true'
    const onAgentResponse = useCallback(
        (response) => {
            if (!enabled || !receiveComparison(scope, response)) return
            if (!window.matchMedia('(min-width: 62em)').matches) return
            const onCompare = /\/compare\/?$/.test(locationRef.current.pathname)
            navigate('/compare', onCompare ? 'replace' : 'push')
        },
        [enabled, scope, navigate]
    )
    const onSessionUpdate = useCallback(
        (update) => {
            if (enabled) reconcileComparisonSession(scope, update)
        },
        [enabled, scope]
    )
    return {onAgentResponse, onSessionUpdate}
}
