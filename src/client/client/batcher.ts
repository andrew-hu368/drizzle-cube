/**
 * createBatcher: queue items, flush them after a short delay, and settle each
 * item's promise from one executor call.
 *
 * Items are queued per group; a flush sends each group as its own call, so a
 * group can carry per-call options (a max-age). Items added once a flush has
 * started go into the next batch.
 */

export interface BatcherOptions<Q, R, G> {
  /** Items added within this many ms of the first share one flush. */
  delayMs: number
  /** Executes one group's batch; results are matched to items by index. */
  execute: (items: Q[], group: G | undefined) => Promise<R[]>
  /** Items with the same key in one batch are sent once and share a promise. */
  key?: (item: Q) => string
}

export interface Batcher<Q, R, G> {
  /** Queue an item; resolves with its result, rejects if its batch fails. */
  add(item: Q, group?: G): Promise<R>
  /** Items queued for the next flush, across groups. */
  size(): number
  /** Drop every queued item without settling it. */
  clear(): void
}

interface Entry<Q, R> {
  item: Q
  promise: Promise<R>
  resolve: (result: R) => void
  reject: (error: Error) => void
}

export function createBatcher<Q, R, G = never>({ delayMs, execute, key }: BatcherOptions<Q, R, G>): Batcher<Q, R, G> {
  let queues = new Map<G | undefined, Map<string | number, Entry<Q, R>>>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let nextId = 0

  const run = async (batch: Entry<Q, R>[], group: G | undefined): Promise<void> => {
    try {
      const results = await execute(batch.map(entry => entry.item), group)
      batch.forEach((entry, index) => entry.resolve(results[index]))
    } catch (error) {
      const reason = error instanceof Error ? error : new Error(String(error))
      batch.forEach(entry => entry.reject(reason))
    }
  }

  const flush = (): void => {
    const pending = queues
    queues = new Map()
    timer = undefined
    for (const [group, queue] of pending) void run(Array.from(queue.values()), group)
  }

  return {
    add(item, group) {
      let queue = queues.get(group)
      if (!queue) {
        queue = new Map()
        queues.set(group, queue)
      }
      const id = key ? key(item) : nextId++
      let entry = queue.get(id)
      if (!entry) {
        let resolve: Entry<Q, R>['resolve'] = () => {}
        let reject: Entry<Q, R>['reject'] = () => {}
        const promise = new Promise<R>((res, rej) => { resolve = res; reject = rej })
        entry = { item, promise, resolve, reject }
        queue.set(id, entry)
      }
      timer ??= setTimeout(flush, delayMs)
      return entry.promise
    },
    size() {
      let size = 0
      for (const queue of queues.values()) size += queue.size
      return size
    },
    clear() {
      clearTimeout(timer)
      timer = undefined
      queues = new Map()
    }
  }
}
