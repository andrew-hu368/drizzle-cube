/**
 * Subscription for a query hook: watch the hook's server queries for data
 * changes and refetch through the hook's own refetch when they change.
 *
 * Shared by the single, multi, funnel, flow and retention hooks, so a
 * `useCubeQuery(…, { subscribe: true })` call and a portlet with refresh on go
 * through the same path: key checks batched by the client's
 * `RefreshKeyCoordinator`, a refetch only when a key changed, and an interval
 * refetch with max-age when keys are unavailable.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useCubeApi } from '../../providers/CubeApiProvider.js'
import { useCubeFeatures } from '../../providers/CubeFeaturesProvider.js'
import type { CubeQuery } from '../../types.js'
import type { MaxAgeOptions } from '../../client/maxAge.js'
import { stableStringify } from '../../shared/queryKey.js'
import { resolveSubscribeIntervalSeconds, type SubscribeOption } from '../../client/subscription.js'

export interface UseQuerySubscriptionParams {
  /** The query (or queries) the hook sends to the server, or null when it has none yet */
  queries: CubeQuery | CubeQuery[] | null
  subscribe: SubscribeOption | undefined
  /** Whether the hook is currently allowed to fetch (not skipped, disabled or in manual mode) */
  active: boolean
  /** The hook's refetch */
  refetch: (options?: MaxAgeOptions) => void
}

export interface QuerySubscriptionState {
  /**
   * When the server last confirmed this hook's keys (ISO), while subscribed. A
   * getter, so a check does not re-render: read it on a render you have anyway.
   */
  getCheckedAt: () => string | undefined
}

export function useQuerySubscription({
  queries,
  subscribe,
  active,
  refetch
}: UseQuerySubscriptionParams): QuerySubscriptionState {
  const { cubeApi } = useCubeApi()
  const { features } = useCubeFeatures()
  const checkedAtRef = useRef<number | undefined>(undefined)
  const getCheckedAt = useCallback(
    () => (checkedAtRef.current === undefined ? undefined : new Date(checkedAtRef.current).toISOString()),
    []
  )

  // Latest refetch, so a new callback identity does not re-register the watch
  const refetchRef = useRef(refetch)
  useEffect(() => {
    refetchRef.current = refetch
  }, [refetch])

  const intervalSeconds = resolveSubscribeIntervalSeconds(
    features.refresh?.minIntervalSeconds,
    typeof subscribe === 'object' ? subscribe.intervalSeconds : undefined
  )
  const watchedQueries = useMemo(
    () => (queries === null ? null : Array.isArray(queries) ? queries : [queries]),
    [queries]
  )
  const enabled = Boolean(subscribe) && active && !!watchedQueries && watchedQueries.length > 0
  const queriesKey = useMemo(
    () => (enabled ? stableStringify(watchedQueries) : null),
    [enabled, watchedQueries]
  )

  // The queries as of the last render; `queriesKey` says when they changed
  const queriesRef = useRef(watchedQueries)
  useEffect(() => {
    queriesRef.current = watchedQueries
  }, [watchedQueries])

  useEffect(() => {
    const watched = queriesRef.current
    if (!queriesKey || !watched) return
    const stop = cubeApi.watchRefreshKeys({
      queries: watched,
      intervalSeconds,
      onChange: options => refetchRef.current(options),
      onChecked: at => { checkedAtRef.current = at }
    })
    return () => {
      stop()
      checkedAtRef.current = undefined
    }
  }, [cubeApi, queriesKey, intervalSeconds])

  return { getCheckedAt }
}
