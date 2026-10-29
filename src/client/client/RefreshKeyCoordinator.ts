/**
 * RefreshKeyCoordinator: change detection for every subscription on a client.
 *
 * Each watcher (a `useCubeQuery(…, { subscribe })` hook, a
 * `CubeClient.subscribe` call, a portlet with refresh on) checks its queries'
 * refresh keys once when it starts, then on its own interval (raised to the
 * server's `checkAfterSeconds`). Checks are aligned to the clock, so watchers
 * with the same interval check together, and checks that land together share
 * one `POST /refresh-keys` call. A watcher refetches when one of its keys
 * differs from the last one seen. Keys are remembered per query, so a watcher
 * that stops and starts again (a paused portlet) refetches on resume only if
 * the data changed meanwhile.
 *
 * A `null` key (the server could not evaluate a cube key) or a failed call (an
 * older server without `/refresh-keys`) falls back to an interval refetch with
 * max-age equal to the interval, as before refresh keys existed.
 */

import type { CubeQuery } from '../types.js'
import type { MaxAgeOptions } from './maxAge.js'
import { stableStringify } from '../shared/queryKey.js'

/** One query's composite key from `/refresh-keys`. */
export interface RefreshKeyResult {
  key: string | null
  checkAfterSeconds: number
}

/** Fetches the composite keys of `queries`, in order. */
export type RefreshKeyFetcher = (queries: CubeQuery[]) => Promise<RefreshKeyResult[]>

export interface RefreshKeyWatch {
  queries: CubeQuery[]
  /** Check at most this often, in seconds; also the fallback refetch's max-age */
  intervalSeconds: number
  /**
   * Refetch: with `refreshKey` (the watcher's current keys) after a change,
   * which cancels a fetch already in flight; with `maxAgeSeconds` on the fallback.
   */
  onChange: (options: MaxAgeOptions) => void
  /** Called after every check, with the check time (ms). */
  onChecked?: (checkedAt: number) => void
}

/** Checks that land within this many ms share one call. */
const BATCH_DELAY_MS = 10
/** Remembered keys of unwatched queries are dropped beyond this many. */
const MAX_REMEMBERED_QUERIES = 500

interface PendingKey {
  query: CubeQuery
  promise: Promise<RefreshKeyResult>
  resolve: (result: RefreshKeyResult) => void
  reject: (error: unknown) => void
}

export class RefreshKeyCoordinator {
  private readonly fetcher: RefreshKeyFetcher
  /** Last key seen per query, and how many watchers watch it */
  private readonly keys = new Map<string, { key?: string; watchers: number }>()
  private readonly pending = new Map<string, PendingKey>()
  private flushTimer: ReturnType<typeof setTimeout> | undefined

  constructor(fetcher: RefreshKeyFetcher) {
    this.fetcher = fetcher
  }

  /** The last key seen for a query that is being watched, if any. */
  currentKey(query: CubeQuery): string | undefined {
    const entry = this.keys.get(stableStringify(query))
    return entry && entry.watchers > 0 ? entry.key : undefined
  }

  /** Watch queries for changes. Returns a function that stops watching. */
  watch({ queries, intervalSeconds, onChange, onChecked }: RefreshKeyWatch): () => void {
    const ids = queries.map(stableStringify)
    const entries = ids.map(id => {
      const entry = this.keys.get(id) ?? { watchers: 0 }
      entry.watchers++
      this.keys.set(id, entry)
      return entry
    })
    let seen = entries.map(entry => entry.key)
    let first = true
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const check = async (): Promise<void> => {
      const results = await Promise.all(queries.map((query, index) => this.request(ids[index], query))).catch(() => undefined)
      if (stopped) return
      const everyMs = Math.max(1, intervalSeconds, ...(results ?? []).map(result => result.checkAfterSeconds)) * 1000
      const keys = results?.map(result => result.key)

      if (keys && keys.every((key): key is string => key !== null)) {
        // The first key seen for a query is only recorded: it has just loaded.
        // Keys are stored first, so the refetch sends the new ones.
        const changed = keys.some((key, index) => seen[index] !== undefined && seen[index] !== key)
        keys.forEach((key, index) => { entries[index].key = key })
        seen = keys
        if (changed) onChange({ refreshKey: keys.join('|') })
      } else if (!first) {
        onChange({ maxAgeSeconds: everyMs / 1000 })
      }
      first = false
      onChecked?.(Date.now())
      timer = setTimeout(() => void check(), everyMs - (Date.now() % everyMs))
    }
    void check()

    return () => {
      if (stopped) return
      stopped = true
      clearTimeout(timer)
      entries.forEach(entry => { entry.watchers-- })
      this.pruneRemembered()
    }
  }

  /** One query's key, from the next shared `/refresh-keys` call. */
  private request(id: string, query: CubeQuery): Promise<RefreshKeyResult> {
    let pending = this.pending.get(id)
    if (!pending) {
      let resolve: PendingKey['resolve'] = () => {}
      let reject: PendingKey['reject'] = () => {}
      const promise = new Promise<RefreshKeyResult>((res, rej) => { resolve = res; reject = rej })
      pending = { query, promise, resolve, reject }
      this.pending.set(id, pending)
    }
    this.flushTimer ??= setTimeout(() => void this.flush(), BATCH_DELAY_MS)
    return pending.promise
  }

  private async flush(): Promise<void> {
    const batch = Array.from(this.pending.values())
    this.pending.clear()
    this.flushTimer = undefined
    try {
      const results = await this.fetcher(batch.map(pending => pending.query))
      if (!Array.isArray(results) || results.length !== batch.length) throw new Error('Malformed refresh keys')
      batch.forEach((pending, index) => pending.resolve(results[index]))
    } catch (error) {
      batch.forEach(pending => pending.reject(error))
    }
  }

  /** Forget the oldest unwatched queries once too many are remembered. */
  private pruneRemembered(): void {
    for (const [id, entry] of this.keys) {
      if (this.keys.size <= MAX_REMEMBERED_QUERIES) break
      if (entry.watchers === 0) this.keys.delete(id)
    }
  }
}
