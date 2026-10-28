/**
 * Cube.js-compatible duration strings, as used by `refreshKey.every`:
 * `'<positive integer> <unit>'`, where the unit is second, minute, hour, day or
 * week, singular or plural, case-insensitive (`'10 seconds'`, `'1 hour'`).
 */

const UNIT_SECONDS: Record<string, number> = {
  second: 1,
  minute: 60,
  hour: 3600,
  day: 86400,
  week: 604800
}

const DURATION = /^(\d+)\s+([a-z]+?)s?$/

/**
 * Parse a duration into whole seconds. Returns `undefined` for anything that
 * is not a positive integer followed by a known unit.
 */
export function parseDurationSeconds(input: string): number | undefined {
  const match = DURATION.exec(input.trim().toLowerCase())
  if (!match) return undefined
  const amount = Number(match[1])
  const unitSeconds = Object.hasOwn(UNIT_SECONDS, match[2]) ? UNIT_SECONDS[match[2]] : undefined
  if (unitSeconds === undefined || amount <= 0) return undefined
  return amount * unitSeconds
}
