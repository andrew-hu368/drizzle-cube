/**
 * defineCube (and cube registration) reject a malformed refresh key at
 * definition time. DB-free.
 */

import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { sqliteTable, integer } from 'drizzle-orm/sqlite-core'
import { defineCube, SemanticLayerCompiler } from '../../src/server'
import type { Cube, CubeRefreshKey } from '../../src/server'

const things = sqliteTable('things', { id: integer('id'), orgId: integer('org_id') })

function cube(refreshKey: CubeRefreshKey | undefined): Omit<Cube, 'name'> {
  return {
    sql: () => ({ from: things }),
    refreshKey,
    dimensions: { id: { name: 'id', type: 'number', sql: things.id, primaryKey: true } },
    measures: { count: { name: 'count', type: 'count', sql: things.id } }
  }
}

describe('refresh key definition', () => {
  it('accepts a key query, `every` alone and no key', () => {
    expect(() => defineCube('B', cube({ sql: () => sql`select 1`, every: '30 seconds' }))).not.toThrow()
    expect(() => defineCube('C', cube({ every: '2 hours' }))).not.toThrow()
    expect(() => defineCube('D', cube(undefined))).not.toThrow()
  })

  it('rejects an invalid duration', () => {
    expect(() => defineCube('Bad', cube({ every: 'every so often' }))).toThrow(/Bad.*every so often/)
  })

  it('registerCube rejects a malformed key on a cube built without defineCube', () => {
    const layer = new SemanticLayerCompiler()
    expect(() => layer.registerCube({ name: 'Raw', ...cube({ every: '10 fortnights' }) })).toThrow(/Raw/)
  })
})
