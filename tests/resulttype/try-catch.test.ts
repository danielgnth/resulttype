import { describe, expect, test } from 'bun:test'
import type { Err, Ok, Result } from '#resulttype/result'
import { tryCatch, tryCatchAsync, UnknownError } from '#resulttype/try-catch'

/** Compile-time assertion: fails `tsc --noEmit`, invisible at runtime. */
const expectType = <TExpected>(_value: TExpected): void => {}

class DomainError extends Error {
  constructor(cause: Error) {
    super('domain', { cause })
    this.name = 'DomainError'
  }
}

const nonErrorThrows: [label: string, thrown: unknown][] = [
  ['a string', 'boom'],
  ['undefined', undefined],
  ['null', null],
  ['zero', 0],
  ['an object', { code: 'E' }],
]

describe('tryCatch', () => {
  test('wraps a returned value in an ok result', () => {
    const result = tryCatch(() => 42)
    expect(result).toEqual([42, undefined])
  })

  test('wraps a falsy returned value in an ok result', () => {
    expect(tryCatch(() => undefined)).toEqual([undefined, undefined])
  })

  test('passes a thrown Error through untouched when there is no catchFn', () => {
    const thrown = new TypeError('boom')
    const [value, error] = tryCatch(() => {
      throw thrown
    })

    expect(value).toBeUndefined()
    expect(error).toBe(thrown)
  })

  test.each(nonErrorThrows)('coerces a non-Error throw (%s) to UnknownError', (_label, thrown) => {
    const [, error] = tryCatch(() => {
      throw thrown
    })

    expect(error).toBeInstanceOf(UnknownError)
    expect(error?.cause).toBe(thrown)
  })

  test('maps the error through catchFn', () => {
    const [, error] = tryCatch(
      () => {
        throw new TypeError('boom')
      },
      (caught) => new DomainError(caught),
    )

    expect(error).toBeInstanceOf(DomainError)
    expect(error?.cause).toBeInstanceOf(TypeError)
  })

  test('never calls catchFn on success', () => {
    let calls = 0
    const result = tryCatch(
      () => 'fine',
      (caught) => {
        calls += 1
        return new DomainError(caught)
      },
    )

    expect(result).toEqual(['fine', undefined])
    expect(calls).toBe(0)
  })

  test('always hands catchFn a real Error, even for a non-Error throw', () => {
    let caught: unknown
    tryCatch(
      () => {
        throw 'boom'
      },
      (error) => {
        caught = error
        return new DomainError(error)
      },
    )

    expect(caught).toBeInstanceOf(UnknownError)
    expect((caught as UnknownError).cause).toBe('boom')
  })

  test('lets a throw from catchFn escape — mapping is the caller’s contract', () => {
    expect(() =>
      tryCatch(
        () => {
          throw new Error('boom')
        },
        () => {
          throw new Error('catchFn exploded')
        },
      ),
    ).toThrow('catchFn exploded')
  })

  describe('types', () => {
    test('defaults the error to Error without a catchFn', () => {
      expectType<Result<number, Error>>(tryCatch(() => 1))
    })

    test('takes the error type from catchFn', () => {
      const result = tryCatch(
        () => 1,
        (caught) => new DomainError(caught),
      )
      expectType<Result<number, DomainError>>(result)
    })

    test('widens the error union with TMayThrowOther, which defaults to never', () => {
      const result = tryCatch<number, DomainError, RangeError>(
        () => 1,
        (caught) => new DomainError(caught),
      )
      expectType<Result<number, DomainError | RangeError>>(result)
    })

    test('narrows to Ok / Err on the error slot', () => {
      const result = tryCatch(() => 1)

      if (result[1] === undefined) expectType<Ok<number>>(result)
      else expectType<Err<Error>>(result)
    })
  })
})

describe('tryCatchAsync', () => {
  test('wraps a resolved value in an ok result', async () => {
    expect(await tryCatchAsync(async () => 42)).toEqual([42, undefined])
  })

  test('passes a rejection Error through untouched when there is no catchFn', async () => {
    const thrown = new TypeError('boom')
    const [, error] = await tryCatchAsync(() => Promise.reject(thrown))
    expect(error).toBe(thrown)
  })

  test('also catches a synchronous throw from fn', async () => {
    const thrown = new Error('sync boom')
    const [, error] = await tryCatchAsync<never>(() => {
      throw thrown
    })

    expect(error).toBe(thrown)
  })

  test.each(nonErrorThrows)(
    'coerces a non-Error rejection (%s) to UnknownError',
    async (_label, thrown) => {
      const [, error] = await tryCatchAsync(() => Promise.reject(thrown))
      expect(error).toBeInstanceOf(UnknownError)
      expect(error?.cause).toBe(thrown)
    },
  )

  test('maps the error through catchFn', async () => {
    const [, error] = await tryCatchAsync(
      () => Promise.reject(new TypeError('boom')),
      (caught) => new DomainError(caught),
    )

    expect(error).toBeInstanceOf(DomainError)
    expect(error?.cause).toBeInstanceOf(TypeError)
  })

  test('never calls catchFn on success', async () => {
    let calls = 0
    await tryCatchAsync(
      async () => 'fine',
      (caught) => {
        calls += 1
        return new DomainError(caught)
      },
    )

    expect(calls).toBe(0)
  })

  test('rejects rather than returning a result when catchFn throws', async () => {
    const promise = tryCatchAsync(
      () => Promise.reject(new Error('boom')),
      () => {
        throw new Error('catchFn exploded')
      },
    )

    await expect(promise).rejects.toThrow('catchFn exploded')
  })

  test('leaves no unhandled rejection behind', async () => {
    const results = await Promise.all([
      tryCatchAsync(() => Promise.reject(new Error('a'))),
      tryCatchAsync(async () => 'b'),
    ])

    expect(results.map(([, error]) => error?.message)).toEqual(['a', undefined])
  })

  describe('types', () => {
    test('resolves to a Result with the error type from catchFn', () => {
      const promise = tryCatchAsync(
        async () => 1,
        (caught) => new DomainError(caught),
      )
      expectType<Promise<Result<number, DomainError>>>(promise)
    })

    test('widens the error union with TMayThrowOther', () => {
      const promise = tryCatchAsync<number, DomainError, RangeError>(
        async () => 1,
        (caught) => new DomainError(caught),
      )
      expectType<Promise<Result<number, DomainError | RangeError>>>(promise)
    })
  })
})

describe('UnknownError', () => {
  test('is an Error carrying the thrown value as cause', () => {
    const error = new UnknownError('boom')
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('Unknown error thrown')
    expect(error.cause).toBe('boom')
  })

  test('installs a cause property even when the thrown value is undefined', () => {
    const error = new UnknownError(undefined)
    expect('cause' in error).toBe(true)
    expect(error.cause).toBeUndefined()
  })

  test('does not set `name`, so it reports as Error', () => {
    expect(new UnknownError('boom').name).toBe('UnknownError')
    expect(new UnknownError('boom').constructor.name).toBe('UnknownError')
  })
})
