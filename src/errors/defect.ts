import { type Failure, isFailure, UNEXPECTED_CODE, UNEXPECTED_DEFAULTS } from './failure.ts'

/**
 * A bug. The other channel.
 *
 * Failures travel as values in a `Result`; defects travel by being thrown. The
 * split is not a preference, it is what TypeScript forces: there is no way to
 * write "returns `E`, or panics", so the only way to keep a `Result<T, E>`
 * honest and narrow is for the unmodelled cases to leave through the throw
 * channel. Put them in `E` instead and every call site needs a `default` branch
 * — which permanently disables the exhaustiveness checking that is the entire
 * reason to use `Result` over exceptions.
 *
 * It is also the honest model of the runtime. `RangeError: Maximum call stack
 * size exceeded`, an OOM, a `TypeError` from a null dereference — these throw
 * no matter what a library promises, and every application already has a
 * top-level boundary. Defects use the one that exists rather than pretending
 * they can be prevented.
 *
 * A `class extends Error`, unlike {@link Failure}, because here the stack is
 * the entire point and nobody is allocating these in a hot loop.
 */
export class Defect extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = new.target.name
  }
}

/**
 * Asserts something the code believes is impossible.
 *
 * The one place a developer *deliberately* produces a defect. Everything else
 * that becomes one — a thrown `TypeError`, a rejected promise from a driver —
 * is produced by the runtime, which is why there is no decision to make at a
 * throw site: you pick a code from a catalogue and get a {@link Failure}, or
 * you assert an invariant and get a `Defect`. Never a judgement call about
 * which bucket a failure belongs in.
 */
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Defect(message)
}

/**
 * Normalises anything thrown into a {@link Failure}. The inbound half of the
 * boundary, and the only place `unknown` becomes structured.
 *
 * Call it once per platform, where throws surface: Express error middleware, a
 * React error boundary, `process.on('uncaughtException')`, `window.onerror`,
 * `unhandledrejection`. Not at every seam — a seam should translate a foreign
 * throw into a *named* catalogue code, and blanket-coercing here instead is how
 * `E` widens back into uselessness.
 *
 * An existing failure passes through untouched, so calling it twice is safe.
 */
export const toFailure = (thrown: unknown): Failure => {
  try {
    return normalise(thrown)
  } catch {
    // Inspecting the value failed: a revoked proxy, a getter that throws, an
    // exotic object. This function is the last thing standing between a throw
    // and an unhandled crash, so it does not get to fail. The value is still
    // kept as `cause` — holding a reference touches nothing.
    return { code: UNEXPECTED_CODE, ...UNEXPECTED_DEFAULTS, message: UNINSPECTABLE, cause: thrown }
  }
}

const UNINSPECTABLE = 'Unrepresentable value thrown'

const normalise = (thrown: unknown): Failure => {
  if (isFailure(thrown)) return thrown

  const error = thrown instanceof Error ? thrown : undefined
  return {
    code: UNEXPECTED_CODE,
    ...UNEXPECTED_DEFAULTS,
    // The message of a defect is never localised and never shown to a user, so
    // taking it verbatim is safe — `exposure` is what keeps it out of a
    // response body, not the fact that we declined to read it.
    message: error?.message ?? `Non-error thrown: ${describe(thrown)}`,
    cause: thrown,
    ...(error?.stack === undefined ? {} : { stack: error.stack }),
  }
}

/**
 * A short, allocation-cheap description of a non-`Error` throw. Deliberately
 * not `JSON.stringify`: this runs on a value nobody vetted, which may be
 * circular, enormous, or a `Proxy` that throws on access.
 */
const describe = (value: unknown): string => {
  if (value === null) return 'null'
  if (typeof value === 'string') return `string ${JSON.stringify(value.slice(0, 64))}`
  if (typeof value === 'object') return Object.prototype.toString.call(value)
  if (typeof value === 'bigint') return `bigint ${value}`
  if (typeof value === 'symbol' || typeof value === 'function') return typeof value
  return String(value)
}
