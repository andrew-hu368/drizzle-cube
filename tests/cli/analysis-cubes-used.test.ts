/**
 * Funnel, flow and retention bypass the logical plan, so each builder lists the
 * cubes it reads (its refresh-key dependencies). DB-free.
 */

import { describe, it, expect } from 'vitest'
import { SQLiteAdapter } from '../../src/server/adapters/sqlite-adapter'
import { FunnelQueryBuilder } from '../../src/server/builders/funnel-query-builder'
import { FlowQueryBuilder } from '../../src/server/builders/flow-query-builder'
import { RetentionQueryBuilder } from '../../src/server/builders/retention-query-builder'

const adapter = new SQLiteAdapter()
const sorted = (cubes: Set<string>) => Array.from(cubes).sort()

describe('analysis cubes used', () => {
  it('funnel: binding key, time dimension, step cubes and step filter cubes', () => {
    const cubes = new FunnelQueryBuilder(adapter).cubesUsed({
      bindingKey: [
        { cube: 'Signups', dimension: 'Signups.userId' },
        { cube: 'Orders', dimension: 'Orders.userId' }
      ],
      timeDimension: [
        { cube: 'Signups', dimension: 'Signups.at' },
        { cube: 'Orders', dimension: 'Orders.at' }
      ],
      steps: [
        { name: 'Signed up', cube: 'Signups' },
        {
          name: 'Ordered',
          cube: 'Orders',
          filter: { or: [{ member: 'Products.category', operator: 'equals', values: ['x'] }] }
        }
      ]
    })
    expect(sorted(cubes)).toEqual(['Orders', 'Products', 'Signups'])
  })

  it('funnel: single-cube steps use the binding key cube', () => {
    const cubes = new FunnelQueryBuilder(adapter).cubesUsed({
      bindingKey: 'Events.userId',
      timeDimension: 'Events.at',
      steps: [
        { name: 'a', filter: { member: 'Events.type', operator: 'equals', values: ['a'] } },
        { name: 'b', filter: [{ member: 'Events.type', operator: 'equals', values: ['b'] }] }
      ]
    })
    expect(sorted(cubes)).toEqual(['Events'])
  })

  it('flow: binding key, time dimension, event dimension and starting-step filter cubes', () => {
    const cubes = new FlowQueryBuilder(adapter).cubesUsed({
      bindingKey: 'Events.userId',
      timeDimension: 'Events.at',
      eventDimension: 'Events.type',
      startingStep: {
        name: 'Start',
        filter: { and: [{ member: 'Users.plan', operator: 'equals', values: ['pro'] }] }
      },
      stepsBefore: 1,
      stepsAfter: 1
    })
    expect(sorted(cubes)).toEqual(['Events', 'Users'])
  })

  it('retention: time dimension, binding key, breakdowns and cohort/activity filter cubes', () => {
    const cubes = new RetentionQueryBuilder(adapter).cubesUsed({
      timeDimension: { cube: 'Events', dimension: 'at' },
      bindingKey: [{ cube: 'Events', dimension: 'Events.userId' }],
      dateRange: { start: '2024-01-01', end: '2024-02-01' },
      granularity: 'week',
      periods: 4,
      retentionType: 'classic',
      breakdownDimensions: ['Users.country'],
      cohortFilters: { member: 'Plans.name', operator: 'equals', values: ['pro'] },
      activityFilters: [{ member: 'Sessions.device', operator: 'equals', values: ['ios'] }]
    })
    expect(sorted(cubes)).toEqual(['Events', 'Plans', 'Sessions', 'Users'])
  })
})
