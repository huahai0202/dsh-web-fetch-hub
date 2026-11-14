/**
 * Pure data mapping for the Exa fetch provider: no network, no Cordis, no
 * package imports, so every rule below is unit-testable on its own. The
 * provider supplies an error factory so a mapping failure becomes the seam's
 * `WebError` with its machine-readable code, while this module stays free of
 * runtime dependencies.
 * @module dsh-web-fetch-exa/mapping
 */

/** Default Exa API origin; `/contents` is the operation. */
export const EXA_DEFAULT_BASE_URL = 'https://api.exa.ai'

/** Default character budget requested from Exa per page. */
export const EXA_DEFAULT_MAX_CHARACTERS = 100000

/** Upper bound Exa accepts for `text.maxCharacters`. */
export const EXA_MAX_MAX_CHARACTERS = 5000000

/** Whole-fetch deadline, below the default 30s tool-call budget. */
export const EXA_DEFAULT_TIMEOUT_MS = 25000

/** Verbosity values Exa accepts for `text.verbosity`. */
export const VERBOSITIES = ['compact', 'standard', 'full']

/** Default number of attempts for one fetch, including the first one. */
export const EXA_DEFAULT_MAX_ATTEMPTS = 3

/** Longest single wait the provider will sit through, in milliseconds. */
export const EXA_MAX_RETRY_WAIT_MS = 12000

/** Request-level transient statuses; target statuses are handled separately. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504])

/** Whether a failed attempt may be repeated; 401/402/403 never are. */
export function isRetryableStatus(status) {
  return RETRYABLE_STATUSES.has(status)
}

/** Preserve API status and its error tag without depending on a readable body. */
export function describeApiFailure(status, payload) {
  const message = 'Exa Contents API error (HTTP ' + status + ')'
  const detail = typeof payload?.error === 'string' ? ': ' + payload.error : ''
  const tag = typeof payload?.tag === 'string' ? ' [' + payload.tag + ']' : ''
  return message + detail + tag
}

/**
 * How long to wait before the next attempt. Honor the Retry-After header when
 * present; otherwise double the wait per attempt: 1s, 2s, 4s. A wait beyond
 * {@link EXA_MAX_RETRY_WAIT_MS} ends the retries.
 *
 * @param _payload - the parsed error body; unused, no body hint is supported.
 * @param retryAfter - the parsed Retry-After header in milliseconds.
 * @param attempt - the 1-based attempt that just failed.
 * @returns the wait in milliseconds, or undefined when retrying is pointless.
 */
export function retryDelayMs(_payload, attempt, retryAfter) {
  if (retryAfter !== undefined) return retryAfter > EXA_MAX_RETRY_WAIT_MS ? undefined : retryAfter
  const backoff = 1000 * 2 ** (attempt - 1)
  return backoff > EXA_MAX_RETRY_WAIT_MS ? undefined : backoff
}

/**
 * Whether a retry may still run inside the fetch's own deadline.
 *
 * `timeoutMs` covers the WHOLE fetch, not one attempt, so a wait must fit in what
 * is LEFT *and* leave room for the attempt that follows it. Sleeping until only a
 * sliver remains is worse than failing now: the next request starts, the deadline
 * fires immediately, and the caller sees a timeout instead of the provider's real
 * reason. The previous attempt's own duration is the only available estimate of
 * how long the next one needs.
 *
 * @param waitMs - the wait `retryDelayMs` chose.
 * @param timeoutMs - the fetch's total budget.
 * @param elapsedMs - time already spent on this fetch.
 * @param lastAttemptMs - how long the attempt that just failed took.
 * @returns whether the wait plus another attempt fits in the remaining budget.
 */
export function retryFitsDeadline(waitMs, timeoutMs, elapsedMs, lastAttemptMs = 0) {
  return waitMs + lastAttemptMs < timeoutMs - elapsedMs
}


/** Config fields accepted by this provider; unknown fields fail at mount. */
const CONFIG_FIELDS = new Set(['apiKey', 'baseURL', 'timeoutMs', 'maxAttempts', 'maxResponseBytes', 'maxCharacters', 'verbosity', 'maxAgeHours', 'livecrawlTimeoutMs', 'linkStyle', 'includeSections', 'excludeSections'])

/** Reject malformed rows and literal keys before the first credential resolution. */
function validateConfig(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('web-fetch-exa: config must be an object')
  }
  for (const field of Object.keys(config)) {
    if (!CONFIG_FIELDS.has(field)) throw new Error('web-fetch-exa: unknown config.' + field)
    if (config[field] === null) throw new Error('web-fetch-exa: config.' + field + ' must not be null')
  }
  if (config.apiKey !== undefined && (typeof config.apiKey !== 'string' || /[\r\n]/.test(config.apiKey))) {
    throw new Error('web-fetch-exa: config.apiKey must be a string without line breaks')
  }
}

/** Absolute HTTP(S) endpoint, without credentials, query, or fragment. */
export function isValidBaseUrl(baseURL) {
  if (typeof baseURL !== 'string' || !URL.canParse(baseURL)) return false
  const parsed = new URL(baseURL)
  return ['https:', 'http:'].includes(parsed.protocol)
    && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
}

/** True for a positive whole number. */
export function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

/**
 * Validate one row's config and fill its defaults. Every rejection names the
 * field, so a mistyped row fails loudly instead of silently ignoring a value.
 *
 * @param apiKey - the key from the row, or the launch environment fallback.
 * @param config - the row config; every field is optional.
 * @returns the resolved provider options.
 * @throws Error naming the offending field.
 */
export function resolveOptions(apiKey, config = {}) {
  validateConfig(config)
  if (typeof apiKey !== 'string' || /[\r\n]/.test(apiKey)) throw new Error('web-fetch-exa: config.apiKey must be a string without line breaks')
  apiKey = apiKey.trim()

  let baseURL = config.baseURL ?? EXA_DEFAULT_BASE_URL
  if (!isValidBaseUrl(baseURL)) throw new Error('web-fetch-exa: config.baseURL must be an HTTP(S) URL without credentials, query, or fragment')
  baseURL = new URL(baseURL).toString().replace(/\/+$/, '')

  const maxCharacters = config.maxCharacters ?? EXA_DEFAULT_MAX_CHARACTERS
  if (!isPositiveInteger(maxCharacters) || maxCharacters > EXA_MAX_MAX_CHARACTERS) {
    throw new Error(`web-fetch-exa: config.maxCharacters must be a positive whole number no greater than ${EXA_MAX_MAX_CHARACTERS}`)
  }

  const verbosity = config.verbosity ?? 'standard'
  if (!VERBOSITIES.includes(verbosity)) {
    throw new Error(`web-fetch-exa: config.verbosity must be one of ${VERBOSITIES.join(', ')}`)
  }

  const timeoutMs = config.timeoutMs ?? EXA_DEFAULT_TIMEOUT_MS
  if (!isPositiveInteger(timeoutMs) || timeoutMs > 2147483647) throw new Error('web-fetch-exa: config.timeoutMs must be a positive whole number no greater than 2147483647')

  const maxResponseBytes = config.maxResponseBytes ?? 8388608
  if (!isPositiveInteger(maxResponseBytes) || maxResponseBytes > 67108864) {
    throw new Error('web-fetch-exa: config.maxResponseBytes must be a positive whole number no greater than 67108864')
  }

  const maxAttempts = config.maxAttempts ?? EXA_DEFAULT_MAX_ATTEMPTS
  if (!isPositiveInteger(maxAttempts) || maxAttempts > 5) {
    throw new Error('web-fetch-exa: config.maxAttempts must be a positive whole number no greater than 5')
  }

  // Omitted `maxAgeHours` lets Exa serve a cached copy when it has one and fetch
  // otherwise; 0 forces a live fetch, -1 forbids one.
  const maxAgeHours = config.maxAgeHours
  if (maxAgeHours !== undefined && !(Number.isSafeInteger(maxAgeHours) && maxAgeHours >= -1 && maxAgeHours <= 720)) {
    throw new Error('web-fetch-exa: config.maxAgeHours must be a whole number from -1 to 720')
  }

  const livecrawlTimeoutMs = config.livecrawlTimeoutMs ?? 10000
  if (!isPositiveInteger(livecrawlTimeoutMs) || livecrawlTimeoutMs > 90000) {
    throw new Error('web-fetch-exa: config.livecrawlTimeoutMs must be a positive whole number no greater than 90000')
  }
  const linkStyle = config.linkStyle ?? 'full'
  if (!['full', 'citation'].includes(linkStyle)) {
    throw new Error('web-fetch-exa: config.linkStyle must be full or citation')
  }
  const sections = {}
  for (const field of ['includeSections', 'excludeSections']) {
    const value = config[field]
    if (value !== undefined) {
      if (!Array.isArray(value) || value.length === 0 || !Array.from(value).every(item =>
        ['header', 'navigation', 'banner', 'body', 'sidebar', 'footer', 'metadata'].includes(item))) {
        throw new Error('web-fetch-exa: config.' + field + ' must be a non-empty list of semantic section names')
      }
      sections[field] = [...value]
    }
  }
  return { apiKey, baseURL, maxCharacters, verbosity, timeoutMs, maxAttempts, maxResponseBytes,
    livecrawlTimeoutMs, linkStyle, ...sections, ...maxAgeHours === undefined ? {} : { maxAgeHours } }

}

/** One entry of Exa's `statuses[]`, matching the requested URL when possible. */
export function statusFor(payload, url) {
  const statuses = Array.isArray(payload?.statuses) ? payload.statuses : []
  return statuses.find(entry => entry?.id === url) ?? (statuses.length === 1 ? statuses[0] : undefined)
}

/**
 * Per-URL failures Exa reports inside an HTTP 200 that are worth another attempt.
 *
 * Two independent signals say "try again": a tag naming a transient crawl outcome,
 * and an upstream HTTP status that is itself transient (a target that answered 503
 * or 429). A tag is never retryable merely because it is unfamiliar — that is how
 * `UNSUPPORTED_URL`, `CRAWL_NOT_FOUND`, and `INVALID_URL` stay final, since an
 * unusable or missing address does not change between attempts and retrying it only
 * spends the fetch's deadline.
 */
const TRANSIENT_CRAWL_TAGS = new Set(['CRAWL_TIMEOUT', 'CRAWL_UNKNOWN_ERROR'])

/** Transient per-URL failures can arrive inside an HTTP 200 API response. */
export function isRetryableContentsStatus(status) {
  if (status?.status !== 'error') return false
  if (TRANSIENT_CRAWL_TAGS.has(status.error?.tag)) return true
  return isRetryableStatus(status.error?.httpStatusCode)
}

/** Build the Contents request independently of transport. */
export function contentsRequestBody(url, options, remainingMs = options.timeoutMs) {
  return {
    urls: [url],
    text: {
      maxCharacters: options.maxCharacters,
      verbosity: options.verbosity,
      linkStyle: options.linkStyle,
      ...options.includeSections === undefined ? {} : { includeSections: options.includeSections },
      ...options.excludeSections === undefined ? {} : { excludeSections: options.excludeSections },
    },
    livecrawlTimeout: Math.max(1, Math.min(options.livecrawlTimeoutMs, Math.floor(remainingMs - 500))),
    ...options.maxAgeHours === undefined ? {} : { maxAgeHours: options.maxAgeHours },
  }
}

/** Describe one failed per-URL status, keeping Exa's machine-readable tag. */
export function describeStatusError(url, status) {
  const tag = status?.error?.tag
  const upstream = status?.error?.httpStatusCode
  const detail = [
    typeof tag === 'string' ? tag : 'unknown error',
    ...typeof upstream === 'number' ? [`HTTP ${upstream}`] : [],
  ].join(', ')
  return `Exa could not retrieve ${url}: ${detail}`
}

/**
 * Pick the readable body of one result. `text` is what this provider requests;
 * `summary` and `highlights` are fallbacks for pages Exa flattened differently,
 * so an extractable page never fails only because `text` came back empty.
 */
export function readableText(page) {
  if (typeof page?.text === 'string' && page.text.trim().length > 0) return page.text
  if (typeof page?.summary === 'string' && page.summary.trim().length > 0) return page.summary
  const highlights = Array.isArray(page?.highlights) ? page.highlights : []
  return highlights.filter(item => typeof item === 'string' && item.trim().length > 0).join('\n\n')
}

/**
 * Map an Exa Contents response to the seam's fetch result.
 *
 * @param payload - the parsed `POST /contents` body.
 * @param requestUrl - the URL the operator asked for.
 * @param maxCharacters - the configured per-page character budget.
 * @param makeError - builds the seam error from a message and a machine-readable code.
 * @returns the normalized fetch result.
 * @throws the factory's error when Exa reports a failure or no readable body.
 */
export function mapContentsResponse(payload, requestUrl, maxCharacters, makeError) {
  const status = statusFor(payload, requestUrl)
  if (status?.status === 'error') throw makeError(describeStatusError(requestUrl, status), 'WEB_PROVIDER_ERROR')

  const results = Array.isArray(payload?.results) ? payload.results : []
  const page = results.find(entry => typeof entry?.url === 'string' && entry.url === requestUrl) ?? (results.length === 1 ? results[0] : undefined)
  const text = readableText(page)
  if (text.length === 0) {
    throw makeError(`Exa returned no readable content for ${requestUrl}`, 'WEB_PROVIDER_ERROR')
  }

  // Exa carries no truncation flag; a body that reaches the requested budget is
  // treated as cut, which is the only signal available without a second call.
  const truncated = text.length >= maxCharacters
  return {
    url: typeof page?.url === 'string' ? page.url : requestUrl,
    // Exa reports its own retrieval status, not the target's HTTP status.
    statusCode: 200,
    body: { kind: 'text', content: truncated ? text.slice(0, maxCharacters) : text },
    truncated,
  }
}
