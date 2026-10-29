/**
 * RefreshKeyCoordinator: each watcher checks on its own clock-aligned
 * interval; checks that land together share one /refresh-keys call.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  RefreshKeyCoordinator,
  type RefreshKeyFetcher,
  type RefreshKeyResult
} from '../../src/client/client/RefreshKeyCoordinator'
import type { MaxAgeOptions } from '../../src/client/client/maxAge'
import type { CubeQuery } from '../../src/client/types'

const orders: CubeQuery = { measures: ['Orders.count'] }
const users: CubeQuery = { measures: ['Users.count'] }

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
    // Checks are aligned to the clock; start on a round time
    vi.setSystemTime(new Date('2026-10-23T10:00:00.000Z'))
    server = createFakeServer()
    coordinator = new RefreshKeyCoordinator(server.fetcher)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function watch(queries: CubeQuery[], intervalSeconds = 10) {
    const events: MaxAgeOptions[] = []
    const checks: number[] = []
    const stop = coordinator.watch({
      queries,
      intervalSeconds,
      onChange: event => events.push(event),
      onChecked: at => checks.push(at)
    })
    return { events, checks, stop }
  }

  it('shares one call between watchers that check together, each query once', async () => {
    watch([orders])
    watch([users])
    watch([orders])

    await advanceSeconds(0.1)
    expect(server.calls).toEqual([[orders, users]])

    await advanceSeconds(10)
    expect(server.calls).toHaveLength(2)
    expect(server.calls[1]).toEqual([orders, users])
  })

  it('refetches only the watchers whose query key changed', async () => {
    const a = watch([orders])
    const b = watch([users])
    await advanceSeconds(0.1)

    server.set(orders, 'changed')
    await advanceSeconds(10)

    expect(a.events).toEqual([{ refreshKey: 'changed' }])
    expect(b.events).toEqual([])
    expect(b.checks).toHaveLength(2)

    await advanceSeconds(10)
    expect(a.events).toHaveLength(1)
  })

  it('refetches a multi-query watcher once when any of its queries changed', async () => {
    const multi = watch([orders, users])
    await advanceSeconds(0.1)
    server.set(users, 'u2')
    await advanceSeconds(10)
    expect(multi.events).toEqual([{ refreshKey: 'initial|u2' }])
  })

  it('checks each watcher on its own interval, raised by checkAfterSeconds', async () => {
    watch([orders], 10)
    watch([users], 30)
    await advanceSeconds(0.1)
    expect(server.calls).toHaveLength(1)

    await advanceSeconds(20)
    expect(server.calls.slice(1)).toEqual([[orders], [orders]])
    await advanceSeconds(10)
    expect(server.calls[3]).toEqual(expect.arrayContaining([orders, users]))

    // The server asks orders to be checked every 60 s from its next check (at 40 s)
    server.set(orders, 'initial', 60)
    await advanceSeconds(10)
    expect(server.calls).toHaveLength(5)
    await advanceSeconds(50)
    // 60 s: both; 90 s: users only, orders waits for 120 s
    expect(server.calls.slice(5)).toEqual([expect.arrayContaining([orders, users]), [users]])
  })

  it('falls back to an interval refetch with max-age while a key is null', async () => {
    server.set(orders, null, 10)
    const { events } = watch([orders])
    await advanceSeconds(0.1)
    expect(events).toEqual([])

    await advanceSeconds(10)
    expect(events).toEqual([{ maxAgeSeconds: 10 }])
    await advanceSeconds(10)
    expect(events).toHaveLength(2)
  })

  it('falls back to an interval refetch when /refresh-keys fails (an older server)', async () => {
    server.fail(true)
    const { events } = watch([orders])
    await advanceSeconds(0.1)
    expect(events).toEqual([])
    await advanceSeconds(10)
    expect(events).toEqual([{ maxAgeSeconds: 10 }])
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
    expect(second.events).toEqual([{ refreshKey: 'while-away' }])
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
    let call = 0
    coordinator = new RefreshKeyCoordinator((queries) => new Promise(resolve => {
      // A different key each call, so the second response would be a change
      const key = `k${++call}`
      release = () => resolve(queries.map(() => ({ key, checkAfterSeconds: 10 })))
    }))
    const { events, stop } = watch([orders])
    await advanceSeconds(0.1)
    release()
    await advanceSeconds(10)
    stop()
    release()
    await advanceSeconds(0.1)
    expect(events).toEqual([])
  })
})
