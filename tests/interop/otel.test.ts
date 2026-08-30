import { beforeEach, describe, expect, test } from 'bun:test'
import { SpanStatusCode, type Tracer } from '@opentelemetry/api'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { defineErrors } from '#catalogue/define-errors'
import { Defect } from '#errors/defect'
import { recordFailure, SPAN_ATTRIBUTES, tracing, withSpan } from '#interop/otel'
import { err, ok } from '#resulttype/result'

// A real exporter rather than a mock span: the assertions below are about what
// a backend actually receives, and a hand-rolled double would happily accept an
// attribute shape the SDK rejects.
const exporter = new InMemorySpanExporter()
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
const tracer: Tracer = provider.getTracer('test')

const errors = defineErrors({
  'db.unavailable': { kind: 'availability' },
  'user.not_found': { kind: 'state', http: 404, exposure: 'public' },
  'vault.unreadable': { kind: 'internal', exposure: 'secret' },
  'billing.declined': { kind: 'access', http: 402, exposure: 'restricted' },
})

/**
 * Exactly what a backend receives, and nothing else. A `ReadableSpan` also
 * holds a cyclic reference back to its provider, so this is both the more
 * precise assertion and the only serialisable one.
 */
const exported = (span: ReadableSpan): string =>
  JSON.stringify({
    name: span.name,
    attributes: span.attributes,
    status: span.status,
    events: span.events,
  })

const only = (): ReadableSpan => {
  const spans = exporter.getFinishedSpans()
  expect(spans).toHaveLength(1)
  return spans[0] as ReadableSpan
}

beforeEach(() => exporter.reset())

describe('span lifecycle', () => {
  test('ends the span and leaves status UNSET on success', () => {
    const result = withSpan(tracer, 'op', () => ok(42))
    expect(result).toEqual(ok(42))

    const span = only()
    expect(span.name).toBe('op')
    expect(span.ended).toBe(true)
    // Not OK: the spec reserves OK for an outcome a developer explicitly
    // validated, and setting it everywhere destroys the distinction.
    expect(span.status.code).toBe(SpanStatusCode.UNSET)
    expect(span.attributes[SPAN_ATTRIBUTES.code]).toBeUndefined()
  })

  test('passes the live span to the callback', () => {
    withSpan(tracer, 'op', (span) => {
      span.setAttribute('custom', 'yes')
      return ok(1)
    })
    expect(only().attributes.custom).toBe('yes')
  })

  test('ends the span even when a defect escapes, and rethrows it', () => {
    const defect = new Defect('broken invariant')
    expect(() =>
      withSpan(tracer, 'op', () => {
        throw defect
      }),
    ).toThrow(defect)

    const span = only()
    expect(span.ended).toBe(true)
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
    expect(span.events[0]?.name).toBe('exception')
  })

  // Converting it would silently widen every error type in the program and undo
  // the two-channel split. A tracing wrapper does not get to renegotiate that.
  test('never converts a thrown defect into a Result', () => {
    let returned: unknown = 'not reached'
    try {
      returned = withSpan(tracer, 'op', (): ReturnType<typeof ok<number>> => {
        throw new Error('boom')
      })
    } catch {
      /* expected */
    }
    expect(returned).toBe('not reached')
  })
})

describe('fault decides the status', () => {
  test('a provider fault sets ERROR and records an exception', () => {
    withSpan(tracer, 'op', () => err(errors.create('db.unavailable')))

    const span = only()
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
    expect(span.status.message).toBe('db.unavailable')
    expect(span.events[0]?.name).toBe('exception')
    expect(span.events[0]?.attributes?.['exception.type']).toBe('db.unavailable')
  })

  // The most common way to make a trace useless is turning every handled 404
  // red. Attributes still land, so the code stays queryable.
  test('a caller fault records attributes but leaves the status UNSET', () => {
    withSpan(tracer, 'op', () => err(errors.create('user.not_found')))

    const span = only()
    expect(span.status.code).toBe(SpanStatusCode.UNSET)
    expect(span.events).toHaveLength(0)
    expect(span.attributes[SPAN_ATTRIBUTES.code]).toBe('user.not_found')
    expect(span.attributes[SPAN_ATTRIBUTES.fault]).toBe('caller')
  })

  test('error.type carries the kind, not the code', () => {
    withSpan(tracer, 'op', () => err(errors.create('user.not_found')))
    // Low cardinality per semconv: eight kinds, not an unbounded code vocabulary.
    expect(only().attributes[SPAN_ATTRIBUTES.kind]).toBe('state')
  })

  test('retry policy rides along so a backend can chart transient failure', () => {
    withSpan(tracer, 'op', () => err(errors.create('db.unavailable')))
    expect(only().attributes[SPAN_ATTRIBUTES.retry]).toBe('backoff')
  })
})

describe('exposure is enforced at the trace boundary', () => {
  // Traces land in a third-party vendor's storage. This is why `restricted`
  // exists one rung below `diagnostic`.
  test('a restricted failure reaches logs but never a trace', () => {
    withSpan(tracer, 'op', () =>
      err(errors.create('billing.declined', { message: 'card 4242 for jane@example.com' })),
    )

    const span = only()
    expect(exported(span)).not.toContain('jane@example.com')
    expect(span.attributes[SPAN_ATTRIBUTES.code]).toBe('billing.declined')
  })

  test('a secret failure exports its code and nothing else', () => {
    withSpan(tracer, 'op', () =>
      err(errors.create('vault.unreadable', { message: 'postgres://user:hunter2@db' })),
    )

    const span = only()
    expect(exported(span)).not.toContain('hunter2')
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
    expect(span.events[0]?.attributes?.['exception.message']).toBeUndefined()
    expect(span.attributes[SPAN_ATTRIBUTES.code]).toBe('vault.unreadable')
  })

  test('a diagnostic failure keeps its message, since traces are allowed it', () => {
    withSpan(tracer, 'op', () => err(errors.create('db.unavailable', { message: 'ECONNRESET' })))
    expect(only().events[0]?.attributes?.['exception.message']).toBe('ECONNRESET')
  })
})

describe('errors that are not failures', () => {
  test('a bare Error from an unmapped tryCatch still produces a usable span', () => {
    withSpan(tracer, 'op', () => err(new Error('raw')))

    const span = only()
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
    expect(span.attributes[SPAN_ATTRIBUTES.code]).toBe('system.unexpected')
    expect(span.attributes[SPAN_ATTRIBUTES.kind]).toBe('internal')
  })
})

describe('tracing()', () => {
  test('binds the tracer so call sites only name the operation', async () => {
    const bound = tracing(tracer)
    expect(bound.withSpan('sync', () => ok(1))).toEqual(ok(1))
    expect(await bound.withSpanAsync('async', async () => ok(2))).toEqual(ok(2))
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(['sync', 'async'])
  })

  test('the async form records a rejection and ends the span', async () => {
    await expect(bindAndReject(tracing(tracer))).rejects.toThrow('async boom')

    const span = only()
    expect(span.ended).toBe(true)
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
  })

  test('the async form records a failure returned after an await', async () => {
    await tracing(tracer).withSpanAsync('op', async () => {
      await Promise.resolve()
      return err(errors.create('db.unavailable'))
    })
    expect(only().status.code).toBe(SpanStatusCode.ERROR)
  })
})

const bindAndReject = (bound: ReturnType<typeof tracing>): Promise<unknown> =>
  bound.withSpanAsync('op', async () => {
    throw new Error('async boom')
  })

describe('recordFailure on its own', () => {
  // The escape hatch for code that already holds a span and does not want the
  // wrapper to own the lifecycle.
  test('writes onto a span the caller owns', () => {
    const span = tracer.startSpan('manual')
    recordFailure(span, errors.create('db.unavailable'))
    span.end()
    expect(only().status.code).toBe(SpanStatusCode.ERROR)
  })
})
