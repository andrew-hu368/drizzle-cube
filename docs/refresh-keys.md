# Refresh keys

A refresh key is a cheap value that changes when a cube's data changes. Clients poll
`POST {basePath}/refresh-keys` with the queries on screen and refetch a query only when its key moved,
instead of re-running every query on a timer. This is how `useCubeQuery(query, { subscribe: true })`,
`CubeClient.subscribe` and portlets with refresh turned on stay current (issue #271).

A refresh key says a query's result *may* have changed. Every `/load` and `/batch` result also carries a
`fingerprint`, a hash of its rows, which says whether it *did* change. A client that gets back the same
fingerprint keeps its previous data, so charts do not redraw.

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

## Endpoint

```http
POST /cubejs-api/v1/refresh-keys
Content-Type: application/json

{ "queries": [{ "measures": ["Orders.count"] }, { "measures": ["Users.count"], "dimensions": ["Orders.status"] }] }
```

```json
{ "keys": [
  { "key": "6f1c…", "checkAfterSeconds": 30 },
  { "key": null, "checkAfterSeconds": 10 }
] }
```

The security context is resolved exactly as for `/load` (including `contextToCubeSetId`), queries are validated
as for `/load` (an unknown member is the same 400), and the response is `Cache-Control: private, no-store`.
Express, Fastify and Hono mount the route with the other endpoints. In Next.js export it from a route file:

```ts
// app/api/cubejs-api/v1/refresh-keys/route.ts
import { createRefreshKeysHandler } from 'drizzle-cube/adapters/nextjs'
export const POST = createRefreshKeysHandler(options)
```

or use `createCubeHandlers(options).refreshKeys`.

From server code (alerts, warm-ups) call the compiler directly:

```ts
const [{ key }] = await semanticLayer.getRefreshKeys([query], securityContext)
```

## Sharing the refetch: `x-refresh-key`

When a key changes, send the new key with the refetch: `x-refresh-key: <key>` on `/load` or `/batch`, or
`ExecutionOptions.refreshKey` from server code. It is appended to the result cache key, so the first viewer in a
context misses once and every other viewer who saw the same change hits the new entry. It only chooses among
entries of the caller's own context, so it needs no trust. Adapters add `X-Refresh-Key` to the CORS allow list.

A `/batch` call can carry a different key per query in its body, aligned with `queries`; an entry overrides the
header for its query:

```json
{ "queries": [{ "measures": ["Orders.count"] }, { "measures": ["Users.count"] }], "refreshKeys": ["6f1c…", null] }
```

## Result fingerprints

Every result carries `fingerprint`, a hash of its rows (and `total`), computed once per execution and stored
with the cache entry. The same rows give the same fingerprint on a cache miss and on a hit.

## Client

The client uses all of the above without extra configuration:

- `useCubeQuery(query, { subscribe: true })`, `CubeClient.subscribe(query, options, callback)` and dashboard
  portlets with a refresh interval (`features.refresh`) watch their queries' keys through one
  `RefreshKeyCoordinator` per `CubeClient`. Each watcher checks once when it starts, then every interval (10
  seconds for `subscribe`, floored by `features.refresh.minIntervalSeconds`; the portlet interval for a
  portlet), raised to the server's `checkAfterSeconds`. Checks are aligned to the clock, so watchers on the
  same interval check together, and checks that land together share one `/refresh-keys` call. The first key
  seen is only recorded.
- When a query's key changes, only that query refetches, with the new key (`X-Refresh-Key` on `/load`,
  `refreshKeys` in the `/batch` body), so portlets that change together still share one batch call.
- A refetch whose result has the same `fingerprint` as the data on screen keeps that data (the same object), so
  the chart does not redraw, and computed-at stays at the original computation. The `CubeClient.subscribe`
  callback is not called for it. A result without a fingerprint is always delivered.
- The portlet header shows "checked for changes at"; the stale badge counts from the later of computed-at and
  checked-at, so a portlet whose data simply has not changed does not turn stale.
- Pausing (dashboard or portlet), edit mode, a hidden tab with `pauseWhenHidden`, and `manualRefresh` stop a
  portlet's watch. Its last key is remembered, so when it resumes the first check refetches only if the data
  changed meanwhile.
- Against a server without `/refresh-keys`, or while a key is `null`, a subscription refetches every interval
  with max-age equal to the interval, as before refresh keys existed.
