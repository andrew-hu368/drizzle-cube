/**
 * Portlet change detection (issue #271, Phase 1b): with
 * `subscribeIntervalSeconds` set, the portlet's active hook watches its server
 * queries through one /refresh-keys call per tick and refetches, with the new
 * key, only when a key changed. A refetch with the same fingerprint keeps the
 * rows the chart already has.
 *
 * Runs the real query hooks against MSW and asserts on the requests the server
 * sees.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { server, createHookWrapper } from '../../../client-setup/test-utils'
import {
  usePortletQueryResults,
  type UsePortletQueryResultsParams
} from '../../../../src/client/components/analyticsPortlet/usePortletQueryResults'
import type { CubeQuery, MultiQueryConfig, ServerFunnelQuery } from '../../../../src/client/types'
import type { ServerFlowQuery } from '../../../../src/client/types/flow'
import type { ServerRetentionQuery } from '../../../../src/client/types/retention'

const ANNOTATION = { measures: {}, dimensions: {}, timeDimensions: {} }

const singleQuery: CubeQuery = { measures: ['Employees.count'] }
const multiConfig: MultiQueryConfig = {
  queries: [{ measures: ['Employees.count'] }, { measures: ['Departments.count'] }],
  mergeStrategy: 'concat'
}
const funnelQuery: ServerFunnelQuery = {
  funnel: {
    bindingKey: 'Events.userId',
    timeDimension: 'Events.timestamp',
    steps: [{ name: 'Signup' }, { name: 'Purchase' }]
  }
}
const flowQuery: ServerFlowQuery = {
  flow: {
    bindingKey: 'Events.userId',
    timeDimension: 'Events.timestamp',
    eventDimension: 'Events.eventType',
    startingStep: { name: 'Purchase', filter: { member: 'Events.eventType', operator: 'equals', values: ['purchase'] } },
    stepsBefore: 2,
    stepsAfter: 2,
    joinStrategy: 'auto'
  }
}
const retentionQuery: ServerRetentionQuery = {
  retention: {
    timeDimension: 'Events.timestamp',
    bindingKey: 'Events.userId',
    dateRange: { start: '2024-01-01', end: '2024-03-31' },
    granularity: 'week',
    periods: 4,
    retentionType: 'classic'
  }
}

function baseParams(overrides: Partial<UsePortletQueryResultsParams>): UsePortletQueryResultsParams {
  return {
    activeQuery: null,
    multiQueryConfig: null,
    serverFunnelQuery: null,
    serverFlowQuery: null,
    serverRetentionQuery: null,
    isMultiQuery: false,
    isFunnelMode: false,
    isFlowMode: false,
    isRetentionMode: false,
    shouldSkipQuery: false,
    eagerLoad: false,
    isVisible: true,
    subscribeIntervalSeconds: 10,
    ...overrides
  }
}

interface SeenLoad {
  refreshKeys: Array<string | null>
}

const MODES: Array<{ name: string; params: Partial<UsePortletQueryResultsParams>; watched: unknown[] }> = [
  { name: 'single query', params: { activeQuery: singleQuery }, watched: [singleQuery] },
  { name: 'multi query', params: { multiQueryConfig: multiConfig, isMultiQuery: true }, watched: multiConfig.queries },
  { name: 'funnel', params: { serverFunnelQuery: funnelQuery, isFunnelMode: true }, watched: [funnelQuery] },
  { name: 'flow', params: { serverFlowQuery: flowQuery, isFlowMode: true }, watched: [flowQuery] },
  { name: 'retention', params: { serverRetentionQuery: retentionQuery, isRetentionMode: true }, watched: [retentionQuery] }
]

describe('usePortletQueryResults change detection', () => {
  let loads: SeenLoad[]
  let keyChecks: unknown[][]
  let keys: Map<string, string>
  let fingerprint: string

  function keyOf(query: unknown): string {
    return keys.get(JSON.stringify(query)) ?? 'k1'
  }

  beforeEach(() => {
    loads = []
    keyChecks = []
    keys = new Map()
    fingerprint = 'fp-1'
    vi.useFakeTimers({ shouldAdvanceTime: true })
    server.use(
      http.get('*/cubejs-api/v1/load', ({ request }) => {
        loads.push({ refreshKeys: [request.headers.get('x-refresh-key')] })
        return HttpResponse.json({
          results: [{ data: [{ value: 1 }], annotation: ANNOTATION, lastRefreshTime: new Date().toISOString(), fingerprint }]
        })
      }),
      http.post('*/cubejs-api/v1/batch', async ({ request }) => {
        const body = (await request.json()) as { queries: unknown[]; refreshKeys?: Array<string | null> }
        loads.push({ refreshKeys: body.refreshKeys ?? body.queries.map(() => null) })
        return HttpResponse.json({
          results: body.queries.map(() => ({
            success: true,
            data: [{ value: 1 }],
            annotation: ANNOTATION,
            lastRefreshTime: new Date().toISOString(),
            fingerprint
          }))
        })
      }),
      http.post('*/cubejs-api/v1/refresh-keys', async ({ request }) => {
        const body = (await request.json()) as { queries: unknown[] }
        keyChecks.push(body.queries)
        return HttpResponse.json({ keys: body.queries.map(query => ({ key: keyOf(query), checkAfterSeconds: 10 })) })
      })
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function renderPortlet(params: Partial<UsePortletQueryResultsParams>) {
    const { wrapper } = createHookWrapper()
    return renderHook(
      (props: { isVisible: boolean; subscribeIntervalSeconds?: number }) =>
        usePortletQueryResults(baseParams({ ...params, ...props })),
      { wrapper, initialProps: { isVisible: true, subscribeIntervalSeconds: 10 as number | undefined } }
    )
  }

  describe.each(MODES)('$name', ({ params, watched }) => {
    it('checks its queries in one /refresh-keys call and refetches only when a key changes', async () => {
      renderPortlet(params)
      await waitFor(() => expect(loads).toHaveLength(1))
      await waitFor(() => expect(keyChecks).toHaveLength(1))
      expect(keyChecks[0]).toEqual(watched)

      // Unchanged keys: no refetch
      await act(() => vi.advanceTimersByTimeAsync(10_000))
      expect(keyChecks).toHaveLength(2)
      expect(loads).toHaveLength(1)

      // The last watched query's key moves (for a multi-query portlet, only one of its queries)
      keys.set(JSON.stringify(watched[watched.length - 1]), 'k2')
      await act(() => vi.advanceTimersByTimeAsync(10_000))
      await waitFor(() => expect(loads).toHaveLength(2))
      expect(loads[1].refreshKeys).toEqual(watched.map((_, index) => (index === watched.length - 1 ? 'k2' : 'k1')))
    })

    it('stops checking without an interval, and checks again (refetching a change) when it comes back', async () => {
      const { rerender } = renderPortlet(params)
      await waitFor(() => expect(keyChecks).toHaveLength(1))

      rerender({ isVisible: true, subscribeIntervalSeconds: undefined })
      keys.set(JSON.stringify(watched[0]), 'changed-while-paused')
      await act(() => vi.advanceTimersByTimeAsync(30_000))
      expect(keyChecks).toHaveLength(1)
      expect(loads).toHaveLength(1)

      rerender({ isVisible: true, subscribeIntervalSeconds: 10 })
      await waitFor(() => expect(loads).toHaveLength(2))
    })
  })

  it('reports checked-at for the active mode', async () => {
    const { result } = renderPortlet({ activeQuery: singleQuery })
    await waitFor(() => expect(result.current.checkedAt).toBeDefined())
  })

  it('keeps the rows of a single-query portlet when the refetch has the same fingerprint', async () => {
    const { result } = renderPortlet({ activeQuery: singleQuery })
    await waitFor(() => expect(result.current.resultSet).not.toBeNull())
    await waitFor(() => expect(keyChecks).toHaveLength(1))
    const rows = result.current.resultSet?.rawData()

    keys.set(JSON.stringify(singleQuery), 'k2')
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    await waitFor(() => expect(loads).toHaveLength(2))
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    expect(result.current.resultSet?.rawData()).toBe(rows)
  })

  it('keeps the merged rows of a multi-query portlet when every fingerprint is unchanged', async () => {
    const { result } = renderPortlet({ multiQueryConfig: multiConfig, isMultiQuery: true })
    await waitFor(() => expect(result.current.multiQueryData).not.toBeNull())
    await waitFor(() => expect(keyChecks).toHaveLength(1))
    const merged = result.current.multiQueryData

    keys.set(JSON.stringify(multiConfig.queries[0]), 'k2')
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    await waitFor(() => expect(loads).toHaveLength(2))
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    expect(result.current.multiQueryData).toBe(merged)

    fingerprint = 'fp-2'
    keys.set(JSON.stringify(multiConfig.queries[0]), 'k3')
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    await waitFor(() => expect(loads).toHaveLength(3))
    await waitFor(() => expect(result.current.multiQueryData).not.toBe(merged))
  })
})
