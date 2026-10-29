/**
 * createBatcher: the queue/flush/settle core shared by BatchCoordinator and
 * RefreshKeyCoordinator. Coordinator-specific behaviour is tested there.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createBatcher } from '../../src/client/client/batcher'

describe('createBatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends items with the same key once, sharing one promise', async () => {
    const execute = vi.fn(async (items: string[]) => items.map(item => item.toUpperCase()))
    const batcher = createBatcher({ delayMs: 10, execute, key: (item: string) => item })

    const first = batcher.add('a')
    const second = batcher.add('b')
    const again = batcher.add('a')
    expect(again).toBe(first)
    expect(batcher.size()).toBe(2)

    await vi.advanceTimersByTimeAsync(10)
    expect(execute).toHaveBeenCalledWith(['a', 'b'], undefined)
    expect(await again).toBe('A')
    expect(await second).toBe('B')
  })

  it('does not share a key across batches', async () => {
    const execute = vi.fn(async (items: string[]) => items)
    const batcher = createBatcher({ delayMs: 10, execute, key: (item: string) => item })

    const first = batcher.add('a')
    await vi.advanceTimersByTimeAsync(10)
    const second = batcher.add('a')
    expect(second).not.toBe(first)

    await vi.advanceTimersByTimeAsync(10)
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('sends every item without a key, even equal ones', async () => {
    const execute = vi.fn(async (items: number[]) => items)
    const batcher = createBatcher({ delayMs: 10, execute })

    batcher.add(1)
    batcher.add(1)
    await vi.advanceTimersByTimeAsync(10)
    expect(execute).toHaveBeenCalledWith([1, 1], undefined)
  })

  it('flushes every group on the first item\'s timer, one call per group', async () => {
    const execute = vi.fn(async (items: string[], _group: number | undefined) => items)
    const batcher = createBatcher({ delayMs: 50, execute })

    batcher.add('plain')
    await vi.advanceTimersByTimeAsync(40)
    batcher.add('thirty', 30)
    await vi.advanceTimersByTimeAsync(10)

    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledWith(['plain'], undefined)
    expect(execute).toHaveBeenCalledWith(['thirty'], 30)
  })

  it('cancels the pending flush on clear', async () => {
    const execute = vi.fn(async (items: string[]) => items)
    const batcher = createBatcher({ delayMs: 50, execute })

    batcher.add('dropped')
    await vi.advanceTimersByTimeAsync(40)
    batcher.clear()
    batcher.add('next')

    // The cleared timer would have fired at 50 ms; the new one fires at 90 ms
    await vi.advanceTimersByTimeAsync(10)
    expect(execute).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(40)
    expect(execute).toHaveBeenCalledWith(['next'], undefined)
  })
})
