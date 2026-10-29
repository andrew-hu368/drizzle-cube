/**
 * Minimal Cube client implementation
 * Replaces @cubejs-client/core with lighter implementation
 */

import type {
  CubeQuery,
  CubeApiOptions,
  CubeResultSet,
  CubeValidationIssue,
  ExplainResult,
  ExplainOptions
} from '../types.js'
import { maxAgeHeaders, refreshKeyHeaders, resolveMaxAgeSeconds, type MaxAgeOptions } from './maxAge.js'
import { resolveSubscribeIntervalSeconds, SUBSCRIBE_INTERVAL_SECONDS } from './subscription.js'
import { RefreshKeyCoordinator, type RefreshKeyResult, type RefreshKeyWatch } from './RefreshKeyCoordinator.js'

/**
 * Called with each result of a subscription, or with the error of a load that
 * failed (Cube.js `subscribe` callback shape).
 */
export type CubeSubscribeCallback = (error: Error | null, resultSet: CubeResultSet | null) => void

/** A live subscription. `unsubscribe` stops it; no callback follows. */
export interface CubeSubscription {
  unsubscribe: () => void
}

/**
 * A failed query, carrying the server's structured validation detail when it
 * sent any. A caller can then react to one dead member — dropping a column for
 * a deleted attribute, say — instead of only seeing prose.
 */
export class CubeQueryError extends Error {
  readonly status?: number
  readonly issues?: CubeValidationIssue[]

  constructor(message: string, status?: number, issues?: CubeValidationIssue[]) {
    super(message)
    this.name = 'CubeQueryError'
    this.status = status
    this.issues = issues
  }
}

/**
 * Turn a failed response into a `CubeQueryError`.
 *
 * Every endpoint parsed this the same way inline; the shape is worth having in
 * one place now that a structured `issues` array can ride along with the
 * message.
 */
async function toQueryError(response: Response, fallback: string): Promise<CubeQueryError> {
  let message = `${fallback}: ${response.status}`
  let issues: CubeValidationIssue[] | undefined

  try {
    const text = await response.text()
    try {
      const body = JSON.parse(text)
      message = body.error ? body.error : `${message} ${text}`
      if (Array.isArray(body.issues)) issues = body.issues
    } catch {
      // Not JSON — the raw text is the best detail available.
      message += ` ${text}`
    }
  } catch {
    // Body unreadable; the status alone will have to do.
  }

  return new CubeQueryError(message, response.status, issues)
}

export class CubeClient {
  private apiUrl: string
  private headers: Record<string, string>
  private credentials: 'include' | 'omit' | 'same-origin'
  private subscribeIntervalSeconds: number
  private refreshKeyCoordinator?: RefreshKeyCoordinator

  constructor(token?: string, options: CubeApiOptions = {}) {
    this.apiUrl = options.apiUrl || '/cubejs-api/v1'
    this.headers = {
      'Content-Type': 'application/json',
      ...options.headers
    }
    this.credentials = options.credentials ?? 'include'
    this.subscribeIntervalSeconds = resolveSubscribeIntervalSeconds(options.minSubscribeIntervalSeconds)

    if (token) {
      this.headers['Authorization'] = token
    }
  }

  /**
   * Load one query. `maxAgeSeconds` sends `x-cache-max-age`, so the server
   * answers from its cache only when the cached result is at most that old;
   * `bustCache: true` is max-age 0. A watched query's last refresh key goes
   * as `x-refresh-key`.
   */
  async load(query: CubeQuery, options?: MaxAgeOptions): Promise<CubeResultSet> {
    // Use GET with query parameter for standard Cube.js compatibility
    const queryString = JSON.stringify(query)
    const queryParam = encodeURIComponent(queryString)
    const url = `${this.apiUrl}/load?query=${queryParam}`

    // Build headers, adding the max-age headers when one was asked for
    const requestHeaders: Record<string, string> = {
      // Remove Content-Type for GET request
      ...Object.fromEntries(
        Object.entries(this.headers).filter(([key]) => key !== 'Content-Type')
      ),
      ...maxAgeHeaders(resolveMaxAgeSeconds(options)),
      ...refreshKeyHeaders(this.refreshKeyCoordinator?.currentKey(query))
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: requestHeaders,
      credentials: this.credentials
    })

    if (!response.ok) {
      throw await toQueryError(response, 'Cube query failed')
    }

    const result = await response.json()
    return new ResultSet(result)
  }

  /**
   * Composite refresh keys for `queries` (`POST /refresh-keys`), in order. A
   * key changes when the data of any cube the query reads changes; `null`
   * means the server could not evaluate it.
   */
  async refreshKeys(queries: CubeQuery[]): Promise<RefreshKeyResult[]> {
    const response = await fetch(`${this.apiUrl}/refresh-keys`, {
      method: 'POST',
      headers: this.headers,
      credentials: this.credentials,
      body: JSON.stringify({ queries })
    })

    if (!response.ok) {
      throw await toQueryError(response, 'Refresh keys failed')
    }

    const body: unknown = await response.json()
    const keys = typeof body === 'object' && body !== null && 'keys' in body ? body.keys : undefined
    if (!Array.isArray(keys)) throw new CubeQueryError('Refresh keys failed: malformed response')
    return keys.map((entry: unknown): RefreshKeyResult => {
      const record = typeof entry === 'object' && entry !== null ? entry : {}
      const key = 'key' in record && typeof record.key === 'string' ? record.key : null
      const checkAfter = 'checkAfterSeconds' in record ? Number(record.checkAfterSeconds) : NaN
      return { key, checkAfterSeconds: Number.isFinite(checkAfter) && checkAfter > 0 ? checkAfter : SUBSCRIBE_INTERVAL_SECONDS }
    })
  }

  /**
   * Watch queries for data changes. Checks that land together share one
   * `/refresh-keys` call across every watcher on this client. Returns a
   * function that stops watching.
   */
  watchRefreshKeys(watch: RefreshKeyWatch): () => void {
    this.refreshKeyCoordinator ??= new RefreshKeyCoordinator(queries => this.refreshKeys(queries))
    return this.refreshKeyCoordinator.watch(watch)
  }

  /**
   * Keep a query current (Cube.js `subscribe`). The callback receives the
   * initial load, then a result each time the query's data changes: the client
   * checks `/refresh-keys` (checks that land together share one call) and
   * reloads only when the query's refresh key moved, sending the new key so
   * subscribers in one security context share the reload. A reload that
   * returns the same rows (same result fingerprint) is not delivered.
   *
   * Keys are checked every 10 seconds at most (or `minSubscribeIntervalSeconds`
   * when larger), or less often when the server's `checkAfterSeconds` says so.
   * Against a server without `/refresh-keys`, or while a key cannot be
   * evaluated, it reloads on that interval with max-age equal to it instead.
   * A failed load calls back with the error and the subscription keeps going.
   * `options` apply to the initial load only.
   *
   * `unsubscribe` stops it and drops any result still in flight.
   */
  subscribe(
    query: CubeQuery,
    options: MaxAgeOptions | null | undefined,
    callback: CubeSubscribeCallback
  ): CubeSubscription {
    let active = true
    let inFlight = false
    let queued: MaxAgeOptions | undefined
    let lastFingerprint: string | undefined

    const deliver = async (loadOptions: MaxAgeOptions | undefined): Promise<void> => {
      // One load at a time, so results never arrive out of order. A change
      // that lands while a load is running reloads once that load is done:
      // the running load may predate the change.
      if (inFlight) {
        queued = loadOptions ?? {}
        return
      }
      inFlight = true
      let outcome: { error: Error | null; resultSet: CubeResultSet | null }
      try {
        outcome = { error: null, resultSet: await this.load(query, loadOptions) }
      } catch (error) {
        outcome = { error: error instanceof Error ? error : new Error(String(error)), resultSet: null }
      } finally {
        inFlight = false
      }
      if (!active) return

      // Same rows as last delivered: nothing to tell the subscriber
      const fingerprint = outcome.resultSet?.fingerprint?.()
      if (fingerprint === undefined || fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint
        callback(outcome.error, outcome.resultSet)
      }
      if (queued !== undefined) {
        const next = queued
        queued = undefined
        void deliver(next)
      }
    }

    void deliver(options ?? undefined)
    const stop = this.watchRefreshKeys({
      queries: [query],
      intervalSeconds: this.subscribeIntervalSeconds,
      onChange: refetchOptions => void deliver(refetchOptions)
    })

    return {
      unsubscribe: () => {
        active = false
        stop()
      }
    }
  }

  async meta(): Promise<any> {
    const url = `${this.apiUrl}/meta`
    
    const response = await fetch(url, {
      method: 'GET',
      headers: this.headers,
      credentials: this.credentials
    })

    if (!response.ok) {
      throw await toQueryError(response, 'Failed to fetch meta')
    }

    return response.json()
  }

  async sql(query: CubeQuery): Promise<any> {
    // Use GET with query parameter for standard Cube.js compatibility
    const queryParam = encodeURIComponent(JSON.stringify(query))
    const url = `${this.apiUrl}/sql?query=${queryParam}`
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        // Remove Content-Type for GET request
        ...Object.fromEntries(
          Object.entries(this.headers).filter(([key]) => key !== 'Content-Type')
        )
      },
      credentials: this.credentials
    })

    if (!response.ok) {
      throw await toQueryError(response, 'SQL generation failed')
    }

    return response.json()
  }

  async dryRun(query: CubeQuery): Promise<any> {
    const url = `${this.apiUrl}/dry-run`

    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      credentials: this.credentials,
      body: JSON.stringify({ query })
    })

    if (!response.ok) {
      throw await toQueryError(response, 'Dry run failed')
    }

    return response.json()
  }

  /**
   * Execute EXPLAIN on a query to get the execution plan
   * Returns normalized plan across PostgreSQL, MySQL, and SQLite
   * Accepts standard queries, funnel queries ({ funnel: {...} }), or flow queries ({ flow: {...} })
   */
  async explain(query: CubeQuery | unknown, options?: ExplainOptions): Promise<ExplainResult> {
    const url = `${this.apiUrl}/explain`

    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      credentials: this.credentials,
      body: JSON.stringify({ query, options })
    })

    if (!response.ok) {
      throw await toQueryError(response, 'Explain failed')
    }

    return response.json()
  }

  /**
   * Execute multiple queries in a single batch request
   * Used by BatchCoordinator to optimize network requests.
   * `maxAgeSeconds` applies to every query in the batch; `bustCache: true` is
   * max-age 0. Each watched query's last refresh key goes in the body as the
   * server's per-query `refreshKeys`.
   */
  async batchLoad(queries: CubeQuery[], options?: MaxAgeOptions): Promise<CubeResultSet[]> {
    const url = `${this.apiUrl}/batch`

    const requestHeaders: Record<string, string> = {
      ...this.headers,
      ...maxAgeHeaders(resolveMaxAgeSeconds(options))
    }

    const keys = queries.map(query => this.refreshKeyCoordinator?.currentKey(query) ?? null)
    const body = keys.some(key => key !== null) ? { queries, refreshKeys: keys } : { queries }

    const response = await fetch(url, {
      method: 'POST',
      headers: requestHeaders,
      credentials: this.credentials,
      body: JSON.stringify(body)
    })

    if (!response.ok) {
      throw await toQueryError(response, 'Batch query failed')
    }

    const batchResponse = await response.json()

    // batchResponse.results is an array of individual query results
    // Each result may have succeeded or failed
    return batchResponse.results.map((result: any) => {
      // If this individual query failed, create a ResultSet with error info
      if (!result.success && result.error) {
        // Create a result set that will throw when accessed
        return {
          ...new ResultSet({ data: [], annotation: {} }),
          error: result.error
        }
      }

      // Create ResultSet from successful result
      return new ResultSet(result)
    })
  }
}

/**
 * Simple ResultSet implementation
 */
class ResultSet implements CubeResultSet {
  public loadResponse: any

  constructor(loadResponse: any) {
    this.loadResponse = loadResponse
  }

  rawData(): any[] {
    // Handle new nested structure: loadResponse.results[0].data
    // Keep backward compatibility with old structure: loadResponse.data
    if (this.loadResponse.results && this.loadResponse.results[0]) {
      return this.loadResponse.results[0].data || []
    }
    return this.loadResponse.data || []
  }

  tablePivot(): any[] {
    // For pie charts and tables, return the raw data
    return this.rawData()
  }

  series(): any[] {
    // Simple series implementation
    return this.rawData()
  }

  annotation(): any {
    // Handle new nested structure: loadResponse.results[0].annotation
    // Keep backward compatibility with old structure: loadResponse.annotation
    if (this.loadResponse.results && this.loadResponse.results[0]) {
      return this.loadResponse.results[0].annotation || {}
    }
    return this.loadResponse.annotation || {}
  }

  /**
   * Rows the query would return with no limit/offset, when it asked for a
   * total. Undefined otherwise — a paginated view distinguishes "not requested"
   * from a genuine zero.
   */
  totalCount(): number | undefined {
    if (this.loadResponse.results && this.loadResponse.results[0]) {
      return this.loadResponse.results[0].total
    }
    return this.loadResponse.total
  }

  /**
   * Get cache metadata if result was served from cache
   * Returns undefined if not a cache hit
   */
  cacheInfo(): { hit: true; cachedAt: string; ttlMs: number; ttlRemainingMs: number } | undefined {
    // Handle nested structure: loadResponse.results[0].cache
    if (this.loadResponse.results && this.loadResponse.results[0]) {
      return this.loadResponse.results[0].cache
    }
    return this.loadResponse.cache
  }

  /**
   * Hash of the result rows from the server. The same rows give the same
   * fingerprint on a cache miss and a hit; undefined from an older server.
   */
  fingerprint(): string | undefined {
    const source = this.loadResponse.results?.[0] ?? this.loadResponse
    return typeof source?.fingerprint === 'string' ? source.fingerprint : undefined
  }

  /**
   * When the server sent this response (ISO string). For a cache miss that is
   * when the rows were computed; on a hit, `cacheInfo().cachedAt` is.
   */
  lastRefreshTime(): string | undefined {
    if (this.loadResponse.results && this.loadResponse.results[0]) {
      return this.loadResponse.results[0].lastRefreshTime
    }
    return this.loadResponse.lastRefreshTime
  }
}

/**
 * Factory function to create a cube client
 */
export function createCubeClient(token?: string, options: CubeApiOptions = {}): CubeClient {
  return new CubeClient(token, options)
}

// Legacy compatibility export
export function cube(token?: string, options: CubeApiOptions = {}): CubeClient {
  return createCubeClient(token, options)
}