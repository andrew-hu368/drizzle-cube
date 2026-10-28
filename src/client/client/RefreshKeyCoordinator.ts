/**
 * RefreshKeyCoordinator: change detection for every subscription on the page.
 *
 * Each subscription (a `useCubeQuery(…, { subscribe })` hook, a
 * `CubeClient.subscribe` call, a portlet with refresh on) watches its queries
 * here. On each tick the coordinator sends one `POST /refresh-keys` for every
 * watched query, remembers the last composite key per query, and tells a
 * watcher only when one of its queries' keys changed. The first key seen for a
 * query is only recorded: the query has just loaded.
 *
 * Cadence: the smallest `checkAfterSeconds` the server returned among watched
 * queries, never below a query's own watcher interval nor below
 * `minIntervalSeconds`. A new watcher triggers a check shortly after it
 * registers (watchers registered in one render share it). Nothing ticks while
 * nothing is watched.
 *
 * A `null` key (the server could not evaluate a cube key) or a failed call (an
 * older server without `/refresh-keys`) falls back to an interval refetch:
 * the watcher hears `fallback` once per interval and refetches with that
 * max-age, as before refresh keys existed.
 */

import type { CubeQuery } from '../types.js'
import { stableStringify } from '../shared/queryKey.js'

/** One query's composite key from `/refresh-keys`. */
export interface RefreshKeyResult {
  key: string | null
  checkAfterSeconds: number
}

/** Fetches the composite keys of `queries`, in order. */
export type RefreshKeyFetcher = (queries: CubeQuery[]) => Promise<RefreshKeyResult[]>

/** What a watcher hears. */
export type RefreshKeyEvent =
  /** A key of one of the watcher's queries changed; refetch. `refreshKeys` are the current keys, per query. */
  | { type: 'changed'; refreshKeys: Array<string | null> }
  /** Keys are unavailable; refetch accepting a result at most `maxAgeSeconds` old. */
  | { type: 'fallback'; maxAgeSeconds: number }

export interface RefreshKeyWatch {
  queries: CubeQuery[]
  /** Check this watcher's queries at most this often (e.g. a portlet's refresh interval). */
  intervalSeconds?: number
  onChange: (event: RefreshKeyEvent) => void
  /** Called after every check that covered this watcher's queries, with the check time (ms). */
  onChecked?: (checkedAt: number) => void
}

export interface RefreshKeyCoordinatorOptions {
  /** Floor for the tick interval, in seconds. Default 5. */
  minIntervalSeconds?: number
  /** Delay before the check a new watcher triggers, so one render's watchers share it. Default 50 ms. */
  registerDelayMs?: number
}

/** Check interval for a query whose `checkAfterSeconds` is not known yet (Cube.js's default `every`). */
const DEFAULT_CHECK_AFTER_SECONDS = 10
const DEFAULT_MIN_INTERVAL_SECONDS = 5
/** Remembered keys of unwatched queries are dropped beyond this many. */
const MAX_REMEMBERED_QUERIES = 500

interface QueryState {
  query: CubeQuery
  /** Whether a check has covered this query yet */
  checked?: boolean
  /** Last key seen; undefined until a response carried one */
  key?: string | null
  checkAfterSeconds?: number
  /** When this query last reported a fallback (or was first checked) */
  lastFallbackAt?: number
}

interface Watcher extends RefreshKeyWatch {
  queryIds: string[]
}

export class RefreshKeyCoordinator {
  private readonly fetcher: RefreshKeyFetcher
  private readonly minIntervalSeconds: number
  private readonly registerDelayMs: number
  private readonly watchers = new Set<Watcher>()
  private readonly queries = new Map<string, QueryState>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private timerDueAt = Infinity
  private inFlight = false
  private checkAgain = false

  constructor(fetcher: RefreshKeyFetcher, options: RefreshKeyCoordinatorOptions = {}) {
    this.fetcher = fetcher
    this.minIntervalSeconds = Math.max(1, options.minIntervalSeconds ?? DEFAULT_MIN_INTERVAL_SECONDS)
    this.registerDelayMs = options.registerDelayMs ?? 50
  }

  /** Watch queries for changes. Returns a function that stops watching. */
  watch(watch: RefreshKeyWatch): () => void {
    const queryIds = watch.queries.map(query => {
      const id = stableStringify(query)
      if (!this.queries.has(id)) this.queries.set(id, { query })
      return id
    })
    const watcher: Watcher = { ...watch, queryIds }
    this.watchers.add(watcher)
    this.schedule(this.registerDelayMs)

    return () => {
      if (!this.watchers.delete(watcher)) return
      if (this.watchers.size === 0) this.clearTimer()
      this.pruneRemembered()
    }
  }

  /** The last key seen for a query that is being watched, if any. */
  currentKey(query: CubeQuery): string | undefined {
    const id = stableStringify(query)
    if (!this.isWatched(id)) return undefined
    return this.queries.get(id)?.key ?? undefined
  }

  private isWatched(id: string): boolean {
    for (const watcher of this.watchers) {
      if (watcher.queryIds.includes(id)) return true
    }
    return false
  }

  private watchedIds(): string[] {
    const ids = new Set<string>()
    for (const watcher of this.watchers) watcher.queryIds.forEach(id => ids.add(id))
    return Array.from(ids)
  }

  /** How often a query is checked: its server cadence, floored by its watchers' intervals and the minimum. */
  private queryIntervalSeconds(id: string): number {
    const checkAfter = this.queries.get(id)?.checkAfterSeconds ?? DEFAULT_CHECK_AFTER_SECONDS
    let ownInterval = Infinity
    for (const watcher of this.watchers) {
      if (watcher.intervalSeconds !== undefined && watcher.queryIds.includes(id)) {
        ownInterval = Math.min(ownInterval, watcher.intervalSeconds)
      }
    }
    const floor = Number.isFinite(ownInterval) ? Math.max(ownInterval, this.minIntervalSeconds) : this.minIntervalSeconds
    return Math.max(checkAfter, floor)
  }

  private tickSeconds(): number {
    const ids = this.watchedIds()
    if (ids.length === 0) return Infinity
    return Math.min(...ids.map(id => this.queryIntervalSeconds(id)))
  }

  /** Run a check in `delayMs`, unless one is already due sooner. */
  private schedule(delayMs: number): void {
    if (this.inFlight) {
      this.checkAgain = this.checkAgain || delayMs <= this.registerDelayMs
      return
    }
    const dueAt = Date.now() + delayMs
    if (this.timer !== undefined && this.timerDueAt <= dueAt) return
    this.clearTimer()
    this.timerDueAt = dueAt
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.timerDueAt = Infinity
      void this.check()
    }, delayMs)
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.timerDueAt = Infinity
  }

  private async check(): Promise<void> {
    const ids = this.watchedIds()
    if (ids.length === 0) return

    this.inFlight = true
    let results: RefreshKeyResult[] | undefined
    try {
      results = await this.fetcher(ids.map(id => this.queries.get(id)!.query))
      if (!Array.isArray(results) || results.length !== ids.length) results = undefined
    } catch {
      results = undefined
    } finally {
      this.inFlight = false
    }

    const checkedAt = Date.now()
    const changed = new Set<string>()
    const fallback = new Set<string>()

    ids.forEach((id, index) => {
      const state = this.queries.get(id)
      if (!state) return
      const result = results?.[index]
      const previous = state.key
      const firstCheck = !state.checked
      state.checked = true
      if (result) {
        state.checkAfterSeconds = result.checkAfterSeconds
        state.key = result.key
      }

      if (!result || result.key === null) {
        // Interval fallback, once per interval; the first check only starts the clock
        if (firstCheck || state.lastFallbackAt === undefined) {
          state.lastFallbackAt = checkedAt
        } else if (checkedAt - state.lastFallbackAt >= this.queryIntervalSeconds(id) * 1000) {
          state.lastFallbackAt = checkedAt
          fallback.add(id)
        }
        return
      }

      state.lastFallbackAt = undefined
      // A key after a run of failures counts as a change only when it differs from the last good one
      if (!firstCheck && previous !== undefined && previous !== result.key) changed.add(id)
    })

    for (const watcher of Array.from(this.watchers)) {
      // A watcher that stopped while the call was in flight hears nothing
      if (!this.watchers.has(watcher)) continue
      const covered = watcher.queryIds.some(id => ids.includes(id))
      if (!covered) continue

      if (watcher.queryIds.some(id => changed.has(id))) {
        watcher.onChange({
          type: 'changed',
          refreshKeys: watcher.queryIds.map(id => this.queries.get(id)?.key ?? null)
        })
      } else {
        const due = watcher.queryIds.filter(id => fallback.has(id))
        if (due.length > 0) {
          watcher.onChange({
            type: 'fallback',
            maxAgeSeconds: Math.min(...due.map(id => this.queryIntervalSeconds(id)))
          })
        }
      }
      watcher.onChecked?.(checkedAt)
    }

    if (this.watchers.size === 0) return
    if (this.checkAgain) {
      this.checkAgain = false
      this.schedule(this.registerDelayMs)
    }
    this.schedule(this.tickSeconds() * 1000)
  }

  /** Forget the oldest unwatched queries once too many are remembered. */
  private pruneRemembered(): void {
    if (this.queries.size <= MAX_REMEMBERED_QUERIES) return
    for (const id of this.queries.keys()) {
      if (this.queries.size <= MAX_REMEMBERED_QUERIES) break
      if (!this.isWatched(id)) this.queries.delete(id)
    }
  }
}
