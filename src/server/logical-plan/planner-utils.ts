/**
 * Shared planning utilities used across the logical-plan sub-planners
 * (JoinPlanner, CTEPlanner, FilterPropagation, PlanAnalysisReporter).
 *
 * These are small, side-effect-free helpers plus a per-cubes resolver cache.
 * Extracted from LogicalPlanner so the planning phases can live in separate
 * single-responsibility modules without duplicating cube-usage analysis or
 * re-instantiating JoinPathResolver.
 */

import type { Cube, Filter, SemanticQuery } from '../types/index.js'
import { JoinPathResolver } from '../resolvers/join-path-resolver.js'

/**
 * Caches a JoinPathResolver per cubes map to avoid repeated instantiation.
 * Shared by all sub-planners so a single query reuses one resolver per cubes map.
 */
export class ResolverCache {
  private cache: WeakMap<Map<string, Cube>, JoinPathResolver> = new WeakMap()

  get(cubes: Map<string, Cube>): JoinPathResolver {
    let resolver = this.cache.get(cubes)
    if (!resolver) {
      resolver = new JoinPathResolver(cubes)
      this.cache.set(cubes, resolver)
    }
    return resolver
  }
}

/**
 * Analyze a semantic query to determine which cubes are involved.
 * Scans measures, dimensions, time dimensions, filters and ORDER BY members.
 */
export function analyzeCubeUsage(query: SemanticQuery): Set<string> {
  const cubesUsed = new Set<string>()

  // Extract cube names from measures
  if (query.measures) {
    for (const measure of query.measures) {
      const [cubeName] = measure.split('.')
      cubesUsed.add(cubeName)
    }
  }

  // Extract cube names from dimensions
  if (query.dimensions) {
    for (const dimension of query.dimensions) {
      const [cubeName] = dimension.split('.')
      cubesUsed.add(cubeName)
    }
  }

  // Extract cube names from time dimensions
  if (query.timeDimensions) {
    for (const timeDim of query.timeDimensions) {
      const [cubeName] = timeDim.dimension.split('.')
      cubesUsed.add(cubeName)
    }
  }

  // Extract cube names from filters
  if (query.filters) {
    for (const filter of query.filters) {
      extractCubeNamesFromFilter(filter, cubesUsed)
    }
  }

  // Extract cube names from ORDER BY members
  if (query.order) {
    for (const member of Object.keys(query.order)) {
      const [cubeName] = member.split('.')
      if (cubeName) {
        cubesUsed.add(cubeName)
      }
    }
  }

  return cubesUsed
}

/**
 * Recursively extract the cube names a filter (or list of filters) references
 * into the provided set, walking both `and` and `or` branches of logical filters.
 */
export function extractCubeNamesFromFilter(filters: Filter | Filter[] | undefined, cubesUsed: Set<string>): void {
  if (!filters) return
  for (const filter of Array.isArray(filters) ? filters : [filters]) {
    if ('member' in filter) {
      const [cubeName] = filter.member.split('.')
      if (cubeName) cubesUsed.add(cubeName)
    } else {
      extractCubeNamesFromFilter(filter.and, cubesUsed)
      extractCubeNamesFromFilter(filter.or, cubesUsed)
    }
  }
}
