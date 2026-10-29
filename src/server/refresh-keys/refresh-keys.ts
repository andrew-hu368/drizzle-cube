/**
 * Composite refresh keys for a list of queries.
 *
 * A query's composite key is a hash of the refresh keys of every cube it reads
 * (its dependent cubes), so it changes when any of them changes. Each cube key
 * is evaluated once per call, and a key query is cached per
 * context key and cube-set key for `every`, so viewers sharing a context run
 * one probe per interval. A cube key that fails makes only the queries that
 * depend on it `null`.
 */

import type { CacheConfig, CacheProvider, Cube, SemanticQuery } from '../types/index.js'
import { strongHash } from '../cache-utils.js'
import { refreshKeyEverySeconds } from './definition.js'

/** One query's composite refresh key. */
export interface QueryRefreshKey {
  /**
   * Opaque hash of the refresh keys of the cubes the query reads. Changes when
   * any of them changes. `null` when a cube key failed to evaluate; poll the
   * query on an interval of `checkAfterSeconds` instead.
   */
  key: string | null
  /** The smallest `every` among the query's cubes: how often to check again. */
  checkAfterSeconds: number
}

/** What the refresh-key computation needs from the semantic layer. */
export interface RefreshKeyEnvironment {
  /**
   * Security-context hash and cube-set key, mixed into every composite key so
   * two contexts never get comparable keys, even over identical rows.
   */
  scope: string
  /** Engine default `every` for cubes that do not set one */
  defaultEverySeconds: number
  /** Validate a query and list the cubes it reads (throws on an invalid query) */
  dependentCubes(query: SemanticQuery): Cube[]
  /** Evaluate a cube's key query */
  evaluate(cube: Cube): Promise<unknown>
  /** Error sink for a failing cube key */
  onError(cubeName: string, error: unknown): void
  /** Probe cache, scoped to the caller's context and cube set */
  cache?: { provider: CacheProvider; key(cubeName: string): string; onError?: CacheConfig['onError'] }
}

/** Serialise a probe value so equal values give equal strings across engines and caches. */
export function serialiseProbeValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'bigint') return value.toString()
  return JSON.stringify(value ?? null, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))
}

async function cubeKey(cube: Cube, everySeconds: number, env: RefreshKeyEnvironment): Promise<string | null> {
  if (!cube.refreshKey?.sql) {
    // `every` alone, or no refresh key: the current time bucket
    return `bucket:${Math.floor(Date.now() / (everySeconds * 1000))}`
  }

  const { cache } = env
  const report = (operation: 'get' | 'set') => (error: unknown) => {
    cache?.onError?.(error instanceof Error ? error : new Error(String(error)), operation)
  }
  const cached = await cache?.provider.get<string>(cache.key(cube.name)).catch(report('get'))
  if (cached && typeof cached.value === 'string') return cached.value

  let value: string
  try {
    value = `value:${serialiseProbeValue(await env.evaluate(cube))}`
  } catch (error) {
    env.onError(cube.name, error)
    return null
  }

  await cache?.provider.set(cache.key(cube.name), value, everySeconds * 1000).catch(report('set'))
  return value
}

/**
 * Composite refresh keys for `queries`, in order. Throws when a query is
 * invalid (unknown members), as executing it would.
 */
export async function computeRefreshKeys(
  queries: SemanticQuery[],
  env: RefreshKeyEnvironment
): Promise<QueryRefreshKey[]> {
  const dependencies = queries.map((query) => env.dependentCubes(query))
  const cubes = new Map(dependencies.flat().map((cube) => [cube.name, cube]))

  const keys = new Map(
    await Promise.all(
      Array.from(cubes.values(), async (cube) => {
        const every = refreshKeyEverySeconds(cube, env.defaultEverySeconds)
        return [cube.name, { name: cube.name, every, key: await cubeKey(cube, every, env) }] as const
      })
    )
  )

  return dependencies.map((queryCubes) => {
    const entries = queryCubes.flatMap((cube) => keys.get(cube.name) ?? [])
    const checkAfterSeconds = entries.length > 0 ? Math.min(...entries.map(({ every }) => every)) : env.defaultEverySeconds
    if (entries.some(({ key }) => key === null)) {
      return { key: null, checkAfterSeconds }
    }
    const parts = entries.map(({ name, key }) => [name, key])
    return { key: strongHash(JSON.stringify([env.scope, parts])), checkAfterSeconds }
  })
}
