/**
 * The error slot is constrained to `NonNullable<unknown>` rather than `Error`.
 *
 * Two reasons, and the first is a hard requirement: the errors this library is
 * built around are plain objects, not `Error` instances, because that is ~200x
 * cheaper to allocate on V8 and is the only shape that survives
 * `structuredClone` and the React Native bridge. An `extends Error` bound would
 * reject them.
 *
 * The second is why the bound is not simply dropped. The whole `Result` design
 * rests on `r[1] === undefined` meaning "ok"; if `TError` could be `undefined`,
 * that discriminant would silently stop working. `NonNullable<unknown>` admits
 * plain objects *and* `Error`, and rejects exactly `null` and `undefined`.
 */
export type Ok<TValue> = readonly [value: TValue, error: undefined]
export type Err<TError extends NonNullable<unknown>> = readonly [value: undefined, error: TError]
export type Result<TValue, TError extends NonNullable<unknown> = Error> = Ok<TValue> | Err<TError>

/**
 * A {@link Result} that may or may not have arrived yet — for a signature that
 * accepts both a sync and an async implementation.
 */
export type PromisableResult<TValue, TError extends NonNullable<unknown>> =
  | Result<TValue, TError>
  | Promise<Result<TValue, TError>>

export const ok = <TValue>(value: TValue): Ok<TValue> => [value, undefined]
export const err = <TError extends NonNullable<unknown>>(error: TError): Err<TError> => [
  undefined,
  error,
]

export const isOk = <V, E extends NonNullable<unknown>>(r: Result<V, E>): r is Ok<V> =>
  r[1] === undefined
export const isErr = <V, E extends NonNullable<unknown>>(r: Result<V, E>): r is Err<E> =>
  r[1] !== undefined

export const unwrapOr = <V, E extends NonNullable<unknown>, F>(
  r: Result<V, E>,
  fallback: F,
): V | F => (r[1] === undefined ? (r[0] as V) : fallback)

/**
 * The door *out* of the no-throw architecture, mirroring `tryCatch` as the door
 * in.
 *
 * Non-`Error` errors are wrapped rather than thrown bare. Throwing a plain
 * object gives a `catch` block something with no stack and no `message`, which
 * breaks every handler written against the `Error` interface — including the
 * runtime's own unhandled-rejection reporting. Wrapping costs a stack capture,
 * but this is the boundary where a program is giving up, not a hot path.
 */
export const unwrapOrThrow = <V, E extends NonNullable<unknown>>(r: Result<V, E>): V => {
  if (r[1] !== undefined) throw toThrowable(r[1])
  return r[0] as V
}

/**
 * Wraps a thrown value that is not already an `Error`.
 *
 * The `cause` is the original value, untouched, so nothing is lost: a handler
 * that knows about failures can still recover the structured object with
 * `isFailure(error.cause)`.
 */
export class UnknownError extends Error {
  constructor(thrown: unknown) {
    super(messageFor(thrown), { cause: thrown })
    this.name = 'UnknownError'
  }
}

export const toThrowable = (value: unknown): Error =>
  value instanceof Error ? value : new UnknownError(value)

/**
 * Best-effort message for a value that was never meant to be one. Reads a
 * `message`, then a `code`, before giving up — which is what makes an
 * `UnknownError` wrapping a failure still say something useful in a log.
 */
const messageFor = (thrown: unknown): string => {
  if (typeof thrown === 'object' && thrown !== null) {
    const candidate = thrown as { message?: unknown; code?: unknown }
    if (typeof candidate.message === 'string') return candidate.message
    if (typeof candidate.code === 'string') return candidate.code
  }
  return 'Unknown error thrown'
}
