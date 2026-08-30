import { type Span, SpanStatusCode, type Tracer } from '@opentelemetry/api'
import { type Failure, isFailure, redact, toFailure } from '#errors/index'
import type { Result } from '#resulttype/result'

/**
 * OpenTelemetry integration, as a span-scoped wrapper rather than a hook.
 *
 * The span is held in a closure, never read from ambient context. That is the
 * whole reason this shape was chosen over a `tapErr` or a catalogue `onCreate`
 * hook: OTel's context propagation across `await` relies on AsyncLocalStorage,
 * which exists in Node and does not exist in a browser. Anything that reaches
 * for `trace.getActiveSpan()` after an await is a Node-only design, and this
 * package ships to browsers, Bun, Electron, and React Native too.
 *
 * It also records **once**, at the one place that knows the real outcome. A
 * failure created at the bottom of a call stack and handled two frames up never
 * happened as far as a trace is concerned, and a hook that fires at creation
 * cannot know that.
 *
 * `@opentelemetry/api` is an optional peer dependency. It is imported only from
 * this module, so the root and `./errors` entry points stay dependency-free.
 */

/**
 * Attribute names. `error.type` is the semantic-convention one and is
 * deliberately fed the *kind*, not the code: semconv asks for low cardinality,
 * and a code vocabulary grows without bound while the eight kinds do not.
 *
 * The rest are namespaced under `app.` because they are not semconv attributes
 * and the bare `error.*` namespace belongs to OpenTelemetry.
 */
export const SPAN_ATTRIBUTES = {
  kind: 'error.type',
  code: 'app.error.code',
  fault: 'app.error.fault',
  retry: 'app.error.retry',
} as const

/**
 * Writes a failure onto a span.
 *
 * Two things happen here that are the entire point of the integration.
 *
 * First, the failure is **redacted for the `traces` channel** before anything
 * is read off it. Traces almost always land in a third-party vendor's storage,
 * which is exactly why `restricted` sits one rung below `diagnostic` on the
 * exposure ladder: a failure carrying personal data is now structurally unable
 * to reach Datadog, enforced by the same mechanism that governs an HTTP
 * response rather than by somebody remembering.
 *
 * Second, only **provider faults set an error status**. Calling
 * `recordException` and `setStatus(ERROR)` on a handled `resource.not_found` is
 * the single most common way to make a trace useless — every request turns red
 * and the signal drowns. A caller or environment fault still gets its
 * attributes, so `app.error.code = "resource.not_found"` is queryable; it just
 * does not claim the operation failed, because it did not.
 */
export const recordFailure = (span: Span, failure: Failure): void => {
  const safe = redact(failure, 'traces')

  span.setAttribute(SPAN_ATTRIBUTES.kind, safe.kind)
  span.setAttribute(SPAN_ATTRIBUTES.code, safe.code)
  span.setAttribute(SPAN_ATTRIBUTES.fault, safe.fault)
  span.setAttribute(SPAN_ATTRIBUTES.retry, safe.retry)

  if (safe.fault !== 'provider') return

  span.setStatus({ code: SpanStatusCode.ERROR, message: safe.code })
  // `recordException` takes `{ name, message, stack }`, not an `Error`, which is
  // what lets a plain-object failure be recorded without ever pretending to be
  // one. Fields the exposure stripped are simply absent.
  span.recordException({
    name: safe.code,
    ...(safe.message === undefined ? {} : { message: safe.message }),
    ...(safe.stack === undefined ? {} : { stack: safe.stack }),
  })
}

/**
 * Records whatever is in a `Result`'s error slot.
 *
 * A non-failure — a bare `Error` from an unmapped `tryCatch` — is normalised
 * through `toFailure` first, so a seam that has not been given a code yet still
 * produces a well-formed span rather than nothing.
 */
const recordError = (span: Span, error: NonNullable<unknown>): void => {
  recordFailure(span, isFailure(error) ? error : toFailure(error))
}

/**
 * Runs a `Result`-returning function inside a new active span.
 *
 * On success the status is left **UNSET**, not `OK`. The specification reserves
 * `OK` for an operation a developer has explicitly validated as successful;
 * setting it on everything destroys the distinction and tells a backend to stop
 * inferring anything from the absence of an error.
 *
 * A thrown defect is recorded and **rethrown, never converted to a `Result`**.
 * Turning it into one here would quietly widen every error type in the program
 * and undo the two-channel split: failures are values, defects are thrown, and
 * a tracing wrapper is not the place to renegotiate that.
 */
export function withSpan<TValue, TError extends NonNullable<unknown>>(
  tracer: Tracer,
  name: string,
  fn: (span: Span) => Result<TValue, TError>,
): Result<TValue, TError> {
  return tracer.startActiveSpan(name, (span) => {
    try {
      const result = fn(span)
      if (result[1] !== undefined) recordError(span, result[1])
      return result
    } catch (thrown) {
      recordFailure(span, toFailure(thrown))
      throw thrown
    } finally {
      // In a `finally`, so a defect on its way out still closes the span. A span
      // that is never ended is worse than a missing one: it holds memory and the
      // trace stays incomplete forever rather than showing an error.
      span.end()
    }
  })
}

/** {@link withSpan} for a promise. Also catches a synchronous throw from `fn`. */
export function withSpanAsync<TValue, TError extends NonNullable<unknown>>(
  tracer: Tracer,
  name: string,
  fn: (span: Span) => Promise<Result<TValue, TError>>,
): Promise<Result<TValue, TError>> {
  return tracer.startActiveSpan(name, async (span) => {
    try {
      const result = await fn(span)
      if (result[1] !== undefined) recordError(span, result[1])
      return result
    } catch (thrown) {
      recordFailure(span, toFailure(thrown))
      throw thrown
    } finally {
      span.end()
    }
  })
}

export interface Tracing {
  withSpan<TValue, TError extends NonNullable<unknown>>(
    name: string,
    fn: (span: Span) => Result<TValue, TError>,
  ): Result<TValue, TError>
  withSpanAsync<TValue, TError extends NonNullable<unknown>>(
    name: string,
    fn: (span: Span) => Promise<Result<TValue, TError>>,
  ): Promise<Result<TValue, TError>>
}

/**
 * Binds a tracer once, so call sites name an operation and nothing else.
 *
 * ```ts
 * const { withSpanAsync } = tracing(trace.getTracer('billing'))
 *
 * const [invoice, error] = await withSpanAsync('charge', () =>
 *   tryCatchAsync(() => stripe.charge(id), errors.toErr('billing.declined')),
 * )
 * ```
 */
export const tracing = (tracer: Tracer): Tracing => ({
  withSpan: (name, fn) => withSpan(tracer, name, fn),
  withSpanAsync: (name, fn) => withSpanAsync(tracer, name, fn),
})
