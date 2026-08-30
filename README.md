# @dx47/resulttype

Typed errors as values, for every runtime JavaScript ships to.

Failures you expect are plain objects that travel in a `Result`. Bugs you don't
expect are thrown. A catalogue decides — once, where an error is *defined* —
what each failure means, who is allowed to read it, and whether it is worth a
stack trace.

> **Status:** `0.0.0`. The API is not stable yet.

## Install

```sh
pnpm add @dx47/resulttype
```

No runtime dependencies. `@opentelemetry/api` is an optional peer, needed only
for `@dx47/resulttype/interop/otel`.

## Quick start

```ts
import { tryCatchAsync } from '@dx47/resulttype'
import { defineErrors, params } from '@dx47/resulttype/catalogue'

const errors = defineErrors({
  'db.unavailable': { kind: 'availability' },
  'user.not_found': {
    kind: 'state',
    http: 404,
    exposure: 'public',
    params: params<{ userId: string }>(),
  },
})

async function findUser(id: string) {
  // A seam *translates* a foreign throw into a code you named.
  const [rows, error] = await tryCatchAsync(
    () => db.query('select * from users where id = $1', [id]),
    errors.toErr('db.unavailable'),
  )
  if (error) return [undefined, error] as const
  if (rows.length === 0) return [undefined, errors.create('user.not_found', { userId: id })] as const
  return [rows[0], undefined] as const
}

const [user, error] = await findUser('u1')
if (error) {
  switch (error.code) {
    case 'user.not_found': return notFound()
    case 'db.unavailable': return retryLater()
  } // exhaustive — no `default`, and a new code breaks the build
}
```

## Two channels

TypeScript cannot express *"returns `E`, or panics"*. So if unexpected errors go
into `E`, every call site needs a `default` branch — which permanently disables
the exhaustiveness checking that is the whole reason to prefer `Result` over
exceptions. The split is forced by the type system, not chosen:

|                | Failure                            | Defect                          |
| -------------- | ---------------------------------- | ------------------------------- |
| what           | an expected, modelled outcome      | a bug                           |
| travels by     | being returned in a `Result`       | being thrown                    |
| shape          | plain frozen object                | `class extends Error`           |
| you choose it  | yes — a code from a catalogue      | **no**                          |
| stack trace    | only when the entry asks           | always                          |

You never decide which bucket to use. You pick a code from the catalogue and get
a `Failure`; you assert with `invariant()` and get a `Defect`; everything else
that throws — a `TypeError`, a driver rejection — is a defect because the runtime
made it one.

`toFailure(thrown)` normalises anything into a `Failure` at your one top-level
boundary: Express error middleware, a React error boundary,
`process.on('uncaughtException')`, `window.onerror`. It never throws, even on a
revoked proxy, and it is idempotent.

## Kind, code, and the metadata that rides along

`ErrorKind` is **eight** coarse values — `input`, `access`, `state`, `capacity`,
`availability`, `lifecycle`, `platform`, `internal`. Low cardinality on purpose:
this is what a dashboard groups by and what OpenTelemetry's `error.type` wants.
The *code* is the unbounded, namespaced part.

A kind implies the rest, so an entry only declares what differs:

```ts
'db.unavailable': { kind: 'availability' }
// → http 503, retry 'backoff', fault 'provider', exposure 'diagnostic', stack captured
```

- **`retry`** — `never` (the answer is settled), `backoff` (transient), or
  `deferred` (pointless until a rate window resets, connectivity returns, the
  user grants a permission, an invoice is paid).
- **`fault`** — `caller`, `provider`, or `environment`. This is what an alert
  rule wants: only `provider` failures should burn an error budget. A flood of
  `input.invalid` is an integration problem, not an outage.
- **`captureStack`** — defaults from `fault`, because provider faults are bugs
  and bugs need stacks, while a 404 is the system working correctly.

## Exposure

Who may read a failure's *developer-facing* detail — its `message`, `cause`
chain, and `stack`. Not the copy a user reads: that is localised from `code` and
typed `params`, and is safe because it was written to be shown.

Six rungs, each a strict superset of the one below:

| exposure     | adds                             |
| ------------ | -------------------------------- |
| `secret`     | *nothing* — code and kind only   |
| `restricted` | `logs`                           |
| `diagnostic` | `traces`, `crash_reports`        |
| `support`    | `support_console`                |
| `client`     | `client_response`                |
| `public`     | `end_user`                       |

`restricted` sits below `diagnostic` because traces and crash reports usually
land in a *third-party vendor's* storage. Detail that may sit in your own logs
under your own retention rules — personal data, health or financial records —
must not be shipped to Datadog or Sentry, and that is a rung, not a footnote.

`redact()` enforces it at each sink, once, rather than at every throw site:

```ts
import { redact } from '@dx47/resulttype/errors'

res.status(httpStatusFor(failure)).json(redact(failure, 'client_response'))
logger.error(redact(failure, 'logs'))
```

`code`, `kind`, `http`, `retry`, and `fault` always survive — they are a closed
vocabulary you chose, so they cannot leak anything unpublished. A client still
learns it should retry with backoff while learning nothing about which
dependency died.

## Catalogue

```ts
const errors = defineErrors({ /* ... */ })

errors.create('user.not_found', { userId: 'u1' })   // → Failure
errors.toErr('db.unavailable')                       // → (cause) => Failure, for tryCatch
errors.has('user.not_found')
```

Codes must be namespaced (`a.b`), or it does not compile. `mergeCatalogues()`
combines two, and **overlapping codes are a compile error** — one code must mean
one thing across a fleet, and a silent last-one-wins merge would let two teams
disagree without either finding out.

### Params

Three ways to declare the shape of a failure's params, all matched
*structurally*, so this package depends on no validator:

```ts
params: params<{ userId: string }>()      // types only, zero runtime
params: z.object({ userId: z.string() })  // any Standard Schema — Zod, Valibot, ArkType
params: Type.Object({ userId: Type.String() })  // TypeBox, if you want JSON Schema
```

### Built-in codes

33 generic codes across seven namespaces, so no repo has to type out the
universal ones: `input.*`, `auth.*`, `resource.*`, `limit.*`, `net.*`,
`device.*`, `system.*`. They are deliberately params-free — a fallback should be
callable with nothing to think about. `db.*`, `env.*`, and `ui.*` are left
unclaimed for your application.

```ts
import { defaultErrors, codeFromHttpStatus, mergeCatalogues } from '@dx47/resulttype/catalogue'

const errors = mergeCatalogues(defaultErrors, myErrors)
codeFromHttpStatus(429) // → 'limit.rate_limited'
```

## OpenTelemetry

```ts
import { tracing } from '@dx47/resulttype/interop/otel'

const { withSpanAsync } = tracing(trace.getTracer('billing'))

const [invoice, error] = await withSpanAsync('charge', () =>
  tryCatchAsync(() => stripe.charge(id), errors.toErr('billing.declined')),
)
```

The span is held in a closure, never read from ambient context — OTel's
propagation across `await` relies on AsyncLocalStorage, which exists in Node and
does not exist in a browser.

- Success leaves the status **UNSET**, not `OK`. The spec reserves `OK` for an
  outcome explicitly validated as successful.
- Only **provider faults** set `ERROR`. Calling `recordException` on a handled
  `resource.not_found` is the fastest way to make a trace useless.
- A thrown defect is recorded and **rethrown**, never converted to a `Result`.
- `error.type` gets the *kind*, per the low-cardinality semantic convention.
- Failures are `redact(failure, 'traces')`-ed before anything is read off them.

## Entry points

| import                              | contains                                                        |
| ----------------------------------- | --------------------------------------------------------------- |
| `@dx47/resulttype`                  | `Result`, `ok`, `err`, `isOk`, `isErr`, `unwrapOr`, `tryCatch`   |
| `@dx47/resulttype/errors`           | `Failure`, `Defect`, kinds, exposure, `redact`, `toFailure`      |
| `@dx47/resulttype/catalogue`        | `defineErrors`, `params`, `defaultErrors`, `mergeCatalogues`     |
| `@dx47/resulttype/interop/otel`     | `withSpan`, `tracing`, `recordFailure`                           |

A `Result` is a readonly tuple, so it destructures positionally and narrows on
`error !== undefined`:

```ts
type Ok<V>  = readonly [value: V, error: undefined]
type Err<E> = readonly [value: undefined, error: E]
```

## Why failures are not `Error`s

Measured on an M-series Mac; a microbenchmark, so treat the ratio as the durable
part and the absolute numbers as indicative:

|                                  | Node 26 (V8) | Bun 1.3 (JSC) |
| -------------------------------- | -----------: | ------------: |
| plain object literal             |       ~5 ns  |        ~9 ns  |
| `new Error(msg)`                 |    ~1,365 ns |      ~105 ns  |
| `new Error` + reading `.stack`   |    ~7,300 ns |      ~900 ns  |

The gap is categorical rather than constant-factor: a plain object can be
escape-analysed and scalar-replaced by the JIT, while an `Error` never can,
because stack capture is an opaque side-effecting call.

Three consequences beyond speed:

1. `JSON.stringify(new Error('x'))` is `{}`. A `Failure` survives
   `structuredClone`, `postMessage`, and the React Native bridge.
2. Nothing does an `instanceof`, so two copies of this package in one dependency
   tree cannot break failure detection. `isFailure()` is structural.
3. Structured stacks retain frame references, which retain the objects in those
   frames — a real leak vector for a retry queue holding failed jobs.

## License

MIT © Daniel Günther
