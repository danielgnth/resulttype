/**
 * How a catalogue entry declares the shape of its `params`.
 *
 * Three spec shapes are accepted and all three are matched *structurally*, so
 * this package depends on no validator at all:
 *
 * - {@link params}`<T>()` — a phantom marker. Types only, zero runtime, zero
 *   dependencies. The default, and enough for the common case where params are
 *   built by your own code and never crossed a wire.
 * - A **Standard Schema** — Zod, Valibot, ArkType, Effect Schema. Recognised by
 *   its `~standard` property; the static type is read from `~standard.types`.
 * - A **TypeBox** `TSchema`, recognised by its phantom `static` property. Keep
 *   TypeBox as an optional peer dependency if you want JSON Schema out of the
 *   catalogue for OpenAPI generation.
 *
 * Nothing here validates at runtime. The marker has nothing to validate with,
 * and Standard Schema's `validate` may return a promise, which `create` cannot
 * await. Validate params at the boundary that received them, which is where the
 * untrusted values actually arrive.
 */

declare const PARAMS_TYPE: unique symbol

/** A type carried at compile time and erased at runtime. */
export interface ParamsType<TParams> {
  readonly [PARAMS_TYPE]: TParams
}

/** Recognises Zod, Valibot, ArkType, Effect Schema — anything Standard Schema. */
export interface StandardSchemaLike {
  readonly '~standard': { readonly types?: unknown }
}

/** Recognises a TypeBox `TSchema` by its phantom `static` property. */
export interface TypeBoxLike {
  readonly static: unknown
}

export type ParamsSpec = ParamsType<unknown> | StandardSchemaLike | TypeBoxLike

/**
 * Declares params by type alone.
 *
 * ```ts
 * 'user.not_found': { kind: 'state', params: params<{ userId: string }>() }
 * ```
 *
 * The returned object is a shared frozen singleton: nothing reads it, it exists
 * only to carry a type, so allocating a new one per entry would be waste.
 */
export const params = <TParams>(): ParamsType<TParams> =>
  EMPTY_PARAMS as unknown as ParamsType<TParams>

const EMPTY_PARAMS = Object.freeze({})

/**
 * The static type a spec describes.
 *
 * Ordered most-specific first: the marker is checked before Standard Schema,
 * and Standard Schema before TypeBox, because a schema library is free to have
 * a `static` property too and the more precise match should win.
 */
export type ParamsOf<TSpec> =
  TSpec extends ParamsType<infer TParams>
    ? TParams
    : TSpec extends { readonly '~standard': { readonly types?: infer TTypes } }
      ? TTypes extends { readonly output: infer TOutput }
        ? TOutput
        : Readonly<Record<string, unknown>>
      : TSpec extends { readonly static: infer TStatic }
        ? TStatic
        : Readonly<Record<string, unknown>>
