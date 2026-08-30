import { describe, expect, test } from 'bun:test'
import {
  type Err,
  err,
  isErr,
  isOk,
  type Ok,
  ok,
  type Result,
  unwrapOr,
  unwrapOrThrow,
} from '#resulttype/result'

/** Compile-time assertion: fails `tsc --noEmit`, invisible at runtime. */
const expectType = <TExpected>(_value: TExpected): void => {}

describe('ok', () => {
  test('puts the value first and undefined second', () => {
    expect(ok(42)).toEqual([42, undefined])
  })

  test('preserves the value by reference', () => {
    const value = { a: 1 }
    expect(ok(value)[0]).toBe(value)
  })

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['zero', 0],
    ['empty string', ''],
    ['false', false],
  ])('carries a falsy value (%s) without collapsing it', (_label, value) => {
    const result = ok(value)
    expect(result[0]).toBe(value)
    expect(result[1]).toBeUndefined()
  })
})

describe('err', () => {
  test('puts undefined first and the error second', () => {
    const error = new Error('boom')
    expect(err(error)).toEqual([undefined, error])
  })

  test('preserves the error instance by reference', () => {
    const error = new TypeError('boom')
    expect(err(error)[1]).toBe(error)
  })
})

describe('isOk / isErr', () => {
  test('agree on an ok result', () => {
    const result: Result<number> = ok(1)
    expect(isOk(result)).toBe(true)
    expect(isErr(result)).toBe(false)
  })

  test('agree on an err result', () => {
    const result: Result<number> = err(new Error('boom'))
    expect(isOk(result)).toBe(false)
    expect(isErr(result)).toBe(true)
  })

  test('read the error slot, not the value slot: ok(undefined) is still ok', () => {
    const result: Result<undefined> = ok(undefined)
    expect(isOk(result)).toBe(true)
    expect(isErr(result)).toBe(false)
  })

  test('narrow the result type', () => {
    const result: Result<number, TypeError> = ok(1)

    if (isOk(result)) {
      expectType<Ok<number>>(result)
      expectType<number>(result[0])
      expect(result[0]).toBe(1)
    } else {
      expectType<Err<TypeError>>(result)
      expectType<TypeError>(result[1])
      throw new Error('unreachable')
    }

    if (isErr(result)) throw new Error('unreachable')
    expectType<Ok<number>>(result)
  })
})

describe('unwrapOr', () => {
  test('returns the value when ok', () => {
    expect(unwrapOr(ok(1), 99)).toBe(1)
  })

  test('returns the fallback when err', () => {
    expect(unwrapOr(err(new Error('boom')) as Result<number>, 99)).toBe(99)
  })

  test('returns a falsy ok value rather than the fallback', () => {
    expect(unwrapOr(ok(0), 99)).toBe(0)
    expect(unwrapOr(ok(undefined), 99)).toBeUndefined()
  })

  test('widens the return type to the union of value and fallback', () => {
    const result: Result<number> = ok(1)
    expectType<number | string>(unwrapOr(result, 'fallback'))
  })
})

describe('unwrapOrThrow', () => {
  test('returns the value when ok', () => {
    expect(unwrapOrThrow(ok('value'))).toBe('value')
  })

  test('returns a falsy ok value instead of throwing', () => {
    expect(unwrapOrThrow(ok(undefined))).toBeUndefined()
    expect(unwrapOrThrow(ok(0))).toBe(0)
  })

  test('throws the exact error instance when err', () => {
    const error = new RangeError('boom')
    expect(() => unwrapOrThrow(err(error))).toThrow(error)
  })

  test('is the door out of the no-throw architecture for a custom error', () => {
    class DomainError extends Error {}
    const error = new DomainError('nope')

    try {
      unwrapOrThrow(err(error))
      throw new Error('unreachable')
    } catch (thrown) {
      expect(thrown).toBe(error)
      expect(thrown).toBeInstanceOf(DomainError)
    }
  })
})
