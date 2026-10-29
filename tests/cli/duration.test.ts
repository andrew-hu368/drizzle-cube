import { describe, it, expect } from 'vitest'
import { parseDurationSeconds } from '../../src/shared/duration'

describe('parseDurationSeconds (Cube.js refresh key durations)', () => {
  it.each([
    ['10 seconds', 10],
    ['1 second', 1],
    ['30 second', 30],
    ['5 minutes', 300],
    ['2 hours', 7200],
    ['1 day', 86400],
    ['1 week', 604800],
    ['  15   minutes  ', 900],
    ['10 SECONDS', 10]
  ])('parses %j as %d seconds', (input, expected) => {
    expect(parseDurationSeconds(input)).toBe(expected)
  })

  it.each(['', '10', 'seconds', '-5 seconds', '0 seconds', '1.5 minutes', '10 fortnights', '10s'])(
    'rejects %j',
    (input) => {
      expect(parseDurationSeconds(input)).toBeUndefined()
    }
  )
})
