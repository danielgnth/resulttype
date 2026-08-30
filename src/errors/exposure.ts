/**
 * Who is allowed to read a failure's developer-facing detail.
 *
 * It does **not** govern the copy a user reads: that is localised from the
 * failure's `code` and typed `params`, and is safe by construction because it
 * was written to be shown. Exposure governs the *unbounded* text — the
 * `message`, the `cause` chain, the stack — which was written by a developer,
 * or by a database driver, or by whatever threw three layers down, and has
 * never been reviewed for what it might contain.
 */

/**
 * A place a failure's detail can end up, ordered from the sinks nearest the
 * operator to the ones nearest the public.
 *
 * - `logs` — the operator's own log sink, in their own infrastructure.
 * - `traces` — OTel spans, APM, RUM. Usually a third-party vendor's storage.
 * - `crash_reports` — Sentry, Crashlytics, the OS crash reporter. Third party,
 *   and on mobile and desktop the payload leaves the device to get there.
 * - `support_console` — an internal admin or support tool, read by staff who
 *   are not the on-call engineers and may be contractors.
 * - `client_response` — serialised into a response body or push payload for a
 *   first-party app or an authenticated API consumer. It reaches a device the
 *   operator does not control, where a debug panel or a proxy can read it.
 * - `end_user` — rendered verbatim to whoever is looking at the screen. Anyone
 *   can be that person, including an attacker probing for a message that
 *   distinguishes "no such account" from "wrong password".
 */
export const EXPOSURE_CHANNELS = [
  'logs',
  'traces',
  'crash_reports',
  'support_console',
  'client_response',
  'end_user',
] as const

export type ExposureChannel = (typeof EXPOSURE_CHANNELS)[number]

export interface ExposureMeta {
  /**
   * Position on the ladder. Higher is more open, and every level admits every
   * channel the level below admits — which is what makes comparing two
   * exposures meaningful at all.
   */
  readonly rank: number
  readonly channels: readonly ExposureChannel[]
  readonly summary: string
}

/**
 * The audience ladder. Each level is a strict superset of the one before, so a
 * catalogue entry names the single most open audience it is safe for and every
 * narrower sink follows.
 *
 * A ladder rather than independent per-channel flags, because the question a
 * serialisation seam asks is `is this safe for *here*`, and a partial order
 * answers it in one comparison. Flags would let an entry claim it is safe for
 * end users but not for logs, which is not a thing.
 */
export const EXPOSURE_META = {
  secret: {
    rank: 0,
    channels: [],
    summary:
      'The detail never materialises anywhere, not even in a local log line. For failures whose text is itself the sensitive thing: a key that failed to parse, a connection string, a decrypted payload, a token comparison. Only the closed vocabulary survives — code, kind, http, retry, fault.',
  },
  restricted: {
    rank: 1,
    channels: ['logs'],
    summary:
      'First-party log storage only, and pointedly not the third-party telemetry vendors. For detail that is fine under the operator’s own retention and access rules but must not be shipped elsewhere: personal data, health or financial records, anything carrying a data-residency or deletion obligation.',
  },
  diagnostic: {
    rank: 2,
    channels: ['logs', 'traces', 'crash_reports'],
    summary:
      'All operator telemetry, and nothing a human reads outside engineering. The right answer for an ordinary bug — a stack trace, a driver message, a failed invariant — and the default, because it is the least that still lets the failure be debugged.',
  },
  support: {
    rank: 3,
    channels: ['logs', 'traces', 'crash_reports', 'support_console'],
    summary:
      'Also readable in an internal admin or support tool. For detail that lets an agent resolve a ticket without escalating — which record conflicted, which limit was hit — and stays harmless in the hands of staff who are not engineers.',
  },
  client: {
    rank: 4,
    channels: ['logs', 'traces', 'crash_reports', 'support_console', 'client_response'],
    summary:
      'Also serialised to a first-party client or an authenticated API consumer, for a diagnostics screen, an integrator’s log, or a developer console. Safe to leave a device the operator does not control, but not yet safe to put in front of a human unedited.',
  },
  public: {
    rank: 5,
    channels: ['logs', 'traces', 'crash_reports', 'support_console', 'client_response', 'end_user'],
    summary:
      'Safe for anyone, including an unauthenticated caller and an attacker. Reveals nothing about internal structure and nothing a probe could use to enumerate what exists.',
  },
} as const satisfies Record<string, ExposureMeta>

export type Exposure = keyof typeof EXPOSURE_META

export const EXPOSURES = Object.keys(EXPOSURE_META) as readonly Exposure[]

/**
 * What a failure is worth when nobody has decided. `diagnostic`, not `secret`:
 * an unclassified failure is far more often an ordinary bug somebody has to
 * debug than a secret, and a default that hides stack traces from the team is a
 * default people work around.
 */
export const DEFAULT_EXPOSURE: Exposure = 'diagnostic'

export const isExposure = (value: unknown): value is Exposure =>
  typeof value === 'string' && Object.hasOwn(EXPOSURE_META, value)

export const exposureMetaFor = (exposure: Exposure): ExposureMeta => EXPOSURE_META[exposure]

/** The one question a serialisation seam actually asks. */
export const canExpose = (exposure: Exposure, channel: ExposureChannel): boolean =>
  (EXPOSURE_META[exposure].channels as readonly ExposureChannel[]).includes(channel)

/** True when the detail must be dropped outright rather than withheld from one sink. */
export const isRedacted = (exposure: Exposure): boolean => exposure === 'secret'

/**
 * Whether `a` is at least as open as `b` — the comparison a policy check wants
 * when a route declares a minimum, or an aggregate takes the strictest of its
 * parts.
 */
export const isAtLeastAsOpenAs = (a: Exposure, b: Exposure): boolean =>
  EXPOSURE_META[a].rank >= EXPOSURE_META[b].rank

/**
 * The narrower of two exposures. A failure that adopts another as its cause can
 * never be more open than what it wraps, and an aggregate is only as open as
 * its most sensitive member.
 */
export const narrowestExposure = (a: Exposure, b: Exposure): Exposure =>
  EXPOSURE_META[a].rank <= EXPOSURE_META[b].rank ? a : b
