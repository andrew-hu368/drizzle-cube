/**
 * No-op suppression by result fingerprint.
 *
 * The server stamps every result with a fingerprint, a hash of its rows. When a
 * refetch comes back with the same fingerprint as the data already shown, the
 * hooks keep the previous data (the same object), so derived chart data and
 * charts do not re-render or re-animate. A result without a fingerprint (an
 * older server) is always taken as new.
 */

/**
 * `structuralSharing` for the query hooks, whose data is a result set, a record
 * with a `fingerprint` field, or a multi-query record of `resultSets`.
 */
export function keepUnchangedResult(previous: unknown, next: unknown): unknown {
  const fingerprint = fingerprintOf(previous)
  return fingerprint !== undefined && fingerprint === fingerprintOf(next) ? previous : next
}

function fingerprintOf(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  if ('fingerprint' in data) {
    const value: unknown = typeof data.fingerprint === 'function' ? data.fingerprint() : data.fingerprint
    return typeof value === 'string' ? value : undefined
  }
  if ('resultSets' in data && Array.isArray(data.resultSets) && data.resultSets.length > 0) {
    const parts = data.resultSets.map(fingerprintOf)
    return parts.every(part => part !== undefined) ? parts.join('|') : undefined
  }
  return undefined
}
