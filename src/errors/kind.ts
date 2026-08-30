/**
 * The coarse, platform-neutral classification every failure carries.
 *
 * Eight values, deliberately. A kind is the low-cardinality axis — the one a
 * dashboard groups by, an alert rule switches on, and OpenTelemetry's
 * `error.type` attribute wants. The specific thing that went wrong is the
 * *code*, which is unbounded and namespaced and lives in a catalogue.
 *
 * The split matters because the two axes have opposite pressures: codes should
 * multiply freely as an app learns new failure modes, kinds must not, or every
 * consumer of a kind has to be revisited. Anything that would tempt you to add
 * a ninth kind is a code.
 */
export const ERROR_KINDS = [
  'input',
  'access',
  'state',
  'capacity',
  'availability',
  'lifecycle',
  'platform',
  'internal',
] as const

export type ErrorKind = (typeof ERROR_KINDS)[number]

/**
 * Whether repeating the *identical* operation could plausibly succeed.
 *
 * - `never` — the request is wrong or the answer is settled. A retry is a bug:
 *   it burns quota and produces the same failure.
 * - `backoff` — a transient fault. Retry with exponential backoff and jitter.
 * - `deferred` — retrying is pointless until something outside the process
 *   changes: a rate window resets, connectivity returns, the user grants a
 *   permission, the app updates, an invoice is paid. Wait for the signal, not
 *   for a timer.
 */
export type RetryPolicy = 'never' | 'backoff' | 'deferred'

/**
 * Who is responsible. This is the field an alerting rule wants: only `provider`
 * failures should burn an error budget or wake somebody. A flood of caller
 * faults is an integration problem, not an outage.
 *
 * It is also what decides whether a stack trace is worth its cost — see
 * {@link capturesStackByDefault}.
 */
export type ErrorFault = 'caller' | 'provider' | 'environment'

export interface KindDefaults {
  /**
   * The status a kind becomes at an HTTP seam when an entry does not say
   * otherwise. Necessarily approximate: `state` spans 404, 409, 410, and 412,
   * and only the code knows which. Catalogue entries override it, and the
   * built-in catalogue overrides it everywhere it matters.
   */
  readonly http: number | null
  readonly retry: RetryPolicy
  readonly fault: ErrorFault
  /** One line, developer-facing, describing what the kind claims. */
  readonly summary: string
}

/**
 * What an entry gets when it declares nothing but its kind.
 *
 * This is the whole reason `kind` is the only required field on a catalogue
 * entry: declaring `kind: 'availability'` already means 503, retry with
 * backoff, and page the provider — which is right often enough that overriding
 * is the exception.
 */
export const ERROR_KIND_DEFAULTS = {
  input: {
    http: 400,
    retry: 'never',
    fault: 'caller',
    summary: 'The payload is malformed, unsupported, oversized, or fails a semantic rule.',
  },
  access: {
    http: 403,
    retry: 'never',
    fault: 'caller',
    summary: 'Identity, authorisation, billing, or jurisdiction blocks the operation.',
  },
  state: {
    http: 409,
    retry: 'never',
    fault: 'caller',
    summary: 'Current state contradicts the request: missing, duplicated, stale, or removed.',
  },
  capacity: {
    http: 429,
    retry: 'deferred',
    fault: 'caller',
    summary: 'An allowance is used up — requests per second, seats, bytes, memory.',
  },
  availability: {
    http: 503,
    retry: 'backoff',
    fault: 'provider',
    summary: 'Something we depend on is down, slow, unreachable, or answering with garbage.',
  },
  lifecycle: {
    http: 499,
    retry: 'never',
    fault: 'caller',
    summary: 'The operation did not finish: abandoned by the caller or given up on mid-flight.',
  },
  platform: {
    http: 501,
    retry: 'deferred',
    fault: 'environment',
    summary: 'The device, OS, or runtime refused or cannot do this at all.',
  },
  internal: {
    http: 500,
    retry: 'backoff',
    fault: 'provider',
    summary: 'A bug, a bad deployment, or corrupt data. The default for anything unclassified.',
  },
} as const satisfies Record<ErrorKind, KindDefaults>

/**
 * The kind to fall back to whenever classification is impossible — a coerced
 * foreign throw, an unknown code, a payload from an older peer. It promises the
 * least about the failure and leaks the least about it.
 */
export const DEFAULT_ERROR_KIND: ErrorKind = 'internal'

export const isErrorKind = (value: unknown): value is ErrorKind =>
  typeof value === 'string' && Object.hasOwn(ERROR_KIND_DEFAULTS, value)

export const kindDefaultsFor = (kind: ErrorKind): KindDefaults => ERROR_KIND_DEFAULTS[kind]

/**
 * Whether a fault is worth the cost of a stack trace.
 *
 * Provider faults are bugs and outages: somebody will have to find them, and a
 * stack is the only thing that makes that possible. Caller and environment
 * faults are the system working as designed — a 404, a denied camera prompt —
 * and on V8 a captured stack costs roughly 200x a plain object. An entry can
 * always override with `captureStack`.
 */
export const capturesStackByDefault = (fault: ErrorFault): boolean => fault === 'provider'
