import { describe, it, expect, vi } from 'vitest'
import { createCubeHttpHandler } from '../../src/adapters/core'
import type { HttpPort } from '../../src/adapters/core'

/**
 * Unit tests for the framework-agnostic REST /load core.
 * No server, no DB — a stub semanticLayer and a fake port exercise the flow.
 */

/** Minimal stub of the bits of SemanticLayerCompiler the load core touches. */
function createStubSemanticLayer(overrides: Record<string, any> = {}) {
  return {
    getEngineType: () => 'postgres',
    validateQuery: vi.fn(() => ({ isValid: true, errors: [] })),
    executeMultiCubeQuery: vi.fn(async () => ({ data: [{ 'Employees.count': 5 }], annotation: { measures: {} } })),
    ...overrides
  } as any
}

/** Records send() calls and exposes headers/body/query for the handler to read. */
function createFakePort(opts: {
  headers?: Record<string, string>
  body?: unknown
  queryParams?: Record<string, string>
} = {}): HttpPort<{ status: number; body: unknown }> & {
  sent: Array<{ status: number; body: unknown }>
  headersSet: Record<string, string>
} {
  const sent: Array<{ status: number; body: unknown }> = []
  const headersSet: Record<string, string> = {}
  return {
    sent,
    headersSet,
    setHeader: (name: string, value: string) => { headersSet[name] = value },
    getHeader: (name: string) => opts.headers?.[name.toLowerCase()],
    getBody: async () => opts.body,
    getQueryParam: (name: string) => opts.queryParams?.[name],
    send: (status: number, body: unknown) => {
      const result = { status, body }
      sent.push(result)
      return result
    }
  }
}

describe('createCubeHttpHandler — REST /load core', () => {
  const baseSecurityContext = { organisationId: 'org1' }
  const getBaseSC = async () => baseSecurityContext

  it('POST happy path returns a 200 Cube.js envelope', async () => {
    const semanticLayer = createStubSemanticLayer()
    const handler = createCubeHttpHandler({ semanticLayer, onError: vi.fn() })
    const port = createFakePort({ body: { measures: ['Employees.count'] } })

    await handler.handleLoadPost(port, getBaseSC)

    expect(port.sent).toHaveLength(1)
    expect(port.sent[0].status).toBe(200)
    const envelope = port.sent[0].body as any
    expect(envelope.queryType).toBe('regularQuery')
    expect(envelope.results[0].data).toEqual([{ 'Employees.count': 5 }])
  })

  it('POST validation failure returns a 400 without executing', async () => {
    const semanticLayer = createStubSemanticLayer({
      validateQuery: vi.fn(() => ({ isValid: false, errors: ['Unknown member Foo.bar'] }))
    })
    const handler = createCubeHttpHandler({ semanticLayer, onError: vi.fn() })
    const port = createFakePort({ body: { measures: ['Foo.bar'] } })

    await handler.handleLoadPost(port, getBaseSC)

    expect(port.sent).toHaveLength(1)
    expect(port.sent[0].status).toBe(400)
    expect((port.sent[0].body as any).error).toContain('Query validation failed')
    expect(semanticLayer.executeMultiCubeQuery).not.toHaveBeenCalled()
  })

  it('GET happy path parses the query param and returns a 200 envelope', async () => {
    const semanticLayer = createStubSemanticLayer()
    const handler = createCubeHttpHandler({ semanticLayer, onError: vi.fn() })
    const port = createFakePort({
      queryParams: { query: JSON.stringify({ measures: ['Employees.count'] }) }
    })

    await handler.handleLoadGet(port, getBaseSC)

    expect(port.sent[0].status).toBe(200)
    expect(semanticLayer.executeMultiCubeQuery).toHaveBeenCalledWith(
      { measures: ['Employees.count'] },
      expect.anything(),
      expect.anything()
    )
  })

  it('GET with missing query param returns 400 "Query parameter is required"', async () => {
    const semanticLayer = createStubSemanticLayer()
    const onError = vi.fn()
    const handler = createCubeHttpHandler({ semanticLayer, onError })
    const port = createFakePort({ queryParams: {} })

    await handler.handleLoadGet(port, getBaseSC)

    expect(port.sent[0].status).toBe(400)
    expect((port.sent[0].body as any).error).toBe('Query parameter is required')
    expect(semanticLayer.executeMultiCubeQuery).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('GET with invalid JSON returns 400 "Invalid JSON in query parameter"', async () => {
    const semanticLayer = createStubSemanticLayer()
    const onError = vi.fn()
    const handler = createCubeHttpHandler({ semanticLayer, onError })
    const port = createFakePort({ queryParams: { query: '{not valid json' } })

    await handler.handleLoadGet(port, getBaseSC)

    expect(port.sent[0].status).toBe(400)
    expect((port.sent[0].body as any).error).toBe('Invalid JSON in query parameter')
    expect(semanticLayer.executeMultiCubeQuery).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('a thrown executor error returns 500 and calls onError exactly once', async () => {
    const boom = new Error('connection refused')
    const semanticLayer = createStubSemanticLayer({
      executeMultiCubeQuery: vi.fn(async () => { throw boom })
    })
    const onError = vi.fn()
    const handler = createCubeHttpHandler({ semanticLayer, onError })
    const port = createFakePort({ body: { measures: ['Employees.count'] } })

    await handler.handleLoadPost(port, getBaseSC)

    expect(port.sent[0].status).toBe(500)
    expect((port.sent[0].body as any).error).toBe('connection refused')
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(boom)
  })

  it('merges the X-DC-Locale header into the security context the executor receives', async () => {
    const semanticLayer = createStubSemanticLayer()
    const handler = createCubeHttpHandler({ semanticLayer, onError: vi.fn() })
    const port = createFakePort({
      body: { measures: ['Employees.count'] },
      headers: { 'x-dc-locale': 'nl-NL' }
    })

    await handler.handleLoadPost(port, getBaseSC)

    const [, securityContext] = semanticLayer.executeMultiCubeQuery.mock.calls[0]
    expect(securityContext).toMatchObject({ organisationId: 'org1', locale: 'nl-NL' })
  })
})

describe('createCubeHttpHandler — tenant scoping and cache headers', () => {
  const securityContext = { organisationId: 'org1' }
  const getBaseSC = async () => securityContext

  it('resolves the security context for /meta and returns that tenant\'s cubes', async () => {
    const semanticLayer = createStubSemanticLayer({
      getMetadata: vi.fn(() => [{ name: 'Employees', measures: [], dimensions: [] }])
    })
    const handler = createCubeHttpHandler({ semanticLayer, onError: vi.fn() })
    const port = createFakePort()

    await handler.handleMetaGet(port, getBaseSC)

    // /meta never touched the extractor before this release.
    expect(semanticLayer.getMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ organisationId: 'org1' })
    )
    expect(port.sent[0].status).toBe(200)
    expect((port.sent[0].body as any).cubes).toHaveLength(1)
  })

  it('sets Cache-Control: private, no-store on every REST response', async () => {
    const semanticLayer = createStubSemanticLayer({
      getMetadata: vi.fn(() => []),
      generateMultiCubeSQL: vi.fn(async () => ({ sql: 'SELECT 1', params: [] })),
      dryRun: vi.fn(async () => ({ sql: 'SELECT 1', params: [] })),
      explainQuery: vi.fn(async () => ({ plan: [] }))
    })
    const handler = createCubeHttpHandler({ semanticLayer, onError: vi.fn() })
    const body = { measures: ['Employees.count'] }

    const calls: Array<[string, () => Promise<unknown>]> = []
    const ports: Record<string, ReturnType<typeof createFakePort>> = {}
    for (const name of ['load', 'meta', 'sql', 'dryRun', 'batch', 'explain']) {
      ports[name] = createFakePort({ body: name === 'batch' ? { queries: [body] } : body })
    }
    calls.push(['load', () => handler.handleLoadPost(ports.load, getBaseSC)])
    calls.push(['meta', () => handler.handleMetaGet(ports.meta, getBaseSC)])
    calls.push(['sql', () => handler.handleSqlPost(ports.sql, getBaseSC)])
    calls.push(['dryRun', () => handler.handleDryRunPost(ports.dryRun, getBaseSC)])
    calls.push(['batch', () => handler.handleBatchPost(ports.batch, getBaseSC)])
    calls.push(['explain', () => handler.handleExplainPost(ports.explain, getBaseSC)])

    for (const [, invoke] of calls) await invoke()

    // Tenant-scoped data must never be heuristically cached by a shared cache.
    for (const [name] of calls) {
      expect(ports[name].headersSet['Cache-Control'], `${name} response`).toBe('private, no-store')
    }
  })

  it('sets the cache header on error responses too', async () => {
    const semanticLayer = createStubSemanticLayer({
      validateQuery: vi.fn(() => ({ isValid: false, errors: ['nope'] }))
    })
    const handler = createCubeHttpHandler({ semanticLayer, onError: vi.fn() })
    const port = createFakePort({ body: { measures: ['Foo.bar'] } })

    await handler.handleLoadPost(port, getBaseSC)

    expect(port.sent[0].status).toBe(400)
    expect(port.headersSet['Cache-Control']).toBe('private, no-store')
  })
})

describe('createCubeHttpHandler — x-cache-max-age', () => {
  const getBaseSC = async () => ({ organisationId: 'org1' })
  const query = { measures: ['Employees.count'] }

  /** Run one request through the named endpoint and return the ExecutionOptions it passed. */
  async function optionsFor(endpoint: 'loadPost' | 'loadGet' | 'batch', headers: Record<string, string>) {
    const semanticLayer = createStubSemanticLayer()
    const handler = createCubeHttpHandler({ semanticLayer, onError: vi.fn() })
    if (endpoint === 'loadPost') {
      await handler.handleLoadPost(createFakePort({ body: query, headers }), getBaseSC)
    } else if (endpoint === 'loadGet') {
      await handler.handleLoadGet(
        createFakePort({ queryParams: { query: JSON.stringify(query) }, headers }),
        getBaseSC
      )
    } else {
      await handler.handleBatchPost(createFakePort({ body: { queries: [query, query] }, headers }), getBaseSC)
    }
    const calls = semanticLayer.executeMultiCubeQuery.mock.calls
    expect(calls.length).toBeGreaterThan(0)
    return calls.map((call: unknown[]) => call[2])
  }

  for (const endpoint of ['loadPost', 'loadGet', 'batch'] as const) {
    describe(endpoint, () => {
      it('maps the header (seconds) to maxAgeMs', async () => {
        for (const [value, maxAgeMs] of [['30', 30000], ['0', 0]] as const) {
          for (const options of await optionsFor(endpoint, { 'x-cache-max-age': value })) {
            expect(options, `x-cache-max-age: ${value}`).toEqual(expect.objectContaining({ maxAgeMs }))
          }
        }
      })

      it('ignores invalid values', async () => {
        for (const value of ['-5', '1.5', 'abc', '', '10s', '1e3']) {
          for (const options of await optionsFor(endpoint, { 'x-cache-max-age': value })) {
            expect(options?.maxAgeMs, `x-cache-max-age: ${JSON.stringify(value)}`).toBeUndefined()
          }
        }
      })

      it('sends no max-age when neither header is present', async () => {
        for (const options of await optionsFor(endpoint, {})) {
          expect(options?.maxAgeMs).toBeUndefined()
        }
      })

      // Precedence (skipCache wins) is resolved by the result cache; see cache-max-age.test.ts
      it('forwards both x-cache-control: no-cache and max-age', async () => {
        for (const options of await optionsFor(endpoint, { 'x-cache-max-age': '60', 'x-cache-control': 'no-cache' })) {
          expect(options).toEqual({ skipCache: true, maxAgeMs: 60000 })
        }
      })
    })
  }
})

describe('createCubeHttpHandler — x-refresh-key', () => {
  const getBaseSC = async () => ({ organisationId: 'org1' })
  const query = { measures: ['Employees.count'] }

  async function optionsFor(endpoint: 'loadPost' | 'batch', headers: Record<string, string>) {
    const semanticLayer = createStubSemanticLayer()
    const handler = createCubeHttpHandler({ semanticLayer, onError: vi.fn() })
    if (endpoint === 'loadPost') {
      await handler.handleLoadPost(createFakePort({ body: query, headers }), getBaseSC)
    } else {
      await handler.handleBatchPost(createFakePort({ body: { queries: [query] }, headers }), getBaseSC)
    }
    return semanticLayer.executeMultiCubeQuery.mock.calls.map((call: unknown[]) => call[2])
  }

  for (const endpoint of ['loadPost', 'batch'] as const) {
    it(`${endpoint}: forwards a valid refresh key and ignores an invalid one`, async () => {
      const key = '0123456789abcdef0123456789abcdef'
      for (const options of await optionsFor(endpoint, { 'x-refresh-key': key })) {
        expect(options).toEqual(expect.objectContaining({ refreshKey: key }))
      }
      for (const value of ['', 'has space', 'x'.repeat(129), 'semi;colon']) {
        for (const options of await optionsFor(endpoint, { 'x-refresh-key': value })) {
          expect(options?.refreshKey, `x-refresh-key: ${JSON.stringify(value)}`).toBeUndefined()
        }
      }
    })
  }

  it('returns the result fingerprint on /load and /batch', async () => {
    const semanticLayer = createStubSemanticLayer({
      executeMultiCubeQuery: vi.fn(async () => ({ data: [{ 'Employees.count': 5 }], fingerprint: 'fp-1' }))
    })
    const handler = createCubeHttpHandler({ semanticLayer, onError: vi.fn() })
    const loadPort = createFakePort({ body: query })
    const batchPort = createFakePort({ body: { queries: [query] } })

    await handler.handleLoadPost(loadPort, getBaseSC)
    await handler.handleBatchPost(batchPort, getBaseSC)

    expect(loadPort.sent[0].body).toEqual(expect.objectContaining({
      results: [expect.objectContaining({ fingerprint: 'fp-1' })]
    }))
    expect(batchPort.sent[0].body).toEqual({
      results: [expect.objectContaining({ success: true, results: [expect.objectContaining({ fingerprint: 'fp-1' })] })]
    })
  })
})

describe('createCubeHttpHandler — POST /refresh-keys', () => {
  const getBaseSC = async () => ({ organisationId: 'org1' })
  const queries = [{ measures: ['Employees.count'] }, { measures: ['Departments.count'] }]
  const keys = [{ key: 'a'.repeat(32), checkAfterSeconds: 10 }, { key: null, checkAfterSeconds: 120 }]

  it('returns the keys with no-store, resolving the security context like /load', async () => {
    const semanticLayer = createStubSemanticLayer({ getRefreshKeys: vi.fn(async () => keys) })
    const handler = createCubeHttpHandler({ semanticLayer, onError: vi.fn() })
    const port = createFakePort({ body: { queries }, headers: { 'x-dc-locale': 'nl-NL' } })

    await handler.handleRefreshKeysPost(port, getBaseSC)

    expect(port.sent).toEqual([{ status: 200, body: { keys } }])
    expect(port.headersSet['Cache-Control']).toBe('private, no-store')
    expect(semanticLayer.getRefreshKeys).toHaveBeenCalledWith(
      queries,
      expect.objectContaining({ organisationId: 'org1', locale: 'nl-NL' })
    )
    // Same context resolution as /load
    const loadLayer = createStubSemanticLayer()
    await createCubeHttpHandler({ semanticLayer: loadLayer, onError: vi.fn() })
      .handleLoadPost(createFakePort({ body: queries[0], headers: { 'x-dc-locale': 'nl-NL' } }), getBaseSC)
    expect(semanticLayer.getRefreshKeys.mock.calls[0][1]).toEqual(loadLayer.executeMultiCubeQuery.mock.calls[0][1])
  })

  it('rejects an unknown member with the same 400 as /load, without evaluating keys', async () => {
    const invalid = {
      isValid: false,
      errors: ["Measure 'Employees.nope' not found"],
      issues: [{ member: 'Employees.nope', kind: 'measure' }]
    }
    const semanticLayer = createStubSemanticLayer({
      validateQuery: vi.fn(() => invalid),
      getRefreshKeys: vi.fn()
    })
    const handler = createCubeHttpHandler({ semanticLayer, onError: vi.fn() })
    const refreshPort = createFakePort({ body: { queries: [{ measures: ['Employees.nope'] }] } })
    const loadPort = createFakePort({ body: { measures: ['Employees.nope'] } })

    await handler.handleRefreshKeysPost(refreshPort, getBaseSC)
    await handler.handleLoadPost(loadPort, getBaseSC)

    expect(refreshPort.sent[0].status).toBe(400)
    expect(refreshPort.sent).toEqual(loadPort.sent)
    expect(semanticLayer.getRefreshKeys).not.toHaveBeenCalled()
  })

  it('rejects a body without a non-empty queries array', async () => {
    const semanticLayer = createStubSemanticLayer({ getRefreshKeys: vi.fn() })
    const handler = createCubeHttpHandler({ semanticLayer, onError: vi.fn() })
    for (const body of [{}, { queries: 'x' }, { queries: [] }]) {
      const port = createFakePort({ body })
      await handler.handleRefreshKeysPost(port, getBaseSC)
      expect(port.sent[0].status).toBe(400)
    }
    expect(semanticLayer.getRefreshKeys).not.toHaveBeenCalled()
  })
})

describe('createCubeHttpHandler — /batch per-query refreshKeys', () => {
  const getBaseSC = async () => ({ organisationId: 'org1' })
  const q1 = { measures: ['Employees.count'] }
  const q2 = { measures: ['Departments.count'] }

  it('applies each body refresh key to its own query, falling back to the header', async () => {
    const semanticLayer = createStubSemanticLayer()
    const handler = createCubeHttpHandler({ semanticLayer, onError: vi.fn() })
    await handler.handleBatchPost(createFakePort({
      body: { queries: [q1, q2, q1], refreshKeys: ['key-1', null, 'bad key'] },
      headers: { 'x-refresh-key': 'header-key' }
    }), getBaseSC)

    const refreshKeys = semanticLayer.executeMultiCubeQuery.mock.calls.map((call: unknown[]) => {
      const options = call[2] as { refreshKey?: string } | undefined
      return options?.refreshKey
    })
    expect(refreshKeys).toEqual(['key-1', 'header-key', 'header-key'])
  })
})
