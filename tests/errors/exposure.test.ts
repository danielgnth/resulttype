import { describe, expect, test } from 'bun:test'
import {
  canExpose,
  DEFAULT_EXPOSURE,
  EXPOSURE_CHANNELS,
  EXPOSURE_META,
  EXPOSURES,
  isAtLeastAsOpenAs,
  isExposure,
  isRedacted,
  narrowestExposure,
} from '#errors/exposure'

const byRank = [...EXPOSURES].sort((a, b) => EXPOSURE_META[a].rank - EXPOSURE_META[b].rank)

describe('the exposure ladder', () => {
  // The single property every helper in the module relies on. If a level ever
  // admits a channel the level below it does not, `isAtLeastAsOpenAs` starts
  // lying and `redact` starts leaking.
  test('each level admits every channel the level below admits', () => {
    for (let i = 1; i < byRank.length; i++) {
      const lower = EXPOSURE_META[byRank[i - 1] as (typeof byRank)[number]].channels
      const higher = EXPOSURE_META[byRank[i] as (typeof byRank)[number]].channels
      for (const channel of lower) expect(higher).toContain(channel)
    }
  })

  test('ranks are unique and contiguous from zero', () => {
    const ranks: number[] = byRank.map((e) => EXPOSURE_META[e].rank)
    expect(ranks).toEqual(byRank.map((_, index) => index))
  })

  test('only declares channels that exist', () => {
    for (const exposure of EXPOSURES) {
      for (const channel of EXPOSURE_META[exposure].channels) {
        expect(EXPOSURE_CHANNELS).toContain(channel)
      }
    }
  })

  test('secret admits nothing and public admits everything', () => {
    expect(EXPOSURE_META.secret.channels).toEqual([])
    expect(EXPOSURE_META.public.channels).toEqual([...EXPOSURE_CHANNELS])
  })

  test('the default never reaches a human-facing surface', () => {
    expect(canExpose(DEFAULT_EXPOSURE, 'end_user')).toBe(false)
    expect(canExpose(DEFAULT_EXPOSURE, 'client_response')).toBe(false)
    expect(canExpose(DEFAULT_EXPOSURE, 'support_console')).toBe(false)
    expect(canExpose(DEFAULT_EXPOSURE, 'logs')).toBe(true)
  })

  // The reason `restricted` exists at all: detail that may sit in first-party
  // logs but must not be shipped to a third-party telemetry vendor.
  test('restricted reaches logs but not third-party sinks', () => {
    expect(canExpose('restricted', 'logs')).toBe(true)
    expect(canExpose('restricted', 'traces')).toBe(false)
    expect(canExpose('restricted', 'crash_reports')).toBe(false)
  })
})

describe('comparisons', () => {
  test('isAtLeastAsOpenAs is reflexive and antisymmetric', () => {
    expect(isAtLeastAsOpenAs('support', 'support')).toBe(true)
    expect(isAtLeastAsOpenAs('client', 'support')).toBe(true)
    expect(isAtLeastAsOpenAs('support', 'client')).toBe(false)
  })

  test('narrowestExposure takes the more restrictive side, either order', () => {
    expect(narrowestExposure('public', 'restricted')).toBe('restricted')
    expect(narrowestExposure('restricted', 'public')).toBe('restricted')
    expect(narrowestExposure('secret', 'secret')).toBe('secret')
  })

  test('isRedacted is true only for secret', () => {
    expect(isRedacted('secret')).toBe(true)
    for (const exposure of EXPOSURES.filter((e) => e !== 'secret')) {
      expect(isRedacted(exposure)).toBe(false)
    }
  })

  test('isExposure rejects non-members without throwing', () => {
    expect(isExposure('public')).toBe(true)
    expect(isExposure('internal')).toBe(false)
    expect(isExposure(undefined)).toBe(false)
    expect(isExposure({ rank: 0 })).toBe(false)
  })
})
