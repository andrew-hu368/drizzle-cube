/**
 * Test helper for key queries (`refreshKey.sql`), whose author owns the
 * tenant filter. Ships with the key query so it is never available without
 * its check.
 */

import type { SemanticLayerCompiler } from '../compiler.js'
import type { SecurityContext } from '../types/index.js'
import { t } from '../../i18n/runtime.js'
import { serialiseProbeValue } from './refresh-keys.js'

/**
 * Evaluate a cube's refresh key under two different security contexts and
 * throw when both the value and the query it ran (SQL text and bound
 * parameters) are identical: a sign that the key ignores the context and would
 * leak another tenant's write timing. Use it in your own test suite with two
 * contexts that should not see each other's rows.
 *
 * A cube with only `every` (a time bucket) has nothing to scope and passes.
 */
export async function assertRefreshKeyIsContextScoped(
  semanticLayer: SemanticLayerCompiler,
  cubeName: string,
  contexts: readonly [SecurityContext, SecurityContext]
): Promise<void> {
  const [first, second] = await Promise.all(
    contexts.map((context) => semanticLayer.describeRefreshKey(cubeName, context))
  )
  if (!first) return

  const same = (a: unknown, b: unknown) => serialiseProbeValue(a) === serialiseProbeValue(b)
  const sameValue = same(first.value, second?.value)
  const sameQuery = same(first.query, second?.query)
  if (sameValue && sameQuery) {
    throw new Error(t('server.errors.refreshKeyNotContextScoped', { cubeName }))
  }
}
