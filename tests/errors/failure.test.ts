import { describe, expect, test } from 'bun:test'
import { Defect, invariant, toFailure } from '#errors/defect'
import { EXPOSURE_CHANNELS } from '#errors/exposure'
import {
  type Failure,
  httpStatusFor,
  isFailure,
  isProviderFault,
  isRetryable,
  redact,
  UNEXPECTED_CODE,
} from '#errors/failure'

const failure = (overrides: Partial<Failure> = {}): Failure => ({
  code: 'user.not_found',
  kind: 'state',
  http: 404,
  retry: 'never',
  fault: 'caller',
  exposure: 'diagnostic',
  message: 'no such user u1',
  params: { userId: 'u1' },
  cause: new Error('row missing'),
  stack: 'Error\n  at somewhere',
  ...overrides,
})

describe('isFailure', () => {
  // Structural on purpose: a failure that arrived over a wire or through
  // postMessage has no prototype left for an instanceof to find.
  test('recognises a failure that has been through JSON', () => {
    const round = JSON.parse(JSON.stringify(failure({ cause: undefined })))
    expect(isFailure(round)).toBe(true)
  })

  test('rejects an Error, and anything missing the constrained fields', () => {
    expect(isFailure(new Error('boom'))).toBe(false)
    expect(isFailure({ code: 'a.b' })).toBe(false)
    expect(isFailure({ code: 'a.b', kind: 'state' })).toBe(false)
    expect(isFailure({ code: 'a.b', kind: 'nope', exposure: 'public' })).toBe(false)
    expect(isFailure(null)).toBe(false)
    expect(isFailure('a.b')).toBe(false)
  })
})

describe('derived predicates', () => {
  test('read from the failure, not from a lookup', () => {
    expect(isRetryable(failure({ retry: 'backoff' }))).toBe(true)
    expect(isRetryable(failure({ retry: 'deferred' }))).toBe(false)
    expect(isProviderFault(failure({ fault: 'provider' }))).toBe(true)
    expect(isProviderFault(failure({ fault: 'environment' }))).toBe(false)
  })

  test('httpStatusFor falls back only for client-only failures', () => {
    expect(httpStatusFor(failure())).toBe(404)
    expect(httpStatusFor(failure({ http: null }))).toBe(500)
    expect(httpStatusFor(failure({ http: null }), 0)).toBe(0)
  })
})

describe('redact', () => {
  test('returns the same object when the channel is allowed', () => {
    const original = failure({ exposure: 'public' })
    expect(redact(original, 'end_user')).toBe(original)
  })

  test('drops every unbounded field when the channel is not allowed', () => {
    const stripped = redact(failure({ exposure: 'diagnostic' }), 'end_user')
    expect(stripped.message).toBeUndefined()
    expect(stripped.params).toBeUndefined()
    expect(stripped.cause).toBeUndefined()
    expect(stripped.stack).toBeUndefined()
    expect(stripped.issues).toBeUndefined()
  })

  // The point of the ladder: a client still learns enough to react correctly
  // even when it learns nothing about why.
  test('keeps the closed vocabulary so a caller can still act', () => {
    const stripped = redact(failure({ exposure: 'diagnostic', retry: 'backoff' }), 'end_user')
    expect(stripped.code).toBe('user.not_found')
    expect(stripped.kind).toBe('state')
    expect(stripped.http).toBe(404)
    expect(stripped.retry).toBe('backoff')
    expect(stripped.fault).toBe('caller')
  })

  test('drops the unbounded fields as absent keys, not undefined ones', () => {
    const stripped = redact(failure({ exposure: 'secret' }), 'logs')
    expect('message' in stripped).toBe(false)
    expect('cause' in stripped).toBe(false)
    expect('stack' in stripped).toBe(false)
  })

  test('a secret failure is stripped for every channel there is', () => {
    for (const channel of EXPOSURE_CHANNELS) {
      expect(redact(failure({ exposure: 'secret' }), channel).message).toBeUndefined()
    }
  })
})

describe('toFailure', () => {
  test('normalises an Error, keeping its message, cause and stack', () => {
    const thrown = new Error('boom')
    const result = toFailure(thrown)
    expect(result.code).toBe(UNEXPECTED_CODE)
    expect(result.kind).toBe('internal')
    expect(result.fault).toBe('provider')
    expect(result.message).toBe('boom')
    expect(result.cause).toBe(thrown)
    expect(result.stack).toBe(thrown.stack)
  })

  test('is idempotent, so a double-wrapped boundary is harmless', () => {
    const once = toFailure(new Error('boom'))
    expect(toFailure(once)).toBe(once)
  })

  test.each([
    ['boom', 'string "boom"'],
    [42, '42'],
    [null, 'null'],
    [undefined, 'undefined'],
    [{ a: 1 }, '[object Object]'],
    [[1, 2], '[object Array]'],
    [Symbol('s'), 'symbol'],
    [10n, 'bigint 10'],
  ])('describes a non-Error throw (%p) without exploding', (thrown, expected) => {
    const result = toFailure(thrown)
    expect(result.message).toBe(`Non-error thrown: ${expected}`)
    expect(result.cause).toBe(thrown)
    expect('stack' in result).toBe(false)
  })

  // A value nobody vetted may be circular, enormous, or a Proxy that throws on
  // access — which is why `describe` never reaches for JSON.stringify.
  test('survives a circular object and a hostile proxy', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => toFailure(circular)).not.toThrow()

    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('nope')
        },
      },
    )
    expect(() => toFailure(hostile)).not.toThrow()
  })
})

describe('invariant', () => {
  test('throws a Defect that is a real Error with a stack', () => {
    expect(() => invariant(false, 'must not happen')).toThrow(Defect)
    try {
      invariant(false, 'must not happen')
    } catch (caught) {
      expect(caught).toBeInstanceOf(Error)
      expect((caught as Defect).message).toBe('must not happen')
      expect((caught as Defect).name).toBe('Defect')
      expect((caught as Defect).stack).toBeDefined()
    }
  })

  test('passes a truthy condition through and narrows the type', () => {
    const value: string | undefined = 'present'
    invariant(value, 'expected a value')
    const narrowed: string = value
    expect(narrowed).toBe('present')
  })

  test('a Defect normalises through the boundary like anything else', () => {
    const result = toFailure(new Defect('broken invariant'))
    expect(result.code).toBe(UNEXPECTED_CODE)
    expect(result.message).toBe('broken invariant')
  })
})
