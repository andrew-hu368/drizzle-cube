/**
 * No-op suppression by result fingerprint.
 *
 * The server stamps every result with a fingerprint, a hash of its rows. When a
 * refetch comes back with the same fingerprint as the result already shown,
 * the hooks keep the previous rows (the same array references), so charts do
 * not re-render or re-animate. The freshness of the new response (computed-at,
 * cache info) still comes through, because the server has confirmed the rows
 * are current. A result without a fingerprint (an older server) is always
 * taken as new.
 *
 * These helpers plug into TanStack Query's `structuralSharing`, which hands
 * over the previous and the new query data as `unknown`.
 */

import type { CubeResultSet } from '../types.js'

/** Whether a value is a result set (duck-typed, as test doubles and wrappers are plain objects). */
export function isResultSet(value: unknown): value is CubeResultSet {
  return typeof value === 'object' && value !== null &&
    'rawData' in value && typeof value.rawData === 'function' &&
    'annotation' in value && typeof value.annotation === 'function'
}

/** Both fingerprints present and equal. */
export function sameFingerprint(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && a === b
}

/**
 * A result set whose rows come from one result and whose freshness comes from
 * a newer one with the same fingerprint.
 */
class FreshnessView implements CubeResultSet {
  constructor(
    readonly rowsSource: CubeResultSet,
    private readonly freshnessSource: CubeResultSet
  ) {}

  get loadResponse() {
    return this.freshnessSource.loadResponse
  }

  rawData() {
    return this.rowsSource.rawData()
  }

  tablePivot() {
    return this.rowsSource.tablePivot()
  }

  series() {
    return this.rowsSource.series()
  }

  annotation() {
    return this.rowsSource.annotation()
  }

  cacheInfo() {
    return this.freshnessSource.cacheInfo?.()
  }

  lastRefreshTime() {
    return this.freshnessSource.lastRefreshTime?.()
  }

  totalCount() {
    return this.rowsSource.totalCount?.()
  }

  fingerprint() {
    return this.freshnessSource.fingerprint?.()
  }
}

/**
 * `next`, or — when it has the same fingerprint as `previous` — a result set
 * that keeps `previous`'s rows with `next`'s freshness.
 */
export function keepRowsWhenUnchanged(previous: CubeResultSet | undefined, next: CubeResultSet): CubeResultSet {
  if (!previous || !sameFingerprint(previous.fingerprint?.(), next.fingerprint?.())) return next
  const rowsSource = previous instanceof FreshnessView ? previous.rowsSource : previous
  return new FreshnessView(rowsSource, next)
}

/** `structuralSharing` for a query whose data is one result set. */
export function shareUnchangedResultSet(previous: unknown, next: unknown): unknown {
  if (!isResultSet(next)) return next
  return keepRowsWhenUnchanged(isResultSet(previous) ? previous : undefined, next)
}

/**
 * `structuralSharing` for analysis hooks, whose data is a record of derived
 * rows plus freshness: with the same `fingerprint`, keep the previous
 * `rawData` (so derived chart data stays put) and take the rest from `next`.
 */
export function shareUnchangedRawData(previous: unknown, next: unknown): unknown {
  if (!hasFingerprintedRows(previous) || !hasFingerprintedRows(next)) return next
  if (!sameFingerprint(previous.fingerprint, next.fingerprint)) return next
  return { ...next, rawData: previous.rawData }
}

function hasFingerprintedRows(value: unknown): value is { rawData: unknown; fingerprint?: string } {
  return typeof value === 'object' && value !== null && 'rawData' in value &&
    (!('fingerprint' in value) || value.fingerprint === undefined || typeof value.fingerprint === 'string')
}
