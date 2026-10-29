/**
 * Subscription options: how often a subscribed query
 * (`useCubeQuery(query, { subscribe: true })`, `CubeClient.subscribe`, or a
 * portlet with refresh on) checks its refresh keys. The checking itself is the
 * client's `RefreshKeyCoordinator`.
 */

/** Cube.js's default refresh cadence for a subscription, in seconds. */
export const SUBSCRIBE_INTERVAL_SECONDS = 10

/**
 * A subscription's interval in whole seconds: the default 10, raised to
 * `requestedSeconds` or `minIntervalSeconds` when either is larger. Keys are
 * checked no more often than this, and it is the refetch interval when keys
 * are unavailable.
 */
export function resolveSubscribeIntervalSeconds(minIntervalSeconds?: number, requestedSeconds?: number): number {
  return Math.max(
    SUBSCRIBE_INTERVAL_SECONDS,
    wholePositiveSeconds(requestedSeconds) ?? 0,
    wholePositiveSeconds(minIntervalSeconds) ?? 0
  )
}

function wholePositiveSeconds(seconds: number | undefined): number | undefined {
  return seconds !== undefined && Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined
}

/**
 * A query hook's `subscribe` option: `true` for Cube.js's default (keys checked
 * at most every 10 seconds, floored by `features.refresh.minIntervalSeconds`),
 * or `{ intervalSeconds }` to check less often (a portlet's refresh interval).
 */
export type SubscribeOption = boolean | { intervalSeconds?: number }
