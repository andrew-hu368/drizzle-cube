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

import type { CacheConfig, Cube, SecurityContext, SemanticQuery } from '../types/index.js'
import { generateRefreshKeyCacheKey, strongHash } from '../cache-utils.js'
import { hasEvaluatedRefreshKey, refreshKeyEverySeconds } from './definition.js'

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
  /** The cube set serving the caller's security context */
  cubes: Map<string, Cube>
  /** Cube-set key, part of every probe cache key */
  cubeSetKey: string
  securityContext: SecurityContext
  /**
   * Hash of the full security context, mixed into every composite key so two
   * contexts never get comparable keys, even over identical rows.
   */
  contextHash: string
  cacheConfig?: CacheConfig
  /** Engine default `every` for cubes that do not set one */
  defaultEverySeconds: number
  /** Validate a query and list the cubes it reads (throws on an invalid query) */
  dependentCubes(query: SemanticQuery): string[]
  /** Evaluate a cube's key query */
  evaluate(cube: Cube): Promise<unknown>
  /** Error sink for a failing cube key */
  onError(cubeName: string, error: unknown): void
  now(): number
}

/** Serialise a probe value so equal values give equal strings across engines and caches. */
function serialiseProbeValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'bigint') return value.toString()
  return JSON.stringify(value ?? null)
}

async function cubeKey(cube: Cube, everySeconds: number, env: RefreshKeyEnvironment): Promise<string | null> {
  if (!hasEvaluatedRefreshKey(cube)) {
    // `every` alone, or no refresh key: the current time bucket
    return `bucket:${Math.floor(env.now() / (everySeconds * 1000))}`
  }

  const { cacheConfig } = env
  const provider = cacheConfig?.enabled !== false ? cacheConfig?.provider : undefined
  const cacheKey = provider
    ? generateRefreshKeyCacheKey(cube.name, env.securityContext, cacheConfig ?? {}, env.cubeSetKey)
    : undefined

  try {
    if (provider && cacheKey) {
      const cached = await provider.get<string>(cacheKey)
      if (cached && typeof cached.value === 'string') return cached.value
    }
  } catch (error) {
    cacheConfig?.onError?.(error instanceof Error ? error : new Error(String(error)), 'get')
  }

  let value: string
  try {
    value = `value:${serialiseProbeValue(await env.evaluate(cube))}`
  } catch (error) {
    env.onError(cube.name, error)
    return null
  }

  try {
    if (provider && cacheKey) await provider.set(cacheKey, value, everySeconds * 1000)
  } catch (error) {
    cacheConfig?.onError?.(error instanceof Error ? error : new Error(String(error)), 'set')
  }
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

  const everyByCube = new Map<string, number>()
  for (const name of new Set(dependencies.flat())) {
    const cube = env.cubes.get(name)
    if (cube) everyByCube.set(name, refreshKeyEverySeconds(cube, env.defaultEverySeconds))
  }

  const keys = new Map<string, string | null>()
  await Promise.all(
    Array.from(everyByCube, async ([name, everySeconds]) => {
      const cube = env.cubes.get(name)
      keys.set(name, cube ? await cubeKey(cube, everySeconds, env) : null)
    })
  )

  return dependencies.map((names) => {
    const everys = names.map((name) => everyByCube.get(name) ?? env.defaultEverySeconds)
    const checkAfterSeconds = everys.length > 0 ? Math.min(...everys) : env.defaultEverySeconds
    const parts = names.map((name) => [name, keys.get(name) ?? null] as const)
    if (parts.some(([, value]) => value === null)) {
      return { key: null, checkAfterSeconds }
    }
    return { key: strongHash(JSON.stringify([env.contextHash, env.cubeSetKey, parts])), checkAfterSeconds }
  })
}
