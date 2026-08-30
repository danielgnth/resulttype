import type { ParamsOf, ParamsSpec } from '#catalogue/params'
import {
  capturesStackByDefault,
  DEFAULT_EXPOSURE,
  type ErrorFault,
  type ErrorKind,
  type Exposure,
  type Failure,
  type Issue,
  kindDefaultsFor,
  type RetryPolicy,
} from '#errors/index'

/**
 * One row of an error catalogue: everything about a failure that is decided
 * where it is *defined* rather than where it is thrown.
 *
 * Only `kind` is required. Everything else falls back to that kind's defaults
 * (see `ERROR_KIND_DEFAULTS`), which is what keeps a catalogue readable at
 * thirty entries — `{ kind: 'availability' }` already means 503, retry with
 * backoff, and blame the provider.
 *
 * `message` is developer-facing only, and governed by `exposure`. User-facing
 * copy is localised from the code plus the typed `params`, which is what makes
 * a German-language app possible at all — a hardcoded English string here would
 * otherwise be the only text a user ever sees.
 */
export interface ErrorDefinition {
  /** The only required field. Everything below defaults from it. */
  readonly kind: ErrorKind
  /** Defaults to `diagnostic`: visible to operator telemetry, to nobody else. */
  readonly exposure?: Exposure
  /** `null` for a failure that can only happen inside a client. */
  readonly http?: number | null
  readonly retry?: RetryPolicy
  readonly fault?: ErrorFault
  /** Defaults from `fault` — provider faults are bugs, and bugs need stacks. */
  readonly captureStack?: boolean
  readonly message?: string
  /** The team or package that owns this code, for routing and for OpenAPI. */
  readonly owner?: string
  readonly params?: ParamsSpec
}

/**
 * A dot-namespaced error code.
 *
 * This package reserves `system.*`, `input.*`, `auth.*`, `resource.*`,
 * `limit.*`, `net.*`, and `device.*` for its built-in catalogue, and leaves
 * `db.*`, `env.*`, and `ui.*` unclaimed for the app layer. The namespace is not
 * decoration: the code is simultaneously the discriminant, the i18n key, and
 * the OpenAPI error key, and all three are shared across every package that
 * merges a catalogue.
 */
export type ErrorCode = `${string}.${string}`

export type CatalogueEntries = Readonly<Record<string, ErrorDefinition>>

/**
 * The type an un-namespaced key collapses to. A pattern index signature —
 * ``Record<`${string}.${string}`, ErrorDefinition>`` — looks like it would do
 * this job and does not: a key that fails the pattern is simply not covered by
 * the signature, so it passes. Mapping over the keys and replacing the *value*
 * type for the offending one is what turns it into an error, and the property
 * name carries the explanation.
 */
interface ErrorCodeMustBeNamespaced<TCode> {
  readonly __errorCodeMustContainADot: TCode
}

type ValidatedEntries<TEntries> = {
  [TCode in keyof TEntries]: TCode extends ErrorCode
    ? ErrorDefinition
    : ErrorCodeMustBeNamespaced<TCode>
}

/** The per-call half of a failure: the part a catalogue cannot know in advance. */
export interface CreateContext {
  /** Overrides the entry's developer-facing message. */
  readonly message?: string
  readonly cause?: unknown
  /** Field-level detail, when one failure has more than one cause. */
  readonly issues?: readonly Issue[]
}

/**
 * The arguments `create` takes after the code: the params the entry's spec
 * describes, when it declares one, and nothing but the optional context when it
 * does not. This is what makes `create('net.unavailable')` legal while
 * `create('resource.not_found')` is a compile error.
 */
type CreateArgs<TEntry> = TEntry extends { readonly params: infer TSpec extends ParamsSpec }
  ? [params: ParamsOf<TSpec>, context?: CreateContext]
  : [context?: CreateContext]

export interface ErrorCatalogue<TEntries extends CatalogueEntries> {
  /** The declarations themselves — the source an OpenAPI generator reads. */
  readonly entries: TEntries

  /** Builds a {@link Failure}, resolving every unset field from the entry's kind. */
  create<TCode extends keyof TEntries & string>(
    code: TCode,
    ...args: CreateArgs<TEntries[TCode]>
  ): Failure<TCode>

  /**
   * `create`, curried on the cause — the mapper `tryCatch` wants at a seam.
   *
   * ```ts
   * const [rows, error] = await tryCatchAsync(
   *   () => db.query(sql),
   *   errors.toErr('db.unavailable'),
   * )
   * ```
   *
   * This is the shape that keeps a seam *translating* rather than widening: the
   * developer says what a foreign throw means in the domain's vocabulary, and
   * the error type stays narrow enough to switch on exhaustively.
   */
  toErr<TCode extends keyof TEntries & string>(
    code: TCode,
    ...args: CreateArgs<TEntries[TCode]>
  ): (cause: unknown) => Failure<TCode>

  has(code: string): boolean
}

/**
 * Declares a set of errors: code, kind, exposure, and params spec together,
 * once, where the error is defined.
 *
 * ```ts
 * const errors = defineErrors({
 *   'user.not_found': {
 *     kind: 'state',
 *     http: 404,
 *     exposure: 'public',
 *     params: params<{ userId: string }>(),
 *   },
 * })
 *
 * const failure = errors.create('user.not_found', { userId: 'u1' })
 * ```
 *
 * The keys are constrained to `${string}.${string}`, so a code that forgets its
 * namespace does not compile.
 */
export function defineErrors<TEntries extends CatalogueEntries>(
  entries: TEntries & ValidatedEntries<TEntries>,
): ErrorCatalogue<TEntries> {
  return createCatalogue(entries)
}

// The unvalidated builder. `defineErrors` is this plus the key check, which
// `mergeCatalogues` must not run again: `ValidatedEntries` maps over `keyof`,
// and `keyof (TA & TB)` is not something either side's already-checked keys can
// be proven to satisfy a second time.
function createCatalogue<TEntries extends CatalogueEntries>(
  entries: TEntries,
): ErrorCatalogue<TEntries> {
  const build = (code: string, args: readonly unknown[], cause?: unknown): Failure => {
    const entry: ErrorDefinition | undefined = (entries as CatalogueEntries)[code]

    // An assertion, not a failure. `code` is constrained to `keyof TEntries`, so
    // reaching this needs a cast that defeats the type system — a bug in the
    // caller, not something a program recovers from, which is why it is not a
    // Result. A plain `Error` rather than a Defect: this module is below the
    // boundary that would normalise one.
    if (entry === undefined) throw new Error(`Unknown error code: ${code}`)

    // The params slot only exists in the argument list when the entry declares a
    // spec, so which of the two arguments is the context depends on the entry —
    // the same branch `CreateArgs` makes at the type level. Neither tuple shape
    // admits indexing at both positions; the pair is what the two together hold.
    const positional = args as [unknown?, unknown?]
    const takesParams = entry.params !== undefined
    const params = takesParams
      ? (positional[0] as Readonly<Record<string, unknown>> | undefined)
      : undefined
    const context = (takesParams ? positional[1] : positional[0]) as CreateContext | undefined

    const defaults = kindDefaultsFor(entry.kind)
    const fault = entry.fault ?? defaults.fault
    const wantsStack = entry.captureStack ?? capturesStackByDefault(fault)
    // `??` would be wrong here: `http: null` is a meaningful declaration — "this
    // can only happen on a client" — and must not be replaced by the default.
    const http = entry.http !== undefined ? entry.http : defaults.http
    const resolvedCause = cause !== undefined ? cause : context?.cause

    return {
      code,
      kind: entry.kind,
      http,
      retry: entry.retry ?? defaults.retry,
      fault,
      exposure: entry.exposure ?? DEFAULT_EXPOSURE,
      // Priority is deliberate. An explicit per-call message wins; then the
      // entry's, because a catalogue author who wrote one meant it; then the
      // cause's, because at a seam the foreign text *is* the diagnostic and
      // burying it in `cause` where no log formatter looks is how a seam loses
      // the only detail that identifies the outage. The code is the last resort,
      // and it is already on the failure as `code`.
      message: context?.message ?? entry.message ?? messageOf(resolvedCause) ?? code,
      // Spread-if-present rather than always assigning: an own key that reads as
      // undefined still serialises, still shows in a log, and still makes
      // `'stack' in failure` true. Absent means absent.
      ...(params === undefined ? {} : { params }),
      ...(context?.issues === undefined ? {} : { issues: context.issues }),
      ...(resolvedCause === undefined ? {} : { cause: resolvedCause }),
      ...(wantsStack ? { stack: captureStack() } : {}),
    }
  }

  return {
    entries,

    create(code, ...args) {
      return build(code, args) as Failure<typeof code>
    },

    toErr(code, ...args) {
      return (cause: unknown) => build(code, args, cause) as Failure<typeof code>
    },

    has(code) {
      return Object.hasOwn(entries, code)
    },
  }
}

/**
 * The portable stack capture: `Error.captureStackTrace` is V8-only, and this
 * package targets browsers, Bun, and React Native as well.
 *
 * The top frames belong to this module rather than to the caller. They are left
 * in deliberately — trimming them means guessing at a stack format that differs
 * between V8, JSC, and Hermes, and a wrong guess silently eats the frame that
 * actually mattered.
 */
const captureStack = (): string | undefined => new Error('stack capture').stack

/**
 * The message of a cause, when it has a usable one. Guarded because a cause is
 * whatever was thrown, and reading a property off it is not guaranteed to be
 * safe — see `toFailure` for the same reasoning at the boundary.
 */
const messageOf = (cause: unknown): string | undefined => {
  if (!(cause instanceof Error)) return undefined
  try {
    return cause.message === '' ? undefined : cause.message
  } catch {
    return undefined
  }
}

/**
 * The type a duplicated code collapses to. Deliberately a shape no catalogue
 * can satisfy, with the property name as the error message: TypeScript reports
 * the missing property, which reads better than the `never` a bare
 * `keyof A & keyof B extends never` check produces.
 */
interface DuplicateErrorCodes<TShared> {
  readonly __duplicateErrorCodes: TShared
}

/**
 * Combines two catalogues. Overlapping codes are a **compile error** — one code
 * must mean one thing across the whole fleet, and a silent last-one-wins merge
 * would let two teams disagree about what `db.unavailable` is without either
 * finding out.
 *
 * The check rides on an intersection rather than a conditional parameter type
 * so that `TB` still has a plain `ErrorCatalogue<TB>` position to be inferred
 * from; a naked conditional there infers nothing.
 */
export function mergeCatalogues<TA extends CatalogueEntries, TB extends CatalogueEntries>(
  a: ErrorCatalogue<TA>,
  b: ErrorCatalogue<TB> &
    (keyof TA & keyof TB extends never ? unknown : DuplicateErrorCodes<keyof TA & keyof TB>),
): ErrorCatalogue<TA & TB> {
  return createCatalogue({ ...a.entries, ...b.entries }) as ErrorCatalogue<TA & TB>
}
