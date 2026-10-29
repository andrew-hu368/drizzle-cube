/**
 * Every cube a logical plan reads: the primary cube, joined cubes (so cubes on
 * a join path count even when the query names none of their members), CTE
 * cubes and the intermediate cubes absorbed into them. Used for refresh-key
 * dependencies.
 */

import type { LogicalNode } from './types.js'

export function collectPlanCubeNames(node: LogicalNode, cubes: Set<string> = new Set()): Set<string> {
  switch (node.type) {
    case 'query':
      collectPlanCubeNames(node.source, cubes)
      for (const ref of [...node.dimensions, ...node.measures, ...node.timeDimensions]) cubes.add(ref.cube.name)
      break
    case 'simpleSource':
      cubes.add(node.primaryCube.name)
      for (const join of node.joins) cubes.add(join.target.name)
      for (const cte of node.ctes) collectPlanCubeNames(cte, cubes)
      break
    case 'ctePreAggregate':
      cubes.add(node.cube.name)
      for (const intermediate of node.intermediateJoins ?? []) cubes.add(intermediate.cube.name)
      break
    case 'fullKeyAggregate':
      for (const subquery of node.subqueries) collectPlanCubeNames(subquery, cubes)
      break
    case 'keysDeduplication':
      collectPlanCubeNames(node.keysSource, cubes)
      collectPlanCubeNames(node.measureSource, cubes)
      break
    case 'multiFactMerge':
      for (const group of node.groups) collectPlanCubeNames(group, cubes)
      break
  }
  return cubes
}
