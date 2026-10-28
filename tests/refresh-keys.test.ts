/**
 * Refresh keys: per-cube change signals, composed per query into a hashed
 * composite key by SemanticLayerCompiler.getRefreshKeys.
 *
 * Writes go to a dedicated organisation (WRITE_ORG) and are removed after each
 * test, so the shared seed data other suites read stays untouched.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import {
  SemanticLayerCompiler,
  MemoryCacheProvider,
  assertRefreshKeyIsContextScoped
} from '../src/server'
import { defineCube } from '../src/server/cube-utils'
import type { Cube, CubeRefreshKey, SemanticQuery, SecurityContext } from '../src/server/types'
import { createTestDatabaseExecutor, getTestSchema, getTestDatabaseType } from './helpers/test-database'

const WRITE_ORG = 9271
const writeCtx = { organisationId: WRITE_ORG, userId: 1 }
const org1 = { organisationId: 1, userId: 1 }
const org2 = { organisationId: 2, userId: 2 }

// DuckDB tests run on a read-only connection; Snowflake/Databend writes are slow and engine-specific.
const canWrite = !['duckdb', 'snowflake', 'databend'].includes(getTestDatabaseType())

describe.skipIf(!canWrite)('Refresh keys', () => {
  let schema: Awaited<ReturnType<typeof getTestSchema>>
  let dbExecutor: Awaited<ReturnType<typeof createTestDatabaseExecutor>>['executor']
  let close: () => void

  beforeAll(async () => {
    const created = await createTestDatabaseExecutor()
    dbExecutor = created.executor
    close = created.close
    schema = await getTestSchema()
  })

  afterEach(async () => {
    vi.useRealTimers()
    const { employees, departments } = schema
    await dbExecutor.db.delete(employees).where(eq(employees.organisationId, WRITE_ORG))
    await dbExecutor.db.delete(departments).where(eq(departments.organisationId, WRITE_ORG))
  })

  afterAll(() => close?.())

  interface CubeKeys {
    employees?: CubeRefreshKey
    departments?: CubeRefreshKey
    productivity?: CubeRefreshKey
  }

  /** Employees → Departments, Productivity → Employees, each tenant-filtered. */
  function buildCubes(keys: CubeKeys = {}): Cube[] {
    const { employees, departments, productivity } = schema
    let employeesCube: Cube
    let departmentsCube: Cube
    let productivityCube: Cube

    departmentsCube = defineCube('Departments', {
      sql: (ctx) => ({ from: departments, where: eq(departments.organisationId, ctx.securityContext.organisationId) }),
      refreshKey: keys.departments,
      dimensions: {
        id: { name: 'id', type: 'number', sql: departments.id, primaryKey: true },
        name: { name: 'name', type: 'string', sql: departments.name }
      },
      measures: { count: { name: 'count', type: 'count', sql: departments.id } }
    })

    employeesCube = defineCube('Employees', {
      sql: (ctx) => ({ from: employees, where: eq(employees.organisationId, ctx.securityContext.organisationId) }),
      refreshKey: keys.employees,
      joins: {
        Departments: {
          targetCube: () => departmentsCube,
          relationship: 'belongsTo',
          on: [{ source: employees.departmentId, target: departments.id }]
        }
      },
      dimensions: {
        id: { name: 'id', type: 'number', sql: employees.id, primaryKey: true },
        name: { name: 'name', type: 'string', sql: employees.name },
        createdAt: { name: 'createdAt', type: 'time', sql: employees.createdAt }
      },
      measures: {
        count: { name: 'count', type: 'count', sql: employees.id },
        totalSalary: { name: 'totalSalary', type: 'sum', sql: employees.salary }
      }
    })

    productivityCube = defineCube('Productivity', {
      sql: (ctx) => ({ from: productivity, where: eq(productivity.organisationId, ctx.securityContext.organisationId) }),
      refreshKey: keys.productivity,
      joins: {
        Employees: {
          targetCube: () => employeesCube,
          relationship: 'belongsTo',
          on: [{ source: productivity.employeeId, target: employees.id }]
        }
      },
      dimensions: {
        id: { name: 'id', type: 'number', sql: productivity.id, primaryKey: true },
        employeeId: { name: 'employeeId', type: 'number', sql: productivity.employeeId },
        date: { name: 'date', type: 'time', sql: productivity.date },
        linesOfCode: { name: 'linesOfCode', type: 'number', sql: productivity.linesOfCode }
      },
      measures: { totalLinesOfCode: { name: 'totalLinesOfCode', type: 'sum', sql: productivity.linesOfCode } }
    })

    return [employeesCube, departmentsCube, productivityCube]
  }

  const employeesKey: CubeRefreshKey = {
    sql: (ctx) => sql`select count(*) + coalesce(sum(${schema.employees.salary}), 0) from ${schema.employees} where ${ctx.baseQuery.where}`
  }
  const departmentsKey: CubeRefreshKey = {
    sql: (ctx) => sql`select count(*) + coalesce(sum(${schema.departments.budget}), 0) from ${schema.departments} where ${ctx.baseQuery.where}`
  }
  const productivityKey: CubeRefreshKey = {
    sql: (ctx) => sql`select count(*) from ${schema.productivity} where ${ctx.baseQuery.where}`
  }
  const failingKey: CubeRefreshKey = { sql: () => sql`select no_such_column_271` }
  const allKeys: CubeKeys = { employees: employeesKey, departments: departmentsKey, productivity: productivityKey }

  function createLayer(keys: CubeKeys = allKeys, options: ConstructorParameters<typeof SemanticLayerCompiler>[0] = {}) {
    const layer = new SemanticLayerCompiler({ databaseExecutor: dbExecutor, ...options })
    for (const cube of buildCubes(keys)) layer.registerCube(cube)
    return layer
  }

  const employeesQuery: SemanticQuery = { measures: ['Employees.count'] }
  const departmentsQuery: SemanticQuery = { measures: ['Departments.count'] }

  async function keyOf(layer: SemanticLayerCompiler, query: SemanticQuery, ctx: SecurityContext = writeCtx) {
    const [result] = await layer.getRefreshKeys([query], ctx)
    return result
  }

  async function insertEmployee(values: { name: string; salary?: number; departmentId?: number }) {
    await dbExecutor.db.insert(schema.employees).values({ organisationId: WRITE_ORG, ...values })
  }

  describe('key query', () => {
    it('changes after an insert, an update and a delete', async () => {
      const layer = createLayer()
      const { employees } = schema
      const initial = (await keyOf(layer, employeesQuery)).key
      expect(initial).toMatch(/^[0-9a-f]{32}$/)

      await insertEmployee({ name: 'Rk Insert', salary: 100 })
      const afterInsert = (await keyOf(layer, employeesQuery)).key
      expect(afterInsert).not.toBe(initial)

      await dbExecutor.db.update(employees).set({ salary: 250 })
        .where(and(eq(employees.organisationId, WRITE_ORG), eq(employees.name, 'Rk Insert')))
      const afterUpdate = (await keyOf(layer, employeesQuery)).key
      expect(afterUpdate).not.toBe(afterInsert)

      await dbExecutor.db.delete(employees).where(eq(employees.organisationId, WRITE_ORG))
      const afterDelete = (await keyOf(layer, employeesQuery)).key
      expect(afterDelete).not.toBe(afterUpdate)
      expect(afterDelete).toBe(initial)
    })

    it('stays the same while nothing changes', async () => {
      const layer = createLayer()
      expect((await keyOf(layer, employeesQuery)).key).toBe((await keyOf(layer, employeesQuery)).key)
    })

    it('differs between two tenants and between two contexts in one tenant', async () => {
      const layer = createLayer()
      const tenant1 = (await keyOf(layer, employeesQuery, org1)).key
      const tenant2 = (await keyOf(layer, employeesQuery, org2)).key
      const tenant1OtherUser = (await keyOf(layer, employeesQuery, { ...org1, userId: 42 })).key
      expect(tenant1).not.toBe(tenant2)
      expect(tenant1).not.toBe(tenant1OtherUser)
    })

    it('does not move for a write in another tenant', async () => {
      const layer = createLayer()
      const before = (await keyOf(layer, employeesQuery, org1)).key
      await insertEmployee({ name: 'Rk Other Tenant', salary: 1 })
      expect((await keyOf(layer, employeesQuery, org1)).key).toBe(before)
    })
  })

  describe('two-context helper', () => {
    const unscopedKeyQuery: CubeRefreshKey = {
      sql: () => sql`select count(*) from ${schema.departments}`
    }

    it('passes a scoped key query and a time bucket', async () => {
      const layer = createLayer({ ...allKeys, employees: { every: '1 minute' } })
      await expect(assertRefreshKeyIsContextScoped(layer, 'Departments', [org1, org2])).resolves.toBeUndefined()
      await expect(assertRefreshKeyIsContextScoped(layer, 'Employees', [org1, org2])).resolves.toBeUndefined()
    })

    it('fails an unscoped key query', async () => {
      const layer = createLayer({ ...allKeys, departments: unscopedKeyQuery })
      await expect(assertRefreshKeyIsContextScoped(layer, 'Departments', [org1, org2]))
        .rejects.toThrow(/Departments/)
    })
  })

  describe('time buckets', () => {
    it('`every` alone changes once per bucket', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      const layer = createLayer({ ...allKeys, employees: { every: '1 minute' } })

      const first = await keyOf(layer, employeesQuery)
      expect(first.checkAfterSeconds).toBe(60)
      vi.setSystemTime(new Date('2026-01-01T00:00:59.000Z'))
      expect((await keyOf(layer, employeesQuery)).key).toBe(first.key)
      vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'))
      expect((await keyOf(layer, employeesQuery)).key).not.toBe(first.key)
    })

    it('a cube without a refresh key gets the 10 second default bucket', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      const layer = createLayer({})

      const first = await keyOf(layer, employeesQuery)
      expect(first.checkAfterSeconds).toBe(10)
      vi.setSystemTime(new Date('2026-01-01T00:00:09.000Z'))
      expect((await keyOf(layer, employeesQuery)).key).toBe(first.key)
      vi.setSystemTime(new Date('2026-01-01T00:00:10.000Z'))
      expect((await keyOf(layer, employeesQuery)).key).not.toBe(first.key)
    })

    it('checkAfterSeconds is the smallest `every` among the dependent cubes', async () => {
      const layer = createLayer({
        employees: { ...employeesKey, every: '5 minutes' },
        departments: { ...departmentsKey, every: '30 seconds' }
      })
      const joined = await keyOf(layer, { measures: ['Employees.count'], dimensions: ['Departments.name'] })
      expect(joined.checkAfterSeconds).toBe(30)
      expect((await keyOf(layer, employeesQuery)).checkAfterSeconds).toBe(300)
    })
  })

  describe('dependent cubes', () => {
    it('a write to a join-path cube the query does not name changes its key', async () => {
      const layer = createLayer()
      // Productivity → Employees → Departments: Employees is only on the join path
      const query: SemanticQuery = { measures: ['Productivity.totalLinesOfCode'], dimensions: ['Departments.name'] }
      const before = (await keyOf(layer, query)).key
      await insertEmployee({ name: 'Rk Join Path', salary: 10 })
      expect((await keyOf(layer, query)).key).not.toBe(before)
    })

    it('a write to a funnel step cube changes the funnel key', async () => {
      const layer = createLayer()
      const funnel: SemanticQuery = {
        funnel: {
          bindingKey: [
            { cube: 'Productivity', dimension: 'Productivity.employeeId' },
            { cube: 'Employees', dimension: 'Employees.id' }
          ],
          timeDimension: [
            { cube: 'Productivity', dimension: 'Productivity.date' },
            { cube: 'Employees', dimension: 'Employees.createdAt' }
          ],
          steps: [
            { name: 'Coded', cube: 'Productivity' },
            { name: 'Hired', cube: 'Employees' }
          ]
        }
      }
      const before = (await keyOf(layer, funnel)).key
      expect(before).not.toBeNull()
      await insertEmployee({ name: 'Rk Funnel Step', salary: 10 })
      expect((await keyOf(layer, funnel)).key).not.toBe(before)
    })

    const failingProductivity: CubeKeys = { ...allKeys, productivity: failingKey }

    async function keysWithFailingProductivity(query: SemanticQuery) {
      const layer = createLayer(failingProductivity)
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        return await layer.getRefreshKeys([query, departmentsQuery], writeCtx)
      } finally {
        consoleError.mockRestore()
      }
    }

    // Flow and retention are not supported on SQLite; CI runs these on the other engines.
    // Their cubes-used extraction is unit-tested DB-free in tests/cli/analysis-cubes-used.test.ts.
    it.skipIf(getTestDatabaseType() === 'sqlite')('a retention query depends on the cubes it reads', async () => {
      const [retention, departments] = await keysWithFailingProductivity({
        retention: {
          timeDimension: 'Productivity.date',
          bindingKey: 'Productivity.employeeId',
          dateRange: { start: '2024-01-01', end: '2024-03-31' },
          granularity: 'week',
          periods: 4,
          retentionType: 'classic'
        }
      })
      expect(retention.key).toBeNull()
      expect(departments.key).not.toBeNull()
    })

    it.skipIf(getTestDatabaseType() === 'sqlite')('a flow query depends on the cubes it reads', async () => {
      const [flow, departments] = await keysWithFailingProductivity({
        flow: {
          bindingKey: 'Productivity.employeeId',
          timeDimension: 'Productivity.date',
          eventDimension: 'Productivity.linesOfCode',
          startingStep: { name: 'Start', filter: { member: 'Productivity.linesOfCode', operator: 'gt', values: [0] } },
          stepsBefore: 1,
          stepsAfter: 1
        }
      })
      expect(flow.key).toBeNull()
      expect(departments.key).not.toBeNull()
    })
  })

  describe('failures and validation', () => {
    it('a failing cube key yields null only for the queries that depend on it', async () => {
      const layer = createLayer({ ...allKeys, departments: failingKey })
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

      const [employeesOnly, joined] = await layer.getRefreshKeys([
        employeesQuery,
        { measures: ['Employees.count'], dimensions: ['Departments.name'] }
      ], writeCtx)

      expect(employeesOnly.key).not.toBeNull()
      expect(joined.key).toBeNull()
      expect(joined.checkAfterSeconds).toBe(10)
      expect(consoleError).toHaveBeenCalled()
      consoleError.mockRestore()
    })

    it('rejects a query with an unknown member, as execute does', async () => {
      const layer = createLayer()
      await expect(layer.getRefreshKeys([{ measures: ['Employees.nope'] }], writeCtx)).rejects.toThrow(/nope/)
    })
  })

  describe('probe caching', () => {
    function countingKeys() {
      const calls = { employees: 0 }
      const keys: CubeKeys = {
        ...allKeys,
        employees: {
          every: '1 minute',
          sql: (ctx) => {
            calls.employees++
            return sql`select count(*) from ${schema.employees} where ${ctx.baseQuery.where}`
          }
        }
      }
      return { calls, keys }
    }

    it('evaluates a probe once per `every` per context across calls', async () => {
      const { calls, keys } = countingKeys()
      const cache = new MemoryCacheProvider({ defaultTtlMs: 60000 })
      const layer = createLayer(keys, { cache: { provider: cache } })

      await keyOf(layer, employeesQuery)
      await keyOf(layer, employeesQuery)
      await layer.getRefreshKeys([employeesQuery, { measures: ['Employees.totalSalary'] }], writeCtx)
      expect(calls.employees).toBe(1)

      await keyOf(layer, employeesQuery, { ...writeCtx, userId: 2 })
      expect(calls.employees).toBe(2)
      await cache.close()
    })

    it('contexts mapped to different cube sets never share a probe', async () => {
      const { calls, keys } = countingKeys()
      const cache = new MemoryCacheProvider({ defaultTtlMs: 60000 })
      const layer = createLayer(keys, {
        cache: { provider: cache, securityContextSerializer: (ctx) => String(ctx.organisationId) },
        contextToCubeSetId: (ctx) => (typeof ctx.plan === 'string' ? ctx.plan : undefined)
      })
      layer.registerCubeSet('pro', buildCubes(keys))

      await keyOf(layer, employeesQuery, { ...writeCtx })
      await keyOf(layer, employeesQuery, { ...writeCtx, plan: 'pro' })
      expect(calls.employees).toBe(2)
      await cache.close()
    })

    it('evaluates on every call without a cache provider', async () => {
      const { calls, keys } = countingKeys()
      const layer = createLayer(keys)
      await keyOf(layer, employeesQuery)
      await keyOf(layer, employeesQuery)
      expect(calls.employees).toBe(2)
    })
  })
})
