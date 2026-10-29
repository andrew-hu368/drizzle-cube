/**
 * Result fingerprint: a hash of a result's rows (and `total`), computed once
 * per execution and stored with the cache entry. The same rows give the same
 * fingerprint whether they came from a miss or a hit, so a client can drop a
 * refetch that returned nothing new without comparing the rows itself.
 */

import type { QueryResult } from '../types/index.js'
import { strongHash } from '../cache-utils.js'

/** JSON replacer that keeps BigInt values (JSON.stringify throws on them). */
function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

export function fingerprintResult(result: Pick<QueryResult, 'data' | 'total'>): string {
  return strongHash(JSON.stringify({ data: result.data, total: result.total }, bigintSafe))
}
