import { err, ok, type Result, toThrowable } from '#resulttype/result'

// Re-exported from its definition in `result.ts`, where `unwrapOrThrow` also
// needs it. It stays importable from here because this is the module whose
// coercion produces it, and that is where callers look for it.
export { UnknownError } from '#resulttype/result'

/**
 * The door *into* the no-throw architecture, mirroring `unwrapOrThrow` as the
 * door out: it runs code that still throws and hands back a {@link Result}.
 *
 * `catchFn` maps the caught error to whatever this layer's error type is. It is
 * always handed a real `Error`, so a `throw 'boom'` somewhere downstream cannot
 * arrive at it as a string, and it is always safe to attach as a `cause`.
 *
 * This function knows nothing about error codes or catalogues, and must not:
 * it is the root export, and a catalogue lives a layer above. The intended use
 * is to hand it a mapper the catalogue built —
 * `tryCatch(() => db.query(sql), errors.toErr('db.unavailable'))` — so that a
 * seam *translates* a foreign throw into a named failure rather than widening
 * the error type to "something went wrong".
 *
 * With no `catchFn` the error type is `Error`: a thrown `Error` is passed
 * through untouched and only a non-`Error` throw is coerced. Narrowing the
 * signature to the coercion would be the same kind of lie the `Result` type
 * itself rejects — a type that is wrong about what it holds. Pass a `catchFn`
 * to get an error type worth narrowing on.
 *
 * `TMayThrowOther` widens the error union with errors the caller knows the body
 * can produce but this function cannot see. It defaults to `never`: a default
 * of `Error` silently widens every result to the top error type and undoes the
 * point of typing them.
 */
export function tryCatch<
  TValue,
  TError extends NonNullable<unknown> = Error,
  TMayThrowOther extends NonNullable<unknown> = never,
>(fn: () => TValue, catchFn?: (error: Error) => TError): Result<TValue, TError | TMayThrowOther> {
  try {
    return ok(fn()) as Result<TValue, TError | TMayThrowOther>
  } catch (thrown) {
    return errorResult<TError | TMayThrowOther>(thrown, catchFn)
  }
}

/** {@link tryCatch} for a promise. Also catches a synchronous throw from `fn`. */
export async function tryCatchAsync<
  TValue,
  TError extends NonNullable<unknown> = Error,
  TMayThrowOther extends NonNullable<unknown> = never,
>(
  fn: () => Promise<TValue>,
  catchFn?: (error: Error) => TError,
): Promise<Result<TValue, TError | TMayThrowOther>> {
  try {
    return ok(await fn()) as Result<TValue, TError | TMayThrowOther>
  } catch (thrown) {
    return errorResult<TError | TMayThrowOther>(thrown, catchFn)
  }
}

function errorResult<TError extends NonNullable<unknown>>(
  thrown: unknown,
  catchFn: ((error: Error) => TError) | undefined,
): Result<never, TError> {
  const error = toThrowable(thrown)
  return err(catchFn ? catchFn(error) : error) as Result<never, TError>
}
