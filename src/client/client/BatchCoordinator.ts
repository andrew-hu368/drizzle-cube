import type { CubeQuery, CubeResultSet, CubeValidationIssue } from '../types.js'
import { CubeQueryError } from './CubeClient.js'

/**
 * Represents a queued query with its resolver/rejector
 */
interface QueuedQuery {
  query: CubeQuery
  refreshKey?: string
  resolve: (result: CubeResultSet) => void
  reject: (error: Error) => void
}

/** Options for one registered query. */
export interface BatchRegisterOptions {
  /** Oldest cached server result accepted, in seconds. 0 skips the cache read. */
  maxAgeSeconds?: number
  /** This query's refresh key (it travels per query, so it does not split the batch). */
  refreshKey?: string
}

/**
 * Executes one batch. `options` is passed only when the batch has a max-age;
 * `refreshKeys` (one per query) only when a query carries a refresh key.
 */
export type BatchExecutor = (
  queries: CubeQuery[],
  options?: { maxAgeSeconds?: number },
  refreshKeys?: Array<string | undefined>
) => Promise<CubeResultSet[]>

/**
 * BatchCoordinator collects queries triggered in the same render cycle
 * and sends them as a single batch request to minimize network overhead.
 *
 * Uses a configurable delay (default 50ms) to batch queries from lazy-loaded
 * portlets that become visible during the same scroll action.
 *
 * The pending queue is keyed by max-age: a batch carries one `x-cache-max-age`
 * header, so queries with different max-ages flush as separate batch calls
 * (and still batch among themselves). A cache bust is the max-age 0 queue.
 */
export class BatchCoordinator {
  private queues = new Map<number | undefined, QueuedQuery[]>()
  private flushScheduled = false
  private batchExecutor: BatchExecutor
  private delayMs: number

  constructor(batchExecutor: BatchExecutor, delayMs: number = 50) {
    this.batchExecutor = batchExecutor
    this.delayMs = delayMs
  }

  /**
   * Register a query to be batched. Returns a promise that resolves
   * when the batch is executed and this specific query's result is available.
   */
  public register(query: CubeQuery, options?: BatchRegisterOptions): Promise<CubeResultSet> {
    const maxAgeSeconds = options?.maxAgeSeconds
    return new Promise<CubeResultSet>((resolve, reject) => {
      const entry: QueuedQuery = { query, refreshKey: options?.refreshKey, resolve, reject }
      const queue = this.queues.get(maxAgeSeconds)
      if (queue) {
        queue.push(entry)
      } else {
        this.queues.set(maxAgeSeconds, [entry])
      }

      // Schedule flush if not already scheduled
      if (!this.flushScheduled) {
        this.scheduleFlush()
      }
    })
  }

  /**
   * Schedule a flush after a short delay to collect multiple queries.
   * The delay allows queries from lazy-loaded portlets that become visible
   * during the same scroll action to be batched together.
   */
  private scheduleFlush(): void {
    this.flushScheduled = true

    setTimeout(() => {
      this.flush()
    }, this.delayMs)
  }

  /**
   * Send every pending queue as its own batch call.
   */
  private flush(): void {
    // Reset state
    this.flushScheduled = false

    // Take current queues and clear them
    const pending = Array.from(this.queues.entries())
    this.queues = new Map()

    for (const [maxAgeSeconds, queue] of pending) {
      if (queue.length > 0) {
        void this.flushQueue(queue, maxAgeSeconds)
      }
    }
  }

  /**
   * Execute one queue as a batch and resolve individual promises
   */
  private async flushQueue(queue: QueuedQuery[], maxAgeSeconds: number | undefined): Promise<void> {
    try {
      // Extract queries
      const queries = queue.map(item => item.query)

      const refreshKeys = queue.some(item => item.refreshKey !== undefined)
        ? queue.map(item => item.refreshKey)
        : undefined

      // Execute batch
      const maxAgeOptions = maxAgeSeconds === undefined ? undefined : { maxAgeSeconds }
      const results = refreshKeys !== undefined
        ? await this.batchExecutor(queries, maxAgeOptions, refreshKeys)
        : maxAgeOptions !== undefined
          ? await this.batchExecutor(queries, maxAgeOptions)
          : await this.batchExecutor(queries)

      // Resolve individual promises with their corresponding results
      queue.forEach((item, index) => {
        const result = results[index]

        // Check if this specific query had an error
        if (result && 'error' in result && result.error) {
          // Keep any structured validation detail the batch response carried,
          // so a caller can drop one dead member rather than fail the portlet.
          const issues = (result as { issues?: CubeValidationIssue[] }).issues
          item.reject(new CubeQueryError(result.error as string, 400, issues))
        } else {
          item.resolve(result)
        }
      })
    } catch (error) {
      // If entire batch fails, reject all queries
      queue.forEach(item => {
        item.reject(error instanceof Error ? error : new Error(String(error)))
      })
    }
  }

  /**
   * Get current queue size across all max-ages (useful for debugging)
   */
  public getQueueSize(): number {
    let size = 0
    for (const queue of this.queues.values()) size += queue.length
    return size
  }

  /**
   * Clear the queue (useful for testing/cleanup)
   */
  public clear(): void {
    this.queues = new Map()
    this.flushScheduled = false
  }
}
