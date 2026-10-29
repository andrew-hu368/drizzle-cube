# Refresh keys

A refresh key is a cheap value that changes when a cube's data changes. A caller asks for the composite keys of
the queries it shows and re-runs a query only when its key moved, instead of re-running every query on a timer
(issue #271).

A refresh key says a query's result *may* have changed: it is per cube, so any write to a cube the query reads
moves it, even one outside the query's filters.

## Declaring a refresh key

```ts
import { defineCube } from 'drizzle-cube/server'
import { eq, sql } from 'drizzle-orm'

export const ordersCube = defineCube('Orders', {
  sql: (ctx) => ({
    from: orders,
    where: eq(orders.organisationId, ctx.securityContext.organisationId)
  }),
  refreshKey: {
    // Reuse the cube's WHERE so the key only sees the caller's rows.
    // Pick something that moves on insert, update and delete.
    sql: (ctx) => sql`select count(*) + coalesce(sum(${orders.version}), 0) from ${orders} where ${ctx.baseQuery.where}`,
    every: '30 seconds'
  },
  // dimensions, measures, joins ...
})
```

`refreshKey` takes an optional `sql` and an optional `every`:

| Field | Meaning |
|---|---|
| `sql: (ctx) => SQL` | **Key query** (Cube.js parity). A query that returns one row with one column. You scope it to the context yourself; `ctx.baseQuery` is the cube's resolved base query (`from`, `joins`, `where`), so reuse `ctx.baseQuery.where`, and check it with `assertRefreshKeyIsContextScoped`. |
| `every: '<n> <unit>'` | A Cube.js duration (`second`, `minute`, `hour`, `day`, `week`, singular or plural). With `sql`, the minimum time between evaluations. Alone, the key is the current time bucket of that length: "assume the data changes this often". |

A cube without `refreshKey` gets Cube.js's default: a 10-second time bucket, or 2 minutes on Snowflake and
Databend. `defineCube` (and `registerCube`) throw when `every` is not a valid duration.

### Coming from Cube.js: `sql` is a function, not a string

In Cube.js, `refresh_key.sql` is a SQL string. In drizzle-cube it is a function that receives the query context
and returns Drizzle `SQL`, like every other `sql` in a cube definition. The shape and the meaning of `sql` and
`every` carry over; the SQL text has to be rewritten.

Cube.js:

```js
cube('Orders', {
  sql: `SELECT * FROM orders WHERE ${SECURITY_CONTEXT.organisationId.filter('organisation_id')}`,
  refresh_key: {
    sql: `SELECT MAX(updated_at) FROM orders`,
    every: '1 minute'
  }
})
```

drizzle-cube:

```ts
defineCube('Orders', {
  sql: (ctx) => ({ from: orders, where: eq(orders.organisationId, ctx.securityContext.organisationId) }),
  refreshKey: {
    sql: (ctx) => sql`select max(${orders.updatedAt}) from ${orders} where ${ctx.baseQuery.where}`,
    every: '1 minute'
  }
})
```

Note the `where`: the Cube.js key above ignores the tenant, so every tenant's dashboards would refetch on any
tenant's write and could time each other's writes. Always filter by `ctx.baseQuery.where` (or your own context
filter), and check it with the helper below.

### Checking a key query: `assertRefreshKeyIsContextScoped`

The key query ships with a test helper. It evaluates the cube's key under two security contexts and throws when
both the value and the query it ran (SQL text and bound parameters) are identical:

```ts
import { assertRefreshKeyIsContextScoped } from 'drizzle-cube/server'

it('Orders refresh key is tenant-scoped', async () => {
  await assertRefreshKeyIsContextScoped(semanticLayer, 'Orders', [
    { organisationId: 1 },
    { organisationId: 2 }
  ])
})
```

## How keys are computed

- **Dependent cubes.** A query's key covers every cube it reads, taken from the logical plan, so a cube on the
  join path counts even when the query names none of its members. Funnel, flow and retention queries do not use
  the logical plan; each lists its own cubes (binding key, time dimension, step cubes, event dimension,
  breakdowns and every cube their filters reference).
- **Composite key.** The cube keys, in cube-name order, are hashed together with a hash of the security context
  and the cube-set key. The browser only ever sees this 32-character hash, never a raw `max(updated_at)`.
- **`checkAfterSeconds`.** The smallest `every` among the query's cubes: how long a client should wait before
  asking again.
- **Probe caching.** With a cache provider configured, each evaluated cube key is cached for `every` under the
  full context key and the cube-set key, so viewers who share a context run one probe per interval and tenants
  with different cube sets never share a probe. Without a cache provider every call evaluates the probe.
- **Failures.** A key that fails to evaluate is logged and makes `key` `null` for the queries that depend on that
  cube only. Clients fall back to refetching those queries every `checkAfterSeconds`.

## From server code

```ts
const [{ key, checkAfterSeconds }] = await semanticLayer.getRefreshKeys([query], securityContext)
```

`getRefreshKeys` resolves the per-tenant cube set like `execute` (through `contextToCubeSetId`), takes each cube's
refresh key from that set, and throws on an invalid query (an unknown member) as `execute` does.
