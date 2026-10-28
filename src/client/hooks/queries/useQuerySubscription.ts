/**
 * Subscription for a query hook: watch the hook's server queries for data
 * changes and refetch through the hook's own refetch when they change.
 *
 * Shared by the single, multi, funnel, flow and retention hooks, so a
 * `useCubeQuery(…, { subscribe: true })` call and a portlet with refresh on go
 * through the same path: one `/refresh-keys` call per tick for the page (the
 * client's `RefreshKeyCoordinator`), a refetch only for queries whose key
 * changed, and an interval refetch with max-age when keys are unavailable.
 */

import { useEffect, useRef, useState } from 'react'
import { useCubeApi } from '../../providers/CubeApiProvider.js'
import { useCubeFeatures } from '../../providers/CubeFeaturesProvider.js'
import type { CubeQuery } from '../../types.js'
import type { MaxAgeOptions } from '../../client/maxAge.js'
import { stableStringify } from '../../shared/queryKey.js'
import { resolveSubscribeIntervalSeconds, scheduleSubscription, type SubscribeOption } from '../../client/subscription.js'

export type { SubscribeOption }

export interface UseQuerySubscriptionParams {
  /** The queries the hook sends to the server, or null when it has none yet */
  queries: CubeQuery[] | null
  subscribe: SubscribeOption | undefined
  /** Whether the hook is currently allowed to fetch (not skipped, disabled or in manual mode) */
  active: boolean
  /** The hook's refetch */
  refetch: (options?: MaxAgeOptions) => void
}

export interface QuerySubscriptionState {
  /** When the server last confirmed this hook's keys (ISO), while subscribed */
  checkedAt: string | undefined
}

export function useQuerySubscription({
  queries,
  subscribe,
  active,
  refetch
}: UseQuerySubscriptionParams): QuerySubscriptionState {
  const { cubeApi } = useCubeApi()
  const { features } = useCubeFeatures()
  const [checkedAt, setCheckedAt] = useState<string | undefined>(undefined)

  // Latest refetch, so a new callback identity does not re-register the watch
  const refetchRef = useRef(refetch)
  useEffect(() => {
    refetchRef.current = refetch
  }, [refetch])

  const floor = resolveSubscribeIntervalSeconds(features.refresh?.minIntervalSeconds)
  const requested = typeof subscribe === 'object' ? subscribe.intervalSeconds : undefined
  const intervalSeconds = requested !== undefined && Number.isFinite(requested) && requested > 0
    ? Math.max(Math.ceil(requested), floor)
    : floor
  const enabled = Boolean(subscribe) && active && !!queries && queries.length > 0
  const queriesKey = enabled ? stableStringify(queries) : null

  // The queries as of the last render; `queriesKey` says when they changed
  const queriesRef = useRef(queries)
  useEffect(() => {
    queriesRef.current = queries
  }, [queries])

  useEffect(() => {
    const watched = queriesRef.current
    if (!queriesKey || !watched) return
    const stop = scheduleSubscription(
      cubeApi,
      watched,
      intervalSeconds,
      options => refetchRef.current(options),
      at => setCheckedAt(new Date(at).toISOString())
    )
    return stop
  }, [cubeApi, queriesKey, intervalSeconds])

  return { checkedAt: enabled ? checkedAt : undefined }
}
