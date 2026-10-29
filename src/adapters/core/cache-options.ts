/**
 * Request cache headers → result-cache execution options, shared by REST
 * `/load` and `/batch`. No other endpoint reads these headers.
 *
 * - `x-cache-max-age: <seconds>` — the oldest cached result the caller will
 *   accept. A non-negative integer; anything else is ignored.
 * - `x-cache-control: no-cache` — max-age 0 (skip the read, still write).
 * - `x-refresh-key: <composite key>` — the composite key from
 *   `/refresh-keys` that triggered this refetch; scopes the result cache entry
 *   so viewers in one context share the refetch. Up to 128 characters of
 *   `[A-Za-z0-9._:-]`; anything else is ignored. On `/batch` a body
 *   `refreshKeys` array (one per query) overrides it per query.
 *
 * When both are present the smaller max-age wins (resolved by the server's
 * result cache). Neither has any effect when the semantic layer has no cache
 * provider configured.
 */

import type { ExecutionOptions } from '../../server/index.js'
import type { HeaderReader } from './security-context.js'

const NON_NEGATIVE_INTEGER = /^\d+$/

/** Parse `x-cache-max-age` (seconds) into milliseconds, or undefined when absent/invalid. */
function parseMaxAgeHeader(value: string | undefined): number | undefined {
  if (value === undefined || !NON_NEGATIVE_INTEGER.test(value.trim())) {
    return undefined
  }
  return Number(value.trim()) * 1000
}

const REFRESH_KEY = /^[A-Za-z0-9._:-]{1,128}$/

/** Parse a refresh key (header or body), or undefined when absent/invalid. */
export function parseRefreshKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return REFRESH_KEY.test(trimmed) ? trimmed : undefined
}

/** Read the request cache headers into the result-cache execution options. */
export function readCacheOptions(
  readHeader: HeaderReader
): Pick<ExecutionOptions, 'skipCache' | 'maxAgeMs' | 'refreshKey'> {
  return {
    skipCache: readHeader('x-cache-control') === 'no-cache',
    maxAgeMs: parseMaxAgeHeader(readHeader('x-cache-max-age')),
    refreshKey: parseRefreshKey(readHeader('x-refresh-key'))
  }
}
