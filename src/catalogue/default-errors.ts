import { defineErrors } from '#catalogue/define-errors'
import { UNEXPECTED_CODE } from '#errors/index'

/**
 * The failures every application has, so that no consuming repo has to type
 * them out again.
 *
 * One generic code per situation, across seven reserved namespaces. They are
 * deliberately **params-free**: a fallback should be callable as
 * `create('resource.not_found')` with nothing else to think about. The moment a
 * failure deserves structured params — *which* resource, *which* limit — it
 * deserves a specific code in your own catalogue, and this one is what it falls
 * back to until then.
 *
 * `db.*`, `env.*`, and `ui.*` are left unclaimed on purpose. They are the
 * namespaces an application reaches for first, and a built-in catalogue that
 * squatted on them would collide with the code it is meant to support.
 *
 * Note how little most entries say. `kind` implies the status, the retry
 * policy, the fault, and therefore whether a stack is captured, so an entry only
 * speaks up where it differs — which is what keeps thirty-three of them
 * readable in one screen.
 */
export const defaultErrors = defineErrors({
  /* ------------------------- input: the request is wrong ------------------ */
  // `exposure: 'public'` throughout: a caller cannot fix a request they are not
  // allowed to be told is broken, and none of these reveal internal structure.

  'input.malformed': { kind: 'input', exposure: 'public' },
  'input.invalid': { kind: 'input', http: 422, exposure: 'public' },
  'input.unsupported_format': { kind: 'input', http: 415, exposure: 'public' },
  'input.too_large': { kind: 'input', http: 413, exposure: 'public' },

  /* ------------------- access: identity, policy, billing, law ------------- */

  'auth.unauthenticated': { kind: 'access', http: 401, exposure: 'public' },
  'auth.session_expired': {
    kind: 'access',
    http: 401,
    retry: 'deferred',
    exposure: 'public',
  },
  'auth.forbidden': { kind: 'access', exposure: 'public' },
  'auth.payment_required': {
    kind: 'access',
    http: 402,
    retry: 'deferred',
    exposure: 'public',
  },
  'auth.legally_restricted': {
    kind: 'access',
    http: 451,
    fault: 'environment',
    exposure: 'public',
  },

  /* -------------------- state: what exists and what does not -------------- */

  // `not_found` is public, but note that "does not exist" and "you may not know
  // whether it exists" are the same code on purpose: a distinct code for the
  // second is an enumeration oracle.
  'resource.not_found': { kind: 'state', http: 404, exposure: 'public' },
  'resource.already_exists': { kind: 'state', exposure: 'public' },
  'resource.conflict': { kind: 'state', exposure: 'public' },
  'resource.precondition_failed': {
    kind: 'state',
    http: 412,
    exposure: 'public',
  },
  'resource.gone': { kind: 'state', http: 410, exposure: 'public' },

  /* ------------------------ capacity: allowances spent -------------------- */

  'limit.rate_limited': { kind: 'capacity', exposure: 'public' },
  'limit.quota_exceeded': { kind: 'capacity', exposure: 'public' },
  // Ours, not the caller's: an allocation we could not serve. Overrides every
  // capacity default because the blame runs the other way.
  'limit.out_of_memory': {
    kind: 'capacity',
    http: 503,
    retry: 'backoff',
    fault: 'provider',
  },
  // Theirs, and not fixable by waiting: disk, IndexedDB budget, device storage.
  'limit.storage_full': {
    kind: 'capacity',
    http: 507,
    fault: 'environment',
    exposure: 'client',
  },

  /* ------------------- availability: reaching other systems --------------- */

  // Diagnostic, not public: which dependency died, and why, is a map of the
  // internal topology. The caller still learns `retry: 'backoff'` and a 503 —
  // `redact` keeps code, kind, http, retry, and fault at every exposure.
  'net.timeout': { kind: 'availability', http: 504 },
  'net.unavailable': { kind: 'availability' },
  'net.upstream_failure': { kind: 'availability', http: 502 },
  // Transport never completed: DNS, TLS, connection refused or reset. On a
  // client there is no status; the 502 is what a server reports when its own
  // outbound call failed this way.
  'net.unreachable': {
    kind: 'availability',
    http: 502,
    fault: 'environment',
    exposure: 'client',
  },
  // Only a client can observe this, so it has no honest status at all.
  'net.offline': {
    kind: 'availability',
    http: null,
    retry: 'deferred',
    fault: 'environment',
    exposure: 'client',
  },

  /* --------------------- platform: the device and the OS ------------------ */

  // Camera, location, notifications, clipboard, filesystem, keychain.
  'device.permission_denied': {
    kind: 'platform',
    http: null,
    exposure: 'client',
  },
  // Missing API, absent hardware, unsupported OS version. Waiting will not help.
  'device.unsupported': {
    kind: 'platform',
    retry: 'never',
    exposure: 'client',
  },
  // Hardware present but failing: a camera already in use, a sensor fault, a
  // rejected print job.
  'device.failure': {
    kind: 'platform',
    http: null,
    retry: 'backoff',
    exposure: 'client',
  },

  /* ---------------------- internal and lifecycle: ours -------------------- */

  // What every unmodelled throw normalises to. Its resolved shape must match
  // `UNEXPECTED_DEFAULTS`, which the boundary uses when no catalogue is
  // reachable; the `internal` kind's defaults are exactly those values, which is
  // why this entry needs to say nothing else. A test asserts the two agree.
  [UNEXPECTED_CODE]: { kind: 'internal' },
  'system.not_implemented': { kind: 'internal', http: 501, retry: 'never' },
  'system.misconfigured': { kind: 'internal', retry: 'never' },
  'system.data_loss': { kind: 'internal', retry: 'never' },
  // The client is too old to talk to us. Their fault in the sense that they
  // must act, and public because the required action is theirs to take.
  'system.version_mismatch': {
    kind: 'platform',
    http: 426,
    fault: 'caller',
    exposure: 'public',
  },
  // The caller walked away: an AbortSignal, a closed tab, a backgrounded app.
  // 499 is nginx's non-standard code; nobody is left to receive it, so it exists
  // for the logs.
  'system.cancelled': { kind: 'lifecycle' },
  // We gave up mid-flight: a serialisation failure, a deadlock victim, a lost
  // lease. Unlike a conflict, retrying is the correct response.
  'system.aborted': {
    kind: 'lifecycle',
    http: 409,
    retry: 'backoff',
    fault: 'provider',
  },
})

export type DefaultErrorCode = keyof typeof defaultErrors.entries

/**
 * The built-in code an incoming HTTP status means.
 *
 * Written out rather than inverted from the entries, because the forward map is
 * many-to-one: 409 is `already_exists`, `conflict`, and `aborted`; 401 is
 * `unauthenticated` and `session_expired`. Only one of each group can be the
 * answer when all a client has is a number, and picking the most common and
 * least presumptuous member is a judgement a reversal cannot make.
 */
const CODE_BY_STATUS: Readonly<Record<number, DefaultErrorCode>> = {
  400: 'input.malformed',
  401: 'auth.unauthenticated',
  402: 'auth.payment_required',
  403: 'auth.forbidden',
  404: 'resource.not_found',
  405: 'input.malformed',
  406: 'input.unsupported_format',
  408: 'net.timeout',
  409: 'resource.conflict',
  410: 'resource.gone',
  412: 'resource.precondition_failed',
  413: 'input.too_large',
  414: 'input.too_large',
  415: 'input.unsupported_format',
  416: 'input.malformed',
  422: 'input.invalid',
  423: 'resource.conflict',
  424: 'net.upstream_failure',
  426: 'system.version_mismatch',
  428: 'resource.precondition_failed',
  429: 'limit.rate_limited',
  431: 'input.too_large',
  451: 'auth.legally_restricted',
  499: 'system.cancelled',
  500: UNEXPECTED_CODE,
  501: 'system.not_implemented',
  502: 'net.upstream_failure',
  503: 'net.unavailable',
  504: 'net.timeout',
  505: 'system.version_mismatch',
  507: 'limit.storage_full',
  508: 'system.aborted',
}

/**
 * Classifies a status a peer sent us — the inbound half of an HTTP seam.
 *
 * Unlisted 4xx collapse to `input.malformed` and unlisted 5xx to
 * `system.unexpected`, which is what "they say it is our fault / their fault"
 * reduces to when the specific code means nothing to us.
 */
export const codeFromHttpStatus = (status: number): DefaultErrorCode => {
  const exact = CODE_BY_STATUS[status]
  if (exact !== undefined) return exact
  if (status >= 400 && status < 500) return 'input.malformed'
  return UNEXPECTED_CODE
}
