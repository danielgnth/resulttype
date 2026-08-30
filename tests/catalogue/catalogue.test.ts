import { describe, expect, test } from 'bun:test'
import { codeFromHttpStatus, type DefaultErrorCode, defaultErrors } from '#catalogue/default-errors'
import { defineErrors, mergeCatalogues } from '#catalogue/define-errors'
import { params } from '#catalogue/params'
import { toFailure } from '#errors/defect'
import { isFailure, UNEXPECTED_CODE } from '#errors/failure'
import { ERROR_KIND_DEFAULTS, ERROR_KINDS } from '#errors/kind'
import { tryCatch } from '#resulttype/try-catch'

describe('resolution from the kind', () => {
  const errors = defineErrors({
    'test.bare': { kind: 'availability' },
    'test.overridden': { kind: 'availability', http: 504, retry: 'never', fault: 'caller' },
    'test.client_only': { kind: 'platform', http: null },
    'test.with_params': { kind: 'state', http: 404, params: params<{ userId: string }>() },
  })

  test('an entry that declares only its kind inherits all four defaults', () => {
    const failure = errors.create('test.bare')
    expect(failure.kind).toBe('availability')
    expect(failure.http).toBe(ERROR_KIND_DEFAULTS.availability.http)
    expect(failure.retry).toBe(ERROR_KIND_DEFAULTS.availability.retry)
    expect(failure.fault).toBe(ERROR_KIND_DEFAULTS.availability.fault)
    expect(failure.exposure).toBe('diagnostic')
  })

  test('explicit fields win over the kind defaults', () => {
    const failure = errors.create('test.overridden')
    expect(failure.http).toBe(504)
    expect(failure.retry).toBe('never')
    expect(failure.fault).toBe('caller')
  })

  // `??` would silently replace this with the kind default. `http: null` is a
  // declaration — "this can only happen on a client" — not an absent value.
  test('an explicit http of null is preserved, not treated as unset', () => {
    expect(errors.create('test.client_only').http).toBeNull()
  })

  test('produces something isFailure recognises', () => {
    expect(isFailure(errors.create('test.bare'))).toBe(true)
  })

  test('the message falls back to the code when nothing supplies one', () => {
    expect(errors.create('test.bare').message).toBe('test.bare')
    expect(errors.create('test.bare', { message: 'custom' }).message).toBe('custom')
  })

  // At a seam the foreign text is the diagnostic. Leaving it only in `cause`
  // means the log line says "db.unavailable" and nothing about which host died.
  test('an unmessaged entry adopts the cause’s message', () => {
    const failure = errors.create('test.bare', { cause: new Error('ECONNRESET') })
    expect(failure.message).toBe('ECONNRESET')
  })

  test('an entry’s own message outranks the cause’s', () => {
    const stated = defineErrors({ 'test.stated': { kind: 'internal', message: 'stated' } })
    expect(stated.create('test.stated', { cause: new Error('ignored') }).message).toBe('stated')
  })

  test('falls through an empty or unreadable cause message to the code', () => {
    expect(errors.create('test.bare', { cause: new Error('') }).message).toBe('test.bare')
    expect(errors.create('test.bare', { cause: 'not an error' }).message).toBe('test.bare')
  })

  test('unset optional fields are absent keys, not undefined ones', () => {
    const failure = errors.create('test.bare')
    expect('params' in failure).toBe(false)
    expect('cause' in failure).toBe(false)
    expect('issues' in failure).toBe(false)
  })

  test('params and context land in the right slots', () => {
    const cause = new Error('row missing')
    const failure = errors.create(
      'test.with_params',
      { userId: 'u1' },
      { cause, issues: [{ path: ['userId'], code: 'missing' }] },
    )
    expect(failure.params).toEqual({ userId: 'u1' })
    expect(failure.cause).toBe(cause)
    expect(failure.issues).toHaveLength(1)
  })
})

describe('stack capture', () => {
  const errors = defineErrors({
    'test.provider': { kind: 'internal' },
    'test.caller': { kind: 'state' },
    'test.forced': { kind: 'state', captureStack: true },
    'test.suppressed': { kind: 'internal', captureStack: false },
  })

  // The whole performance argument: a 404 is the system working, and paying
  // ~200x a plain object to record where it happened is waste.
  test('defaults to capturing for provider faults only', () => {
    expect(errors.create('test.provider').stack).toBeDefined()
    expect('stack' in errors.create('test.caller')).toBe(false)
  })

  test('captureStack overrides the fault-derived default in both directions', () => {
    expect(errors.create('test.forced').stack).toBeDefined()
    expect('stack' in errors.create('test.suppressed')).toBe(false)
  })
})

describe('toErr at a seam', () => {
  const errors = defineErrors({
    'db.unavailable': { kind: 'availability' },
    'db.row_invalid': { kind: 'state', params: params<{ table: string }>() },
  })

  test('curries the cause so it drops straight into tryCatch', () => {
    const boom = new Error('connection reset')
    const [value, error] = tryCatch(() => {
      throw boom
    }, errors.toErr('db.unavailable'))

    expect(value).toBeUndefined()
    expect(error?.code).toBe('db.unavailable')
    expect(error?.cause).toBe(boom)
    expect(error?.retry).toBe('backoff')
  })

  // The point of the seam rule: the error type stays narrow enough to switch on.
  test('the mapped failure keeps its literal code type', () => {
    const [, error] = tryCatch(() => {
      throw new Error('x')
    }, errors.toErr('db.unavailable'))
    const code: 'db.unavailable' | undefined = error?.code
    expect(code).toBe('db.unavailable')
  })

  test('carries params through the currying', () => {
    const failure = errors.toErr('db.row_invalid', { table: 'users' })(new Error('x'))
    expect(failure.params).toEqual({ table: 'users' })
    expect(failure.cause).toBeInstanceOf(Error)
  })

  test('the thrown cause wins over one named in the context', () => {
    const thrown = new Error('actual')
    const failure = errors.toErr('db.unavailable', { cause: new Error('declared') })(thrown)
    expect(failure.cause).toBe(thrown)
  })
})

describe('the built-in catalogue', () => {
  const codes = Object.keys(defaultErrors.entries) as DefaultErrorCode[]

  test('every entry declares a real kind', () => {
    for (const code of codes) {
      const entry = defaultErrors.entries[code]
      expect(ERROR_KINDS).toContain(entry.kind)
    }
  })

  test('every code is namespaced', () => {
    for (const code of codes) expect(code).toMatch(/^[a-z]+\.[a-z_]+$/)
  })

  test('leaves db.*, env.* and ui.* to the application', () => {
    for (const code of codes) {
      expect(['db', 'env', 'ui']).not.toContain(code.split('.')[0])
    }
  })

  test('every entry can actually be constructed', () => {
    for (const code of codes) {
      const failure = defaultErrors.create(code)
      expect(isFailure(failure)).toBe(true)
      expect(failure.code).toBe(code)
    }
  })

  // Promised in two doc comments: the boundary must be able to normalise a
  // throw without a catalogue and still produce the same thing the catalogue
  // would have. If these ever drift, a failure changes shape depending on which
  // path produced it.
  test('system.unexpected resolves identically through both paths', () => {
    const viaCatalogue = defaultErrors.create(UNEXPECTED_CODE)
    const viaBoundary = toFailure(new Error('boom'))
    expect(viaBoundary.code).toBe(viaCatalogue.code)
    expect(viaBoundary.kind).toBe(viaCatalogue.kind)
    expect(viaBoundary.http).toBe(viaCatalogue.http)
    expect(viaBoundary.retry).toBe(viaCatalogue.retry)
    expect(viaBoundary.fault).toBe(viaCatalogue.fault)
    expect(viaBoundary.exposure).toBe(viaCatalogue.exposure)
  })

  test('nothing that reaches an end user is more open than public', () => {
    for (const code of codes) {
      const failure = defaultErrors.create(code)
      if (failure.exposure === 'public') expect(failure.fault).not.toBe('provider')
    }
  })
})

describe('codeFromHttpStatus', () => {
  test.each([
    [404, 'resource.not_found'],
    [401, 'auth.unauthenticated'],
    [429, 'limit.rate_limited'],
    [502, 'net.upstream_failure'],
    [503, 'net.unavailable'],
    [451, 'auth.legally_restricted'],
  ])('maps %i to %s', (status, expected) => {
    expect(codeFromHttpStatus(status)).toBe(expected as DefaultErrorCode)
  })

  test('collapses unlisted statuses by class', () => {
    expect(codeFromHttpStatus(418)).toBe('input.malformed')
    expect(codeFromHttpStatus(599)).toBe(UNEXPECTED_CODE)
    expect(codeFromHttpStatus(200)).toBe(UNEXPECTED_CODE)
  })

  test('every mapped code exists in the catalogue', () => {
    for (let status = 100; status < 600; status++) {
      expect(defaultErrors.has(codeFromHttpStatus(status))).toBe(true)
    }
  })
})

describe('mergeCatalogues', () => {
  test('combines entries and keeps both sides constructible', () => {
    const a = defineErrors({ 'a.one': { kind: 'state' } })
    const b = defineErrors({ 'b.two': { kind: 'input' } })
    const merged = mergeCatalogues(a, b)
    expect(merged.has('a.one')).toBe(true)
    expect(merged.has('b.two')).toBe(true)
    expect(merged.create('b.two').kind).toBe('input')
  })

  test('an app catalogue merges onto the built-ins', () => {
    const merged = mergeCatalogues(
      defaultErrors,
      defineErrors({ 'db.unavailable': { kind: 'availability' } }),
    )
    expect(merged.has(UNEXPECTED_CODE)).toBe(true)
    expect(merged.create('db.unavailable').http).toBe(503)
  })
})

describe('unknown codes', () => {
  test('throw, because reaching one needs a cast that defeats the types', () => {
    const errors = defineErrors({ 'a.one': { kind: 'state' } })
    expect(() => errors.create('a.missing' as 'a.one')).toThrow('Unknown error code: a.missing')
  })

  test('has() reports membership without constructing', () => {
    const errors = defineErrors({ 'a.one': { kind: 'state' } })
    expect(errors.has('a.one')).toBe(true)
    expect(errors.has('toString')).toBe(false)
  })
})
