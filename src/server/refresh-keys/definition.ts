/**
 * Refresh-key definition rules: validation at definition time and the
 * effective `every` for a cube.
 */

import type { Cube, CubeRefreshKey } from '../types/index.js'
import { parseDurationSeconds } from '../../shared/duration.js'
import { t } from '../../i18n/runtime.js'

/** Cube.js default `every`: 10 seconds. */
export const DEFAULT_REFRESH_KEY_EVERY_SECONDS = 10

/** Cube.js default `every` on warehouse engines (Snowflake, Databend): 2 minutes. */
export const WAREHOUSE_REFRESH_KEY_EVERY_SECONDS = 120

type EngineType = 'postgres' | 'mysql' | 'sqlite' | 'singlestore' | 'duckdb' | 'databend' | 'snowflake'

/** The default `every` for an engine, used by cubes that do not set one. */
export function defaultRefreshKeyEverySeconds(engineType: EngineType | undefined): number {
  return engineType === 'snowflake' || engineType === 'databend'
    ? WAREHOUSE_REFRESH_KEY_EVERY_SECONDS
    : DEFAULT_REFRESH_KEY_EVERY_SECONDS
}

/**
 * Throw when a refresh key's `every` is not a Cube.js duration. A missing
 * refresh key is valid.
 */
export function validateCubeRefreshKey(cubeName: string, refreshKey: CubeRefreshKey | undefined): void {
  if (!refreshKey) return
  if (refreshKey.every !== undefined && parseDurationSeconds(refreshKey.every) === undefined) {
    throw new Error(t('server.errors.refreshKeyInvalidEvery', { cubeName, every: refreshKey.every }))
  }
}

/** The cube's `every` in seconds, falling back to the engine default. */
export function refreshKeyEverySeconds(cube: Cube, defaultSeconds: number): number {
  const every = cube.refreshKey?.every
  return (every !== undefined ? parseDurationSeconds(every) : undefined) ?? defaultSeconds
}

/** Whether the cube's key is evaluated against the database (a key query). */
export function hasEvaluatedRefreshKey(cube: Cube): boolean {
  return Boolean(cube.refreshKey?.sql)
}
