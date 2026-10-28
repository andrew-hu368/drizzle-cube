/**
 * Subscription scheduling: when a subscribed query refetches.
 *
 * A subscription (`useCubeQuery(query, { subscribe: true })`,
 * `CubeClient.subscribe`, or a portlet with refresh on) keeps a query current.
 * It watches the query's refresh key through the client's
 * `RefreshKeyCoordinator` (one `/refresh-keys` call per tick for the whole
 * page) and refetches only when the key changed, sending the new key so
 * subscribers in one security context share one server execution.
 *
 * When keys are unavailable (an older server, or a cube key the server could
 * not evaluate) it refetches on its interval with max-age equal to the
 * interval instead, as Phase 0 did.
 */

import type { CubeQuery } from '../types.js'
import type { MaxAgeOptions } from './maxAge.js'
import type { RefreshKeyWatch } from './RefreshKeyCoordinator.js'

/** Cube.js's default refresh cadence for a subscription, in seconds. */
export const SUBSCRIBE_INTERVAL_SECONDS = 10

/**
 * A subscription's interval in whole seconds: the default 10, raised to
 * `minIntervalSeconds` when that is larger. Keys are checked no more often
 * than this, and it is the refetch interval when keys are unavailable.
 */
export function resolveSubscribeIntervalSeconds(minIntervalSeconds?: number): number {
  if (minIntervalSeconds === undefined || !Number.isFinite(minIntervalSeconds)) {
    return SUBSCRIBE_INTERVAL_SECONDS
  }
  return Math.max(SUBSCRIBE_INTERVAL_SECONDS, Math.ceil(minIntervalSeconds))
}

/**
 * A query hook's `subscribe` option: `true` for Cube.js's default (keys checked
 * at most every 10 seconds, floored by `features.refresh.minIntervalSeconds`),
 * or `{ intervalSeconds }` to check less often (a portlet's refresh interval).
 */
export type SubscribeOption = boolean | { intervalSeconds?: number }

/**
 * What a subscription does when it should refetch: with `refreshKey` after a
 * key change, or with `maxAgeSeconds` on the interval fallback.
 */
export type SubscriptionRefetch = (options: MaxAgeOptions) => void

/** Anything that can watch refresh keys: `CubeClient`. */
export interface RefreshKeyWatcher {
  watchRefreshKeys(watch: RefreshKeyWatch): () => void
}

/**
 * Call `refetch` whenever the subscribed queries may have new data. Returns a
 * function that stops it.
 *
 * After a change the refetch carries the query's new key; for several queries
 * (a multi-query portlet) it carries a marker made of all their keys, which
 * the caller does not send (each query's own key is attached by the client).
 */
export function scheduleSubscription(
  client: RefreshKeyWatcher,
  queries: CubeQuery[],
  intervalSeconds: number,
  refetch: SubscriptionRefetch,
  onChecked?: (checkedAt: number) => void
): () => void {
  return client.watchRefreshKeys({
    queries,
    intervalSeconds,
    onChecked,
    onChange: event => {
      if (event.type === 'fallback') {
        refetch({ maxAgeSeconds: event.maxAgeSeconds })
        return
      }
      const refreshKey = event.refreshKeys.length === 1
        ? event.refreshKeys[0] ?? undefined
        : event.refreshKeys.map(key => key ?? '').join('|')
      refetch(refreshKey === undefined ? { maxAgeSeconds: intervalSeconds } : { refreshKey })
    }
  })
}
