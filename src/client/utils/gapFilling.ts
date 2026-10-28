/**
 * Chart-side gap filling (issue #1368).
 *
 * The server returns observed rows only, as Cube.js does; charts fill missing
 * time buckets, as Cube.js's client does. Per time dimension, the first of
 * these that is set decides:
 *
 * 1. the query's `fillMissingDates` (e.g. a drill-down turning it off)
 * 2. the chart's `fillMissingDates` display option
 * 3. the cube time dimension's `fillMissingDates`, from the result annotation
 * 4. `true` — the Cube.js chart default
 *
 * Filling reuses the server's bucket logic from `src/shared/gap-filler.ts`, so
 * a filled chart looks exactly as it did when the server filled by default.
 */

import { applyGapFilling } from '../../shared/gap-filler.js'
import type { CubeResultSet } from '../types.js'

/** A chart's gap-filling preference. */
export interface ChartGapFillOptions {
  /** `true`/`false` force filling on/off; `'auto'` or unset defers to the query and cube. */
  fillMissingDates?: boolean | 'auto'
}

// Declared here rather than imported from `src/shared` so the published client
// typings stay self-contained (shared code is bundled, its types are not).

/** A time dimension of the query a result came from. */
export interface ChartGapFillTimeDimension {
  dimension: string
  granularity?: string
  dateRange?: string | string[]
  fillMissingDates?: boolean
  compareDateRange?: readonly unknown[]
}

/** The parts of a query chart gap filling reads. */
export interface ChartGapFillQuery {
  measures?: readonly string[]
  dimensions?: readonly string[]
  timeDimensions?: readonly ChartGapFillTimeDimension[]
  filters?: readonly ChartGapFillFilter[]
  fillMissingDatesValue?: number | null
  ungrouped?: boolean
}

interface ChartGapFillFilter {
  member?: string
  operator?: string
  values?: readonly unknown[]
  dateRange?: string | string[]
  and?: readonly ChartGapFillFilter[]
  or?: readonly ChartGapFillFilter[]
}

interface TimeDimensionAnnotation {
  fillMissingDates?: boolean
}

/** The query a result set was produced from, as echoed back by the server. */
function resultQuery(resultSet: CubeResultSet): ChartGapFillQuery | null {
  const response = resultSet.loadResponse
  return response?.results?.[0]?.query ?? response?.query ?? null
}

/**
 * Fill missing time buckets in result rows for a chart.
 *
 * Comparison (`compareDateRange`) dimensions are left alone — the server fills
 * each period already and the rows carry period metadata. Ungrouped queries are
 * never filled.
 */
export function fillChartRows(
  rows: Record<string, unknown>[],
  query: ChartGapFillQuery,
  annotation: { timeDimensions?: Record<string, TimeDimensionAnnotation> } | undefined,
  options: ChartGapFillOptions = {}
): Record<string, unknown>[] {
  if (query.ungrouped) return rows

  const chartSetting = options.fillMissingDates === 'auto' ? undefined : options.fillMissingDates
  const shouldFill = (td: ChartGapFillTimeDimension): boolean => {
    if (td.compareDateRange?.length) return false
    return td.fillMissingDates
      ?? chartSetting
      ?? annotation?.timeDimensions?.[td.dimension]?.fillMissingDates
      ?? true
  }

  return applyGapFilling(rows, query, query.measures ?? [], shouldFill)
}

/** Filled rows per input rows array, per fill options and query. */
const filledRowsCache = new WeakMap<object, Map<string, Record<string, unknown>[]>>()

/**
 * Wrap a result set so its rows are gap-filled for a chart. The underlying
 * result set (and the query cache holding it) stays raw, so changing the chart
 * setting never refetches. Returns the result set unchanged when it does not
 * carry the query it came from.
 */
export function withChartGapFilling(
  resultSet: CubeResultSet,
  options: ChartGapFillOptions = {}
): CubeResultSet {
  const query = resultQuery(resultSet)
  if (!query?.timeDimensions?.length) return resultSet

  // The same input rows always fill to the same output array, so a refetch
  // that kept its previous rows (unchanged result fingerprint) does not hand
  // the chart new arrays.
  const cacheKey = `${options.fillMissingDates}|${JSON.stringify(query)}`
  const fill = (rows: Record<string, unknown>[]) => {
    let byOptions = filledRowsCache.get(rows)
    if (!byOptions) {
      byOptions = new Map()
      filledRowsCache.set(rows, byOptions)
    }
    let filled = byOptions.get(cacheKey)
    if (!filled) {
      filled = fillChartRows(rows, query, resultSet.annotation(), options)
      byOptions.set(cacheKey, filled)
    }
    return filled
  }

  let raw: Record<string, unknown>[] | undefined
  let table: Record<string, unknown>[] | undefined
  let series: Record<string, unknown>[] | undefined

  return {
    rawData: () => (raw ??= fill(resultSet.rawData())),
    tablePivot: () => (table ??= fill(resultSet.tablePivot())),
    series: () => (series ??= fill(resultSet.series())),
    annotation: () => resultSet.annotation(),
    loadResponse: resultSet.loadResponse,
    cacheInfo: resultSet.cacheInfo ? () => resultSet.cacheInfo?.() : undefined,
    lastRefreshTime: resultSet.lastRefreshTime ? () => resultSet.lastRefreshTime?.() : undefined,
    totalCount: resultSet.totalCount ? () => resultSet.totalCount?.() : undefined,
    fingerprint: resultSet.fingerprint ? () => resultSet.fingerprint?.() : undefined
  }
}
