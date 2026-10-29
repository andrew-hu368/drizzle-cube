import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import {
  createHookWrapper,
  server,
  mockQueryData,
} from '../../client-setup/test-utils'
import { useCubeLoadQuery } from '../../../src/client/hooks/queries/useCubeLoadQuery'
import type { CubeQuery } from '../../../src/client/types'

describe('useCubeLoadQuery', () => {
  const validQuery: CubeQuery = {
    measures: ['Employees.count'],
    dimensions: ['Employees.name'],
  }

  const queryWithFilters: CubeQuery = {
    measures: ['Employees.count'],
    dimensions: ['Employees.name'],
    filters: [
      { member: 'Employees.name', operator: 'contains', values: ['John'] }
    ]
  }

  beforeEach(() => {
    // Clear any custom handlers between tests
    server.resetHandlers()
  })

  describe('basic functionality', () => {
    it('should return initial loading state', async () => {
      const { wrapper } = createHookWrapper()
      const { result } = renderHook(
        () => useCubeLoadQuery(validQuery),
        { wrapper }
      )

      // Initially should be loading
      expect(result.current.isLoading).toBe(true)
      expect(result.current.rawData).toBeNull()
      expect(result.current.resultSet).toBeNull()
    })

    it('should fetch and return data', async () => {
      const { wrapper } = createHookWrapper()
      const { result } = renderHook(
        () => useCubeLoadQuery(validQuery, { debounceMs: 0 }),
        { wrapper }
      )

      // Wait for the query to complete
      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.rawData).toBeDefined()
      expect(result.current.error).toBeNull()
    })

    it('should return resultSet with rawData method', async () => {
      const { wrapper } = createHookWrapper()
      const { result } = renderHook(
        () => useCubeLoadQuery(validQuery, { debounceMs: 0 }),
        { wrapper }
      )

      await waitFor(() => {
        expect(result.current.resultSet).not.toBeNull()
      })

      expect(result.current.resultSet?.rawData()).toBeDefined()
    })
  })

  describe('query validation', () => {
    it('should mark empty query as invalid', () => {
      const { wrapper } = createHookWrapper()
      const { result } = renderHook(
        () => useCubeLoadQuery(null),
        { wrapper }
      )

      expect(result.current.isValidQuery).toBe(false)
    })

    it('should mark query with no measures or dimensions as invalid', () => {
      const { wrapper } = createHookWrapper()
      const { result } = renderHook(
        () => useCubeLoadQuery({}),
        { wrapper }
      )

      expect(result.current.isValidQuery).toBe(false)
    })

    it('should mark query with measures as valid', () => {
      const { wrapper } = createHookWrapper()
      const { result } = renderHook(
        () => useCubeLoadQuery({ measures: ['Employees.count'] }),
        { wrapper }
      )

      expect(result.current.isValidQuery).toBe(true)
    })

    it('should mark query with dimensions as valid', () => {
      const { wrapper } = createHookWrapper()
      const { result } = renderHook(
        () => useCubeLoadQuery({ dimensions: ['Employees.name'] }),
        { wrapper }
      )

      expect(result.current.isValidQuery).toBe(true)
    })

    it('should mark query with timeDimensions as valid', () => {
      const { wrapper } = createHookWrapper()
      const { result } = renderHook(
        () => useCubeLoadQuery({
          timeDimensions: [{ dimension: 'Employees.createdAt', granularity: 'day' }]
        }),
        { wrapper }
      )

      expect(result.current.isValidQuery).toBe(true)
    })
  })

  describe('skip option', () => {
    it('should not fetch when skip is true', async () => {
      const { wrapper } = createHookWrapper()
      const { result } = renderHook(
        () => useCubeLoadQuery(validQuery, { skip: true }),
        { wrapper }
      )

      // Should not be loading when skipped
      expect(result.current.isLoading).toBe(false)
      expect(result.current.isFetching).toBe(false)
      expect(result.current.rawData).toBeNull()
    })

    it('should fetch when skip changes to false', async () => {
      const { wrapper } = createHookWrapper()
      const { result, rerender } = renderHook(
        ({ skip }) => useCubeLoadQuery(validQuery, { skip, debounceMs: 0 }),
        { wrapper, initialProps: { skip: true } }
      )

      expect(result.current.isLoading).toBe(false)

      // Change skip to false
      rerender({ skip: false })

      await waitFor(() => {
        expect(result.current.rawData).not.toBeNull()
      })
    })
  })

  describe('debouncing', () => {
    it('should debounce query changes', async () => {
      vi.useFakeTimers()

      const { wrapper } = createHookWrapper()
      const { result, rerender } = renderHook(
        ({ query }) => useCubeLoadQuery(query, { debounceMs: 300 }),
        { wrapper, initialProps: { query: validQuery } }
      )

      // Should be debouncing initially
      expect(result.current.isDebouncing).toBe(true)

      // Change query rapidly
      rerender({ query: { ...validQuery, measures: ['Employees.totalSalary'] } })
      rerender({ query: { ...validQuery, measures: ['Employees.avgSalary'] } })

      // Still debouncing
      expect(result.current.isDebouncing).toBe(true)

      // Advance time past debounce delay
      await act(async () => {
        vi.advanceTimersByTime(350)
      })

      expect(result.current.isDebouncing).toBe(false)

      vi.useRealTimers()
    })

    it('should not debounce when debounceMs is 0', async () => {
      const { wrapper } = createHookWrapper()
      const { result } = renderHook(
        () => useCubeLoadQuery(validQuery, { debounceMs: 0 }),
        { wrapper }
      )

      // Should start loading immediately (no debouncing)
      await waitFor(() => {
        expect(result.current.isDebouncing).toBe(false)
      })
    })
  })

  describe('error handling', () => {
    it('should handle API errors', async () => {
      // Override handler to return error (handle both GET and POST)
      server.use(
        http.get('*/cubejs-api/v1/load', () => {
          return HttpResponse.json(
            { error: 'Query execution failed' },
            { status: 500 }
          )
        }),
        http.post('*/cubejs-api/v1/load', () => {
          return HttpResponse.json(
            { error: 'Query execution failed' },
            { status: 500 }
          )
        })
      )

      const { wrapper } = createHookWrapper()
      const { result } = renderHook(
        () => useCubeLoadQuery(validQuery, { debounceMs: 0 }),
        { wrapper }
      )

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.error).not.toBeNull()
    })

    it('should handle network errors', async () => {
      server.use(
        http.get('*/cubejs-api/v1/load', () => {
          return HttpResponse.error()
        }),
        http.post('*/cubejs-api/v1/load', () => {
          return HttpResponse.error()
        })
      )

      const { wrapper } = createHookWrapper()
      const { result } = renderHook(
        () => useCubeLoadQuery(validQuery, { debounceMs: 0 }),
        { wrapper }
      )

      await waitFor(() => {
        expect(result.current.error).not.toBeNull()
      })
    })
  })

  describe('refetch', () => {
    it('should provide refetch function', async () => {
      const { wrapper } = createHookWrapper()
      const { result } = renderHook(
        () => useCubeLoadQuery(validQuery, { debounceMs: 0 }),
        { wrapper }
      )

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(typeof result.current.refetch).toBe('function')
    })

    it('should refetch data when called', async () => {
      let fetchCount = 0
      server.use(
        http.get('*/cubejs-api/v1/load', () => {
          fetchCount++
          return HttpResponse.json({
            data: mockQueryData,
            annotation: { measures: {}, dimensions: {}, timeDimensions: {} },
            query: validQuery
          })
        }),
        http.post('*/cubejs-api/v1/load', async () => {
          fetchCount++
          return HttpResponse.json({
            data: mockQueryData,
            annotation: { measures: {}, dimensions: {}, timeDimensions: {} },
            query: validQuery
          })
        })
      )

      const { wrapper } = createHookWrapper()
      const { result } = renderHook(
        () => useCubeLoadQuery(validQuery, { debounceMs: 0 }),
        { wrapper }
      )

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      const initialFetchCount = fetchCount

      // Trigger refetch
      act(() => {
        result.current.refetch()
      })

      await waitFor(() => {
        expect(fetchCount).toBeGreaterThan(initialFetchCount)
      })
    })
  })

  describe('refetch max-age', () => {
    function recordMaxAges(): Array<string | null> {
      const maxAges: Array<string | null> = []
      const respond = ({ request }: { request: Request }) => {
        maxAges.push(request.headers.get('x-cache-max-age'))
        return HttpResponse.json({
          data: mockQueryData,
          annotation: { measures: {}, dimensions: {}, timeDimensions: {} },
          query: validQuery
        })
      }
      server.use(http.get('*/cubejs-api/v1/load', respond), http.post('*/cubejs-api/v1/load', respond))
      return maxAges
    }

    // A dashboard card and the expand modal showing the same portlet: one
    // TanStack query, two observers. The modal renders last, so the query
    // holds the modal's options; each refetch must still run its own queryFn.
    it.each([
      { observer: 'card' as const, maxAgeSeconds: 10 },
      { observer: 'modal' as const, maxAgeSeconds: 20 }
    ])('sends the $observer max-age when two hooks observe the same query', async ({ observer, maxAgeSeconds }) => {
      const maxAges = recordMaxAges()
      const { wrapper } = createHookWrapper()
      const { result } = renderHook(
        () => ({
          card: useCubeLoadQuery(validQuery, { debounceMs: 0 }),
          modal: useCubeLoadQuery(validQuery, { debounceMs: 0 })
        }),
        { wrapper }
      )
      await waitFor(() => expect(result.current.card.isLoading).toBe(false))
      const initialCount = maxAges.length

      act(() => {
        result.current[observer].refetch({ maxAgeSeconds })
      })

      await waitFor(() => expect(maxAges.length).toBeGreaterThan(initialCount))
      expect(maxAges.slice(initialCount)).toEqual([String(maxAgeSeconds)])
    })

    it('keeps the old rows visible while a bust refetches', async () => {
      const maxAges = recordMaxAges()
      const { wrapper } = createHookWrapper()
      const { result } = renderHook(
        () => useCubeLoadQuery(validQuery, { debounceMs: 0 }),
        { wrapper }
      )
      await waitFor(() => expect(result.current.resultSet).not.toBeNull())
      const initialCount = maxAges.length

      act(() => {
        result.current.refetch({ bustCache: true })
      })

      await waitFor(() => expect(result.current.isFetching).toBe(true))
      expect(result.current.resultSet).not.toBeNull()
      expect(result.current.isLoading).toBe(false)
      await waitFor(() => expect(maxAges.length).toBeGreaterThan(initialCount))
      expect(maxAges.slice(initialCount)).toEqual(['0'])
    })

    // Interval ticks that outpace a slow query: each tick must join the fetch
    // in flight, or the query is cancelled on every tick and never lands.
    describe('while a refetch is in flight', () => {
      function holdResponses() {
        const maxAges: Array<string | null> = []
        let holding = false
        const held: Array<() => void> = []
        const respond = async ({ request }: { request: Request }) => {
          maxAges.push(request.headers.get('x-cache-max-age'))
          if (holding) await new Promise<void>((resolve) => held.push(resolve))
          return HttpResponse.json({
            data: mockQueryData,
            annotation: { measures: {}, dimensions: {}, timeDimensions: {} },
            query: validQuery
          })
        }
        server.use(http.get('*/cubejs-api/v1/load', respond), http.post('*/cubejs-api/v1/load', respond))
        return {
          maxAges,
          hold: () => { holding = true },
          release: () => {
            holding = false
            held.splice(0).forEach((resolve) => resolve())
          }
        }
      }

      it('joins it for a max-age no stricter than the pending one', async () => {
        const responses = holdResponses()
        const { wrapper } = createHookWrapper()
        const { result } = renderHook(
          () => useCubeLoadQuery(validQuery, { debounceMs: 0 }),
          { wrapper }
        )
        await waitFor(() => expect(result.current.resultSet).not.toBeNull())
        const initialCount = responses.maxAges.length

        responses.hold()
        act(() => {
          result.current.refetch({ maxAgeSeconds: 30 })
        })
        await waitFor(() => expect(responses.maxAges.length).toBe(initialCount + 1))
        act(() => {
          result.current.refetch({ maxAgeSeconds: 30 })
          result.current.refetch()
        })
        responses.release()

        await waitFor(() => expect(result.current.isFetching).toBe(false))
        expect(responses.maxAges.slice(initialCount)).toEqual(['30'])
      })

      it('cancels it for a stricter max-age', async () => {
        const responses = holdResponses()
        const { wrapper } = createHookWrapper()
        const { result } = renderHook(
          () => useCubeLoadQuery(validQuery, { debounceMs: 0 }),
          { wrapper }
        )
        await waitFor(() => expect(result.current.resultSet).not.toBeNull())
        const initialCount = responses.maxAges.length

        responses.hold()
        act(() => {
          result.current.refetch({ maxAgeSeconds: 30 })
        })
        await waitFor(() => expect(responses.maxAges.length).toBe(initialCount + 1))
        act(() => {
          result.current.refetch({ bustCache: true })
        })
        await waitFor(() => expect(responses.maxAges.length).toBe(initialCount + 2))
        responses.release()

        await waitFor(() => expect(result.current.isFetching).toBe(false))
        expect(responses.maxAges.slice(initialCount)).toEqual(['30', '0'])
      })
    })
  })

  describe('clearCache', () => {
    it('should provide clearCache function', async () => {
      const { wrapper } = createHookWrapper()
      const { result } = renderHook(
        () => useCubeLoadQuery(validQuery, { debounceMs: 0 }),
        { wrapper }
      )

      expect(typeof result.current.clearCache).toBe('function')
    })
  })

  describe('with filters', () => {
    it('should handle queries with filters', async () => {
      const { wrapper } = createHookWrapper()
      const { result } = renderHook(
        () => useCubeLoadQuery(queryWithFilters, { debounceMs: 0 }),
        { wrapper }
      )

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.rawData).toBeDefined()
      expect(result.current.error).toBeNull()
    })
  })

  describe('custom response data', () => {
    it('should return data from custom handler', async () => {
      const customData = [
        { 'Employees.count': 42, 'Employees.name': 'Custom User' }
      ]

      const customResponse = {
        data: customData,
        annotation: {
          measures: { 'Employees.count': { title: 'Count', type: 'number' } },
          dimensions: { 'Employees.name': { title: 'Name', type: 'string' } },
          timeDimensions: {}
        },
        query: validQuery
      }

      server.use(
        http.get('*/cubejs-api/v1/load', () => HttpResponse.json(customResponse)),
        http.post('*/cubejs-api/v1/load', () => HttpResponse.json(customResponse))
      )

      const { wrapper } = createHookWrapper()
      const { result } = renderHook(
        () => useCubeLoadQuery(validQuery, { debounceMs: 0 }),
        { wrapper }
      )

      await waitFor(() => {
        expect(result.current.rawData).toEqual(customData)
      })
    })
  })

  describe('gapFill option (issue #1368)', () => {
    const timeQuery: CubeQuery = {
      measures: ['Employees.count'],
      timeDimensions: [{ dimension: 'Employees.createdAt', granularity: 'day', dateRange: ['2026-08-01', '2026-08-03'] }]
    }
    const observed = [
      { 'Employees.createdAt': '2026-08-01T00:00:00.000Z', 'Employees.count': 12 },
      { 'Employees.createdAt': '2026-08-03T00:00:00.000Z', 'Employees.count': 14 }
    ]
    const respondWith = (cubeFill?: boolean) => {
      const response = {
        results: [{
          query: timeQuery,
          data: observed,
          annotation: {
            measures: {},
            dimensions: {},
            timeDimensions: { 'Employees.createdAt': { title: 'Created', type: 'time', fillMissingDates: cubeFill } }
          }
        }]
      }
      server.use(
        http.get('*/cubejs-api/v1/load', () => HttpResponse.json(response)),
        http.post('*/cubejs-api/v1/load', () => HttpResponse.json(response))
      )
    }

    it('returns raw rows without gapFill', async () => {
      respondWith()
      const { wrapper } = createHookWrapper()
      const { result } = renderHook(() => useCubeLoadQuery(timeQuery, { debounceMs: 0 }), { wrapper })

      await waitFor(() => {
        expect(result.current.rawData).toEqual(observed)
      })
    })

    it('fills missing buckets for a chart', async () => {
      respondWith()
      const { wrapper } = createHookWrapper()
      const { result } = renderHook(() => useCubeLoadQuery(timeQuery, { debounceMs: 0, gapFill: {} }), { wrapper })

      await waitFor(() => {
        expect(result.current.rawData).toHaveLength(3)
      })
      expect(result.current.resultSet?.rawData()[1]).toEqual({
        'Employees.createdAt': '2026-08-02T00:00:00.000Z',
        'Employees.count': 0
      })
    })

    it('respects the cube time dimension turning filling off', async () => {
      respondWith(false)
      const { wrapper } = createHookWrapper()
      const { result } = renderHook(() => useCubeLoadQuery(timeQuery, { debounceMs: 0, gapFill: {} }), { wrapper })

      await waitFor(() => {
        expect(result.current.rawData).toEqual(observed)
      })
    })

    it('fills missing buckets with the query fillMissingDatesValue', async () => {
      // Echo the sent query, as the server does, so the chart fills from it
      server.use(
        http.get('*/cubejs-api/v1/load', ({ request }) => HttpResponse.json({
          query: JSON.parse(new URL(request.url).searchParams.get('query') || '{}'),
          data: observed,
          annotation: { measures: {}, dimensions: {}, timeDimensions: {} }
        }))
      )
      const { wrapper } = createHookWrapper()
      const query: CubeQuery = { ...timeQuery, fillMissingDatesValue: null }
      const { result } = renderHook(() => useCubeLoadQuery(query, { debounceMs: 0, gapFill: {} }), { wrapper })

      await waitFor(() => {
        expect(result.current.rawData).toHaveLength(3)
      })
      expect(result.current.resultSet?.rawData()[1]).toEqual({
        'Employees.createdAt': '2026-08-02T00:00:00.000Z',
        'Employees.count': null
      })
    })
  })

  describe('subscribe (issue #271): change detection', () => {
    const loads: Array<{ maxAge: string | null; refreshKey: string | null }> = []
    const keyChecks: unknown[][] = []
    let currentKey: string | null = 'k1'
    let refreshKeysStatus = 200
    let fingerprint: string | undefined = 'fp-1'
    let respondedAt = Date.parse('2026-10-23T10:00:30.000Z')

    // React flushes renders when an act() scope ends, so advance in small
    // steps: a timer that fires in one step has rendered by the next.
    async function advanceSeconds(seconds: number) {
      for (let step = 0; step < seconds * 10; step++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(100)
        })
      }
    }

    beforeEach(() => {
      vi.useFakeTimers()
      // Key checks are aligned to the clock; start on a round time
      vi.setSystemTime(new Date('2026-10-23T10:00:00.000Z'))
      loads.length = 0
      keyChecks.length = 0
      currentKey = 'k1'
      refreshKeysStatus = 200
      fingerprint = 'fp-1'
      respondedAt = Date.parse('2026-10-23T10:00:30.000Z')
      server.use(
        http.get('*/cubejs-api/v1/load', ({ request }) => {
          loads.push({ maxAge: request.headers.get('x-cache-max-age'), refreshKey: request.headers.get('x-refresh-key') })
          respondedAt += 1000
          return HttpResponse.json({
            results: [{
              data: mockQueryData.map(row => ({ ...row })),
              annotation: { measures: {}, dimensions: {}, timeDimensions: {} },
              query: validQuery,
              lastRefreshTime: new Date(respondedAt).toISOString(),
              ...(fingerprint ? { fingerprint } : {})
            }]
          })
        }),
        http.post('*/cubejs-api/v1/refresh-keys', async ({ request }) => {
          const body = await request.json() as { queries: unknown[] }
          keyChecks.push(body.queries)
          if (refreshKeysStatus !== 200) return HttpResponse.json({ error: 'Not found' }, { status: refreshKeysStatus })
          return HttpResponse.json({ keys: body.queries.map(() => ({ key: currentKey, checkAfterSeconds: 10 })) })
        })
      )
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('checks the refresh key without features.refresh and does not refetch while it is unchanged', async () => {
      const { wrapper } = createHookWrapper()
      const { result } = renderHook(() => useCubeLoadQuery(validQuery, { debounceMs: 0, subscribe: true }), { wrapper })

      await advanceSeconds(31)
      expect(loads).toHaveLength(1)
      expect(keyChecks.length).toBeGreaterThanOrEqual(3)
      expect(result.current.getCheckedAt?.()).toBeDefined()
    })

    it('keeps the previous result when a refetch returns the same fingerprint', async () => {
      const { wrapper } = createHookWrapper()
      const { result } = renderHook(() => useCubeLoadQuery(validQuery, { debounceMs: 0, subscribe: true }), { wrapper })
      await advanceSeconds(1)
      const firstRows = result.current.rawData
      const firstResultSet = result.current.resultSet
      expect(firstRows).not.toBeNull()

      currentKey = 'k2'
      await advanceSeconds(10)
      // The refetch carries the new key and no max-age
      expect(loads).toEqual([
        { maxAge: null, refreshKey: null },
        { maxAge: null, refreshKey: 'k2' }
      ])
      expect(result.current.rawData).toBe(firstRows)
      expect(result.current.resultSet).toBe(firstResultSet)

      // Different rows: new data
      currentKey = 'k3'
      fingerprint = 'fp-3'
      await advanceSeconds(10)
      expect(result.current.rawData).not.toBe(firstRows)
    })

    it('takes a refetch without a fingerprint as new rows', async () => {
      fingerprint = undefined
      const { wrapper } = createHookWrapper()
      const { result } = renderHook(() => useCubeLoadQuery(validQuery, { debounceMs: 0, subscribe: true }), { wrapper })
      await advanceSeconds(1)
      const firstRows = result.current.rawData

      currentKey = 'k2'
      await advanceSeconds(10)
      expect(loads).toHaveLength(2)
      expect(result.current.rawData).not.toBe(firstRows)
    })

    it('does not check without subscribe, while skipped or disabled, or in manualRefresh mode', async () => {
      const { wrapper } = createHookWrapper()
      renderHook(() => useCubeLoadQuery(validQuery, { debounceMs: 0 }), { wrapper })
      renderHook(() => useCubeLoadQuery(validQuery, { debounceMs: 0, subscribe: true, skip: true }), { wrapper })
      renderHook(() => useCubeLoadQuery(validQuery, { debounceMs: 0, subscribe: true, enabled: false }), { wrapper })
      const manual = createHookWrapper({ features: { manualRefresh: true } })
      renderHook(() => useCubeLoadQuery(validQuery, { debounceMs: 0, subscribe: true }), { wrapper: manual.wrapper })

      await advanceSeconds(30)
      expect(keyChecks).toEqual([])
    })

    it('stops when subscribe is turned off', async () => {
      const { wrapper } = createHookWrapper()
      const { rerender } = renderHook(
        ({ subscribe }: { subscribe: boolean }) => useCubeLoadQuery(validQuery, { debounceMs: 0, subscribe }),
        { wrapper, initialProps: { subscribe: true } }
      )
      await advanceSeconds(1)
      expect(keyChecks).toHaveLength(1)

      rerender({ subscribe: false })
      await advanceSeconds(30)
      expect(keyChecks).toHaveLength(1)
    })

    it('watches the new query when the query changes', async () => {
      const otherQuery: CubeQuery = { measures: ['Employees.count'] }
      const { wrapper } = createHookWrapper()
      const { rerender } = renderHook(
        ({ query }: { query: CubeQuery }) => useCubeLoadQuery(query, { debounceMs: 0, subscribe: true }),
        { wrapper, initialProps: { query: validQuery } }
      )
      await advanceSeconds(1)
      rerender({ query: otherQuery })
      await advanceSeconds(1)

      expect(keyChecks[keyChecks.length - 1]).toEqual([otherQuery])
    })

    describe('against a server without /refresh-keys', () => {
      beforeEach(() => {
        refreshKeysStatus = 404
      })

      it('refetches every 10 s with max-age 10', async () => {
        const { wrapper } = createHookWrapper()
        const { unmount } = renderHook(
          () => useCubeLoadQuery(validQuery, { debounceMs: 0, subscribe: true }),
          { wrapper }
        )

        await advanceSeconds(9)
        expect(loads.map(load => load.maxAge)).toEqual([null])

        await advanceSeconds(2)
        expect(loads.map(load => load.maxAge)).toEqual([null, '10'])

        await advanceSeconds(10)
        expect(loads.map(load => load.maxAge)).toEqual([null, '10', '10'])

        unmount()
        await advanceSeconds(30)
        expect(loads).toHaveLength(3)
      })

      it('floors the interval by features.refresh.minIntervalSeconds', async () => {
        const { wrapper } = createHookWrapper({ features: { refresh: { enabled: false, minIntervalSeconds: 30 } } })
        renderHook(() => useCubeLoadQuery(validQuery, { debounceMs: 0, subscribe: true }), { wrapper })

        await advanceSeconds(29)
        expect(loads.map(load => load.maxAge)).toEqual([null])

        await advanceSeconds(2)
        expect(loads.map(load => load.maxAge)).toEqual([null, '30'])
      })
    })
  })
})
