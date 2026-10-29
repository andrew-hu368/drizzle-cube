import type { CubeQuery, CubeResultSet, CubeValidationIssue } from '../types.js'
import { CubeQueryError } from './CubeClient.js'
import { createBatcher, type Batcher } from './batcher.js'

/** Options for one registered query. */
export interface BatchRegisterOptions {
  /** Oldest cached server result accepted, in seconds. 0 skips the cache read. */
  maxAgeSeconds?: number
}

/** Executes one batch. `options` is passed only when the batch has a max-age. */
export type BatchExecutor = (
  queries: CubeQuery[],
  options?: BatchRegisterOptions
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
  private batcher: Batcher<CubeQuery, CubeResultSet, number>

  constructor(batchExecutor: BatchExecutor, delayMs: number = 50) {
    this.batcher = createBatcher({
      delayMs,
      execute: (queries, maxAgeSeconds) => maxAgeSeconds === undefined
        ? batchExecutor(queries)
        : batchExecutor(queries, { maxAgeSeconds })
    })
  }

  /**
   * Register a query to be batched. Returns a promise that resolves
   * when the batch is executed and this specific query's result is available.
   */
  public async register(query: CubeQuery, options?: BatchRegisterOptions): Promise<CubeResultSet> {
    const result = await this.batcher.add(query, options?.maxAgeSeconds)
    // Check if this specific query had an error
    if (result && 'error' in result && result.error) {
      // Keep any structured validation detail the batch response carried,
      // so a caller can drop one dead member rather than fail the portlet.
      const issues = (result as { issues?: CubeValidationIssue[] }).issues
      throw new CubeQueryError(result.error as string, 400, issues)
    }
    return result
  }

  /**
   * Get current queue size across all max-ages (useful for debugging)
   */
  public getQueueSize(): number {
    return this.batcher.size()
  }

  /**
   * Clear the queue (useful for testing/cleanup)
   */
  public clear(): void {
    this.batcher.clear()
  }
}
