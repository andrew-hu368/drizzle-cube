/**
 * RefreshKeyCoordinator: one /refresh-keys call per tick for every watched
 * query on the page; a watcher hears only about its own queries.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  RefreshKeyCoordinator,
  type RefreshKeyEvent,
  type RefreshKeyFetcher,
  type RefreshKeyResult
} from '../../src/client/client/RefreshKeyCoordinator'
import type { CubeQuery } from '../../src/client/types'

const orders: CubeQuery = { measures: ['Orders.count'] }
const users: CubeQuery = { measures: ['Users.count'] }
const funnel = { funnel: { bindingKey: 'Events.userId', timeDimension: 'Events.at', steps: [] } } as unknown as CubeQuery

/** A fake /refresh-keys: keys come from a mutable table, each call is recorded. */
function createFakeServer() {
  const keys = new Map<string, RefreshKeyResult>()
  const calls: CubeQuery[][] = []
  let failing = false
  const fetcher: RefreshKeyFetcher = async (queries) => {
    calls.push(queries)
    if (failing) throw new Error('404')
    return queries.map(query => keys.get(JSON.stringify(query)) ?? { key: 'initial', checkAfterSeconds: 10 })
  }
  return {
    fetcher,
    calls,
    set(query: CubeQuery, key: string | null, checkAfterSeconds = 10) {
      keys.set(JSON.stringify(query), { key, checkAfterSeconds })
    },
    fail(value: boolean) {
      failing = value
    }
  }
}

async function advanceSeconds(seconds: number) {
  await vi.advanceTimersByTimeAsync(seconds * 1000)
}

describe('RefreshKeyCoordinator', () => {
  let server: ReturnType<typeof createFakeServer>
  let coordinator: RefreshKeyCoordinator

  beforeEach(() => {
    vi.useFakeTimers()
    server = createFakeServer()
    coordinator = new RefreshKeyCoordinator(server.fetcher, { minIntervalSeconds: 5 })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function watch(queries: CubeQuery[], intervalSeconds?: number) {
    const events: RefreshKeyEvent[] = []
    const checks: number[] = []
    const stop = coordinator.watch({
      queries,
      intervalSeconds,
      onChange: event => events.push(event),
      onChecked: at => checks.push(at)
    })
    return { events, checks, stop }
  }

  it('sends one call per tick for every watched query', async () => {
    watch([orders])
    watch([users])
    watch([orders])

    await advanceSeconds(0.1)
    expect(server.calls).toHaveLength(1)
    expect(server.calls[0]).toEqual([orders, users])

    await advanceSeconds(10)
    expect(server.calls).toHaveLength(2)
    expect(server.calls[1]).toEqual([orders, users])
  })

  it('records keys on the first response without notifying', async () => {
    const { events, checks } = watch([orders])
    await advanceSeconds(0.1)
    expect(events).toEqual([])
    expect(checks).toHaveLength(1)
  })

  it('notifies only the watchers whose query key changed, with the new key', async () => {
    const a = watch([orders])
    const b = watch([users])
    await advanceSeconds(0.1)

    server.set(orders, 'changed')
    await advanceSeconds(10)

    expect(a.events).toEqual([{ type: 'changed', refreshKeys: ['changed'] }])
    expect(b.events).toEqual([])
    expect(b.checks).toHaveLength(2)

    await advanceSeconds(10)
    expect(a.events).toHaveLength(1)
  })

  it('notifies a multi-query watcher once when any of its queries changed', async () => {
    const multi = watch([orders, users])
    await advanceSeconds(0.1)
    server.set(users, 'u2')
    await advanceSeconds(10)
    expect(multi.events).toEqual([{ type: 'changed', refreshKeys: ['initial', 'u2'] }])
  })

  it('notifies a funnel query watcher when the funnel key changes (e.g. a step cube was written)', async () => {
    const f = watch([funnel])
    await advanceSeconds(0.1)
    server.set(funnel, 'step-cube-written')
    await advanceSeconds(10)
    expect(f.events).toEqual([{ type: 'changed', refreshKeys: ['step-cube-written'] }])
  })

  it('ticks at the smallest checkAfterSeconds, floored by the minimum interval', async () => {
    server.set(orders, 'k', 30)
    server.set(users, 'k', 2)
    watch([orders])
    await advanceSeconds(0.1)
    expect(server.calls).toHaveLength(1)

    // users asks for 2 s, the floor is 5 s
    await advanceSeconds(4.9)
    expect(server.calls).toHaveLength(1)
    watch([users])
    await advanceSeconds(0.1)
    expect(server.calls).toHaveLength(2)
    await advanceSeconds(5)
    expect(server.calls).toHaveLength(3)
  })

  it('is floored by a watcher\'s own interval', async () => {
    watch([orders], 60)
    await advanceSeconds(0.1)
    await advanceSeconds(59)
    expect(server.calls).toHaveLength(1)
    await advanceSeconds(1)
    expect(server.calls).toHaveLength(2)
  })

  it('falls back to an interval refetch while a key is null', async () => {
    server.set(orders, null, 10)
    const { events } = watch([orders])
    await advanceSeconds(0.1)
    expect(events).toEqual([])

    await advanceSeconds(10)
    expect(events).toEqual([{ type: 'fallback', maxAgeSeconds: 10 }])
    await advanceSeconds(10)
    expect(events).toHaveLength(2)

    // A key again: the next change notifies as usual
    server.set(orders, 'back', 10)
    await advanceSeconds(10)
    expect(events[2]).toEqual({ type: 'changed', refreshKeys: ['back'] })
  })

  it('falls back to an interval refetch when /refresh-keys fails (an older server)', async () => {
    server.fail(true)
    const { events } = watch([orders])
    await advanceSeconds(0.1)
    expect(events).toEqual([])
    await advanceSeconds(10)
    expect(events).toEqual([{ type: 'fallback', maxAgeSeconds: 10 }])
  })

  it('stops calling when nothing is watched, and remembers keys for the next watcher', async () => {
    const first = watch([orders])
    await advanceSeconds(0.1)
    first.stop()
    await advanceSeconds(60)
    expect(server.calls).toHaveLength(1)

    // Changed while nobody watched: the next watcher's first check reports it
    server.set(orders, 'while-away')
    const second = watch([orders])
    await advanceSeconds(0.1)
    expect(second.events).toEqual([{ type: 'changed', refreshKeys: ['while-away'] }])
  })

  it('exposes the current key of a watched query only', async () => {
    server.set(orders, 'k1')
    const { stop } = watch([orders])
    expect(coordinator.currentKey(orders)).toBeUndefined()
    await advanceSeconds(0.1)
    expect(coordinator.currentKey(orders)).toBe('k1')
    stop()
    expect(coordinator.currentKey(orders)).toBeUndefined()
  })

  it('does not notify a watcher that stopped while a call was in flight', async () => {
    let release: () => void = () => {}
    const slow: RefreshKeyFetcher = (queries) => new Promise(resolve => {
      release = () => resolve(queries.map(() => ({ key: 'x', checkAfterSeconds: 10 })))
    })
    coordinator = new RefreshKeyCoordinator(slow)
    const events: RefreshKeyEvent[] = []
    const stop = coordinator.watch({ queries: [orders], onChange: e => events.push(e) })
    await advanceSeconds(0.1)
    release()
    await advanceSeconds(10)
    stop()
    release()
    await advanceSeconds(0.1)
    expect(events).toEqual([])
  })
})
