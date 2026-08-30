import { describe, expect, test } from 'bun:test'
import { defineErrors } from '#catalogue/define-errors'
import { type ParamsOf, params } from '#catalogue/params'

/** Compile-time assertion: fails `tsc --noEmit`, invisible at runtime. */
type Expect<T extends true> = T
type Equals<A, B> =
  (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false

/* -------------------------------------------------------------------------- */
/* The three spec shapes are matched structurally, so none of these fixtures   */
/* imports anything. That is the whole point: a consuming app can use Zod,     */
/* TypeBox, or neither, and this package depends on none of them.             */
/* -------------------------------------------------------------------------- */

// What `Type.Object({ userId: Type.String() })` looks like to the type system.
interface TypeBoxFixture {
  readonly static: { userId: string }
  readonly type: 'object'
}

// What Zod, Valibot, ArkType and Effect Schema all expose.
interface StandardSchemaFixture {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly types?: { readonly input: { raw: string }; readonly output: { userId: string } }
  }
}

type _MarkerCarriesItsType = Expect<
  Equals<ParamsOf<ReturnType<typeof params<{ userId: string }>>>, { userId: string }>
>
type _TypeBoxReadsStatic = Expect<Equals<ParamsOf<TypeBoxFixture>, { userId: string }>>
type _StandardSchemaReadsOutput = Expect<
  Equals<ParamsOf<StandardSchemaFixture>, { userId: string }>
>

// Standard Schema wins over TypeBox when a library happens to expose both, and
// the marker wins over everything — the reason `ParamsOf` is ordered as it is.
interface BothFixture extends StandardSchemaFixture {
  readonly static: { wrong: true }
}
type _StandardSchemaWinsOverStatic = Expect<Equals<ParamsOf<BothFixture>, { userId: string }>>

describe('params specs', () => {
  const errors = defineErrors({
    'test.marker': { kind: 'state', params: params<{ userId: string }>() },
    'test.typebox': { kind: 'state', params: {} as TypeBoxFixture },
    'test.standard': { kind: 'state', params: {} as StandardSchemaFixture },
    'test.none': { kind: 'state' },
  })

  test('all three spec shapes require and carry params at runtime', () => {
    expect(errors.create('test.marker', { userId: 'u1' }).params).toEqual({ userId: 'u1' })
    expect(errors.create('test.typebox', { userId: 'u2' }).params).toEqual({ userId: 'u2' })
    expect(errors.create('test.standard', { userId: 'u3' }).params).toEqual({ userId: 'u3' })
  })

  test('an entry with no spec takes a context in the first position instead', () => {
    const cause = new Error('boom')
    const failure = errors.create('test.none', { cause })
    expect(failure.cause).toBe(cause)
    expect('params' in failure).toBe(false)
  })

  test('the marker is a shared frozen singleton, not a per-entry allocation', () => {
    expect(params<{ a: 1 }>() as unknown).toBe(params<{ b: 2 }>() as unknown)
    expect(Object.isFrozen(params())).toBe(true)
  })
})
