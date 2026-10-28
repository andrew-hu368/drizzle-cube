import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { CubeClient } from '../../src/client/client/CubeClient'
import type { CubeQuery, CubeResultSet } from '../../src/client/types'
import { server } from '../client-setup/msw-server'

// This is a unit test file that mocks fetch directly
// We need to close MSW server to prevent it from intercepting requests
beforeAll(() => {
  server.close()
})

afterAll(() => {
  server.listen()
})

// Mock fetch for API calls
const mockFetch = vi.fn()
global.fetch = mockFetch

describe('CubeClient', () => {
  let client: CubeClient

  beforeEach(() => {
    vi.clearAllMocks()
    client = new CubeClient(undefined, {
      apiUrl: 'http://localhost:4000/cubejs-api/v1'
    })
  })

  describe('constructor', () => {
    it('should create client with API URL', () => {
      expect(client).toBeInstanceOf(CubeClient)
    })

    it('should create client with API URL and token', () => {
      const clientWithToken = new CubeClient('test-token', {
        apiUrl: 'http://localhost:4000/cubejs-api/v1'
      })
      expect(clientWithToken).toBeInstanceOf(CubeClient)
    })
  })

  describe('load method', () => {
    it('should make GET request to /load endpoint with query param', async () => {
      const mockResponse = {
        data: [{ 'Users.count': 5 }],
        query: { measures: ['Users.count'] }
      }
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse)
      })

      const query: CubeQuery = {
        measures: ['Users.count']
      }

      const result = await client.load(query)

      const expectedUrl = 'http://localhost:4000/cubejs-api/v1/load?query=' + encodeURIComponent(JSON.stringify(query))
      
      expect(mockFetch).toHaveBeenCalledWith(
        expectedUrl,
        expect.objectContaining({
          method: 'GET',
          credentials: 'include'
        })
      )

      expect(result.rawData()).toEqual(mockResponse.data)
    })

    it('should include authorization header when token is provided', async () => {
      const clientWithToken = new CubeClient('test-token', {
        apiUrl: 'http://localhost:4000/cubejs-api/v1'
      })

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [], query: {} })
      })

      await clientWithToken.load({ measures: ['Users.count'] })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'GET',
          credentials: 'include',
          headers: {
            'Authorization': 'test-token'
          }
        })
      )
    })

    it('should throw error when API request fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error'
      })

      await expect(
        client.load({ measures: ['Users.count'] })
      ).rejects.toThrow('Cube query failed: 500')
    })
  })

  describe('sql method', () => {
    it('should make GET request to /sql endpoint with query param', async () => {
      const mockResponse = {
        sql: 'SELECT COUNT(*) as "Users.count" FROM users'
      }
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse)
      })

      const query: CubeQuery = {
        measures: ['Users.count']
      }

      const result = await client.sql(query)

      const expectedUrl = 'http://localhost:4000/cubejs-api/v1/sql?query=' + encodeURIComponent(JSON.stringify(query))

      expect(mockFetch).toHaveBeenCalledWith(
        expectedUrl,
        expect.objectContaining({
          method: 'GET',
          credentials: 'include'
        })
      )

      expect(result).toEqual(mockResponse)
    })
  })

  describe('meta method', () => {
    it('should make GET request to /meta endpoint', async () => {
      const mockResponse = {
        cubes: [
          {
            name: 'Users',
            measures: [{ name: 'Users.count', type: 'count' }],
            dimensions: []
          }
        ]
      }
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse)
      })

      const result = await client.meta()

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4000/cubejs-api/v1/meta',
        expect.objectContaining({
          method: 'GET',
          credentials: 'include'
        })
      )

      expect(result).toEqual(mockResponse)
    })
  })

  describe('max-age headers', () => {
    function okResponse(body: unknown) {
      return { ok: true, json: () => Promise.resolve(body) }
    }

    function headersOfCall(index = 0): Headers {
      const init: { headers: Record<string, string> } = mockFetch.mock.calls[index][1]
      return new Headers(init.headers)
    }

    const query: CubeQuery = { measures: ['Users.count'] }

    it('sends no max-age header by default', async () => {
      mockFetch.mockResolvedValueOnce(okResponse({ data: [] }))
      await client.load(query)

      const headers = headersOfCall()
      expect(headers.get('x-cache-max-age')).toBeNull()
      expect(headers.get('x-cache-control')).toBeNull()
    })

    it('sends x-cache-max-age on load', async () => {
      mockFetch.mockResolvedValueOnce(okResponse({ data: [] }))
      await client.load(query, { maxAgeSeconds: 30 })

      const headers = headersOfCall()
      expect(headers.get('x-cache-max-age')).toBe('30')
      expect(headers.get('x-cache-control')).toBeNull()
    })

    it('sends max-age 0 (and no-cache for older servers) for a bust on load', async () => {
      mockFetch.mockResolvedValueOnce(okResponse({ data: [] }))
      await client.load(query, { bustCache: true })

      const headers = headersOfCall()
      expect(headers.get('x-cache-max-age')).toBe('0')
      expect(headers.get('x-cache-control')).toBe('no-cache')
    })

    it('rounds fractional max-ages down and ignores negative ones', async () => {
      mockFetch.mockResolvedValue(okResponse({ data: [] }))
      await client.load(query, { maxAgeSeconds: 12.9 })
      await client.load(query, { maxAgeSeconds: -1 })

      expect(headersOfCall(0).get('x-cache-max-age')).toBe('12')
      expect(headersOfCall(1).get('x-cache-max-age')).toBeNull()
    })

    it('sends x-cache-max-age on batchLoad', async () => {
      mockFetch.mockResolvedValueOnce(okResponse({ results: [{ success: true, data: [] }] }))
      await client.batchLoad([query], { maxAgeSeconds: 10 })

      const [url] = mockFetch.mock.calls[0]
      expect(url).toBe('http://localhost:4000/cubejs-api/v1/batch')
      const headers = headersOfCall()
      expect(headers.get('x-cache-max-age')).toBe('10')
      expect(headers.get('content-type')).toBe('application/json')
    })

    it('sends max-age 0 for a bust on batchLoad', async () => {
      mockFetch.mockResolvedValueOnce(okResponse({ results: [{ success: true, data: [] }] }))
      await client.batchLoad([query], { bustCache: true })

      const headers = headersOfCall()
      expect(headers.get('x-cache-max-age')).toBe('0')
      expect(headers.get('x-cache-control')).toBe('no-cache')
    })
  })

  describe('result set freshness', () => {
    it('exposes lastRefreshTime and cache info from the nested response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          results: [{
            data: [],
            lastRefreshTime: '2026-10-23T10:00:30.000Z',
            cache: { hit: true, cachedAt: '2026-10-23T10:00:00.000Z', ttlMs: 300000, ttlRemainingMs: 270000 }
          }]
        })
      })

      const resultSet = await client.load({ measures: ['Users.count'] })

      expect(resultSet.lastRefreshTime?.()).toBe('2026-10-23T10:00:30.000Z')
      expect(resultSet.cacheInfo?.()?.cachedAt).toBe('2026-10-23T10:00:00.000Z')
    })
  })

  describe('refresh keys on loads (issue #271)', () => {
    it('sends per-query refresh keys in the /batch body, and none when there are none', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ results: [{ success: true, data: [] }, { success: true, data: [] }] }) })
      const a: CubeQuery = { measures: ['A.count'] }
      const b: CubeQuery = { measures: ['B.count'] }

      await client.batchLoad([a, b], undefined, ['key-a', undefined])
      await client.batchLoad([a, b])

      expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ queries: [a, b], refreshKeys: ['key-a', null] })
      expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({ queries: [a, b] })
    })

    it('sends X-Refresh-Key on load when asked to', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: [] }) })
      await client.load({ measures: ['A.count'] }, { refreshKey: 'k9' })
      expect(mockFetch.mock.calls[0][1].headers['X-Refresh-Key']).toBe('k9')
    })
  })

  describe('subscribe (issue #271): change detection through /refresh-keys', () => {
    const query: CubeQuery = { measures: ['Users.count'] }
    const calls: Array<{ error: Error | null; rows: unknown[] | null }> = []
    const callback = (error: Error | null, resultSet: CubeResultSet | null) => {
      calls.push({ error, rows: resultSet ? resultSet.rawData() : null })
    }

    /**
     * A fake server behind fetch: `/refresh-keys` answers from `keys` (by
     * query JSON) or with `refreshKeysStatus`; `/load` answers from `loads`
     * in order, then repeats the last one.
     */
    let keys: Map<string, string | null>
    let refreshKeysStatus: number
    let loads: Array<{ rows: unknown[]; fingerprint?: string } | { status: number; error: string }>
    let requests: Array<{ path: string; headers: Record<string, string>; body?: { queries: CubeQuery[] } }>

    function loadRequests() {
      return requests.filter(request => request.path === 'load')
    }

    function refreshKeyRequests() {
      return requests.filter(request => request.path === 'refresh-keys')
    }

    async function advanceSeconds(seconds: number) {
      await vi.advanceTimersByTimeAsync(seconds * 1000)
    }

    beforeEach(() => {
      vi.useFakeTimers()
      calls.length = 0
      keys = new Map()
      refreshKeysStatus = 200
      loads = [{ rows: [{ n: 1 }], fingerprint: 'fp-1' }]
      requests = []
      mockFetch.mockImplementation(async (url: string, init: { headers: Record<string, string>; body?: string }) => {
        const path = url.includes('/refresh-keys') ? 'refresh-keys' : url.includes('/load') ? 'load' : 'other'
        const body = init.body ? JSON.parse(init.body) : undefined
        requests.push({ path, headers: init.headers, body })
        if (path === 'refresh-keys') {
          if (refreshKeysStatus !== 200) {
            return { ok: false, status: refreshKeysStatus, text: () => Promise.resolve('{"error":"Not found"}') }
          }
          const queries: CubeQuery[] = body.queries
          return {
            ok: true,
            json: () => Promise.resolve({
              keys: queries.map(q => ({ key: keys.has(JSON.stringify(q)) ? keys.get(JSON.stringify(q)) : 'k1', checkAfterSeconds: 10 }))
            })
          }
        }
        const next = loads.length > 1 ? loads.shift()! : loads[0]
        if ('status' in next) {
          return { ok: false, status: next.status, text: () => Promise.resolve(JSON.stringify({ error: next.error })) }
        }
        return { ok: true, json: () => Promise.resolve({ results: [{ data: next.rows, fingerprint: next.fingerprint }] }) }
      })
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('delivers the initial load, then checks keys and does not reload while they stay the same', async () => {
      const subscription = client.subscribe(query, null, callback)

      await advanceSeconds(0.1)
      expect(calls).toEqual([{ error: null, rows: [{ n: 1 }] }])
      expect(refreshKeyRequests()).toHaveLength(1)

      await advanceSeconds(30)
      expect(refreshKeyRequests()).toHaveLength(4)
      expect(loadRequests()).toHaveLength(1)
      expect(calls).toHaveLength(1)

      subscription.unsubscribe()
    })

    it('reloads with the new key in X-Refresh-Key when the key changes', async () => {
      loads = [{ rows: [{ n: 1 }], fingerprint: 'fp-1' }, { rows: [{ n: 2 }], fingerprint: 'fp-2' }]
      const subscription = client.subscribe(query, null, callback)
      await advanceSeconds(0.1)

      keys.set(JSON.stringify(query), 'k2')
      await advanceSeconds(10)

      expect(loadRequests()).toHaveLength(2)
      expect(loadRequests()[1].headers['X-Refresh-Key']).toBe('k2')
      expect(loadRequests()[1].headers['X-Cache-Max-Age']).toBeUndefined()
      expect(calls[1]).toEqual({ error: null, rows: [{ n: 2 }] })

      subscription.unsubscribe()
    })

    it('sends one /refresh-keys call per tick for every subscription on the client', async () => {
      const other: CubeQuery = { measures: ['Orders.count'] }
      const a = client.subscribe(query, null, callback)
      const b = client.subscribe(other, null, callback)
      await advanceSeconds(0.1)
      await advanceSeconds(10)

      expect(refreshKeyRequests()).toHaveLength(2)
      expect(refreshKeyRequests()[1].body?.queries).toEqual([query, other])

      a.unsubscribe()
      b.unsubscribe()
    })

    it('does not call back when a reload returns the same fingerprint', async () => {
      loads = [{ rows: [{ n: 1 }], fingerprint: 'same' }, { rows: [{ n: 1 }], fingerprint: 'same' }]
      const subscription = client.subscribe(query, null, callback)
      await advanceSeconds(0.1)

      keys.set(JSON.stringify(query), 'k2')
      await advanceSeconds(10)

      expect(loadRequests()).toHaveLength(2)
      expect(calls).toHaveLength(1)
      subscription.unsubscribe()
    })

    it('calls back for a reload without a fingerprint (an older server)', async () => {
      loads = [{ rows: [{ n: 1 }] }, { rows: [{ n: 1 }] }]
      const subscription = client.subscribe(query, null, callback)
      await advanceSeconds(0.1)

      keys.set(JSON.stringify(query), 'k2')
      await advanceSeconds(10)

      expect(calls).toHaveLength(2)
      subscription.unsubscribe()
    })

    it('falls back to reloading every 10 s with max-age 10 when the server has no /refresh-keys', async () => {
      refreshKeysStatus = 404
      loads = [{ rows: [{ n: 1 }] }, { rows: [{ n: 2 }] }, { rows: [{ n: 3 }] }]
      const subscription = client.subscribe(query, { bustCache: true }, callback)

      await advanceSeconds(0.1)
      expect(loadRequests()[0].headers['X-Cache-Max-Age']).toBe('0')

      await advanceSeconds(9)
      expect(loadRequests()).toHaveLength(1)
      await advanceSeconds(1)
      expect(loadRequests()).toHaveLength(2)
      expect(loadRequests()[1].headers['X-Cache-Max-Age']).toBe('10')
      await advanceSeconds(10)
      expect(calls.map(call => call.rows)).toEqual([[{ n: 1 }], [{ n: 2 }], [{ n: 3 }]])

      subscription.unsubscribe()
    })

    it('reloads once more when a key changes while a load is still running', async () => {
      let resolveFirst: (value: unknown) => void = () => {}
      const fallthrough = mockFetch.getMockImplementation()
      let firstLoad = true
      mockFetch.mockImplementation((url: string, init: { headers: Record<string, string>; body?: string }) => {
        if (url.includes('/load') && firstLoad) {
          firstLoad = false
          requests.push({ path: 'load', headers: init.headers })
          return new Promise(resolve => { resolveFirst = resolve })
        }
        return fallthrough?.(url, init)
      })
      loads = [{ rows: [{ n: 2 }], fingerprint: 'fp-2' }]
      const subscription = client.subscribe(query, null, callback)
      await advanceSeconds(0.1)

      // The key moves while the initial load is still running
      keys.set(JSON.stringify(query), 'k2')
      await advanceSeconds(0.1)
      keys.set(JSON.stringify(query), 'k3')
      await advanceSeconds(10)
      expect(loadRequests()).toHaveLength(1)

      resolveFirst({ ok: true, json: () => Promise.resolve({ results: [{ data: [{ n: 1 }], fingerprint: 'fp-1' }] }) })
      await advanceSeconds(0.1)

      expect(loadRequests()).toHaveLength(2)
      expect(loadRequests()[1].headers['X-Refresh-Key']).toBe('k3')
      expect(calls.map(call => call.rows)).toEqual([[{ n: 1 }], [{ n: 2 }]])
      subscription.unsubscribe()
    })

    it('stops checking on unsubscribe', async () => {
      const subscription = client.subscribe(query, null, callback)
      await advanceSeconds(0.1)
      subscription.unsubscribe()
      keys.set(JSON.stringify(query), 'k2')
      await advanceSeconds(60)

      expect(refreshKeyRequests()).toHaveLength(1)
      expect(loadRequests()).toHaveLength(1)
    })

    it('drops a result still in flight when unsubscribed', async () => {
      let resolveLoad: (value: unknown) => void = () => {}
      mockFetch.mockReturnValueOnce(new Promise(resolve => { resolveLoad = resolve }))
      const subscription = client.subscribe(query, null, callback)

      subscription.unsubscribe()
      resolveLoad({ ok: true, json: () => Promise.resolve({ data: [{ n: 1 }] }) })
      await advanceSeconds(30)

      expect(calls).toHaveLength(0)
    })

    it('delivers errors to the callback and keeps going', async () => {
      loads = [{ status: 500, error: 'boom' }, { rows: [{ n: 2 }], fingerprint: 'fp-2' }]
      const subscription = client.subscribe(query, null, callback)

      await advanceSeconds(0.1)
      expect(calls[0].error?.message).toBe('boom')
      expect(calls[0].rows).toBeNull()

      keys.set(JSON.stringify(query), 'k2')
      await advanceSeconds(10)
      expect(calls[1]).toEqual({ error: null, rows: [{ n: 2 }] })

      subscription.unsubscribe()
    })

    it('checks no more often than minSubscribeIntervalSeconds', async () => {
      const slowClient = new CubeClient(undefined, {
        apiUrl: 'http://localhost:4000/cubejs-api/v1',
        minSubscribeIntervalSeconds: 30
      })
      const subscription = slowClient.subscribe(query, null, callback)
      await advanceSeconds(0.1)

      await advanceSeconds(29)
      expect(refreshKeyRequests()).toHaveLength(1)
      await advanceSeconds(1)
      expect(refreshKeyRequests()).toHaveLength(2)

      subscription.unsubscribe()
    })
  })
})
