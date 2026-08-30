import {
  canExpose,
  DEFAULT_EXPOSURE,
  type Exposure,
  type ExposureChannel,
  isExposure,
} from './exposure.ts'
import {
  DEFAULT_ERROR_KIND,
  type ErrorFault,
  type ErrorKind,
  isErrorKind,
  type RetryPolicy,
} from './kind.ts'

/** A sub-failure. No kind, no exposure — it inherits the parent's. */
export interface Issue {
  readonly path: readonly (string | number)[]
  readonly code: string
  readonly params?: Readonly<Record<string, unknown>>
}

/**
 * The failure every expected error in the fleet is made of: a plain,
 * JSON-native object with no prototype of its own.
 *
 * Not a `class extends Error`, and the reasons compound. It is ~200x cheaper to
 * allocate on V8, because it skips stack capture. It survives `JSON.stringify`,
 * `structuredClone`, `postMessage`, and the React Native bridge, none of which
 * an `Error` does. It cannot be broken by two copies of this package in one
 * dependency tree, because nothing does an `instanceof`. And the JIT can
 * escape-analyse it, which it can never do for an `Error` — so a `Result` in a
 * hot loop can approach zero cost rather than merely a small one.
 *
 * Everything static is resolved from the catalogue entry at construction and
 * stored here, so a failure that crosses a wire stays fully self-describing:
 * the receiver needs no catalogue to know it is a 404 that must not be retried.
 */
export interface Failure<TCode extends string = string> {
  /**
   * Simultaneously the discriminant, the i18n key, and the OpenAPI error key.
   * High-cardinality by design — see {@link ErrorKind} for the axis a metric or
   * an OTel `error.type` attribute should group by instead.
   */
  readonly code: TCode
  readonly kind: ErrorKind
  /** `null` for failures that can only happen inside a client. */
  readonly http: number | null
  readonly retry: RetryPolicy
  readonly fault: ErrorFault
  readonly exposure: Exposure
  /** Developer-facing only, and governed by `exposure`. Never shown to a user. */
  readonly message?: string
  /** The values this code's params type describes. */
  readonly params?: Readonly<Record<string, unknown>>
  /** Field-level detail, for a validation failure that has more than one cause. */
  readonly issues?: readonly Issue[]
  readonly cause?: unknown
  /** Present only when the entry asked for it — see `capturesStackByDefault`. */
  readonly stack?: string
}

/**
 * A structural check, not an `instanceof`.
 *
 * Deliberately: a failure is designed to survive serialisation, and a value
 * that arrived over a wire or through `postMessage` has no prototype left to
 * check. The three fields tested are the three that are always present and
 * always constrained, which is enough to tell a failure from any other object
 * without making the check expensive.
 */
export const isFailure = (value: unknown): value is Failure => {
  if (typeof value !== 'object' || value === null) return false
  try {
    const candidate = value as Partial<Failure>
    return (
      typeof candidate.code === 'string' &&
      isErrorKind(candidate.kind) &&
      isExposure(candidate.exposure)
    )
  } catch {
    // A revoked proxy, or an object whose getters throw. Reading a property is
    // not supposed to be able to fail, but this is a guard over `unknown` — the
    // one type that makes no promises — and a type guard that throws is worse
    // than useless to the boundary code that depends on it.
    return false
  }
}

export const isRetryable = (failure: Failure): boolean => failure.retry === 'backoff'

/**
 * Whether this should count against an SLO or wake somebody. Caller and
 * environment faults are noise on a provider's error budget.
 */
export const isProviderFault = (failure: Failure): boolean => failure.fault === 'provider'

/**
 * The HTTP status a failure becomes at an HTTP seam.
 *
 * Client-only failures have no honest status. They reach this when a
 * client-side failure is forwarded to a server — a crash report, a sync queue —
 * and `fallback` is what that seam decides they mean.
 */
export const httpStatusFor = (failure: Failure, fallback = 500): number => failure.http ?? fallback

/**
 * Strips a failure down to what `channel` is allowed to see.
 *
 * This is the payoff of the whole exposure ladder, and it belongs at exactly
 * one place per sink — the HTTP serialiser, the log formatter, the crash
 * reporter hook — rather than at each throw site, which is what a `presentable`
 * boolean got wrong.
 *
 * `code`, `kind`, `http`, `retry`, and `fault` always survive: they are a
 * closed vocabulary the author of the catalogue chose, so they cannot leak
 * anything that was not deliberately published. What gets dropped is the
 * unbounded text — `message`, `cause`, `stack` — plus `params` and `issues`,
 * which carry caller-supplied values and can therefore contain anything at all.
 */
export const redact = (failure: Failure, channel: ExposureChannel): Failure => {
  if (canExpose(failure.exposure, channel)) return failure
  return {
    code: failure.code,
    kind: failure.kind,
    http: failure.http,
    retry: failure.retry,
    fault: failure.fault,
    exposure: failure.exposure,
  }
}

/**
 * The code a boundary normalises an unmodelled throw into.
 *
 * Exported as a constant rather than written twice, so the built-in catalogue
 * and {@link toFailure} cannot drift apart about what it is called.
 */
export const UNEXPECTED_CODE = 'system.unexpected' as const

/**
 * The shape {@link UNEXPECTED_CODE} resolves to, without going through a
 * catalogue.
 *
 * A boundary handler has to work when the catalogue is the very thing that
 * failed to load, so this one entry is inlined. The built-in catalogue declares
 * the same code from the same constant and must agree with these values; the
 * test suite asserts that it does.
 */
export const UNEXPECTED_DEFAULTS = {
  kind: DEFAULT_ERROR_KIND,
  http: 500,
  retry: 'backoff',
  fault: 'provider',
  exposure: DEFAULT_EXPOSURE,
} as const satisfies Pick<Failure, 'kind' | 'http' | 'retry' | 'fault' | 'exposure'>
