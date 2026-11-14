/**
 * Pure data mapping and retry policy for the Firecrawl fetch provider: no
 * network, no Cordis, no package imports, so every rule is unit-testable on its
 * own. The provider supplies an error factory, keeping this module free of
 * runtime dependencies.
 * @module dsh-web-fetch-firecrawl/mapping
 */

/** Default Firecrawl API origin; `/v2/scrape` is the operation. */
export const FIRECRAWL_DEFAULT_BASE_URL = 'https://api.firecrawl.dev'

/**
 * Default provider-side deadline, in milliseconds. Kept below the tool-call
 * budget (`fetchTimeoutMs`, 30000 by default) so a slow scrape reports this
 * provider's own `WEB_FETCH_TIMEOUT` instead of the generic tool timeout, and so
 * a short retry can still finish inside one tool call.
 */
export const FIRECRAWL_DEFAULT_TIMEOUT_MS = 25000

/** Default number of attempts for one fetch, including the first one. */
export const FIRECRAWL_DEFAULT_MAX_ATTEMPTS = 3

/** Longest single wait the provider will sit through, in milliseconds. */
export const FIRECRAWL_MAX_RETRY_WAIT_MS = 12000

/** Statuses Firecrawl answers when the request itself may succeed on retry. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504])

/**
 * Failure codes that arrive with a retryable status but cannot succeed later.
 * Firecrawl answers `500 SCRAPE_ALL_ENGINES_FAILED` for an address it cannot
 * reach at all — an intranet host, a dead network — and every attempt retries the
 * same engines against the same address. Retrying spends the fetch budget to
 * reproduce the identical failure, so these codes end the fetch on the first
 * attempt even though 5xx is otherwise retryable.
 */
const PERMANENT_FAILURE_CODES = new Set([
  'SCRAPE_ALL_ENGINES_FAILED',
  'THIRD_PARTY_DATA_NOT_FOUND',
  'THIRD_PARTY_DATA_TERMS_REQUIRED',
  'UNKNOWN_PROVIDER',
  // `request_unresolved` is deliberately absent: Firecrawl documents it as
  // "keep the same request and retry", so it stays retryable.
])

/** Maximum configurable local markdown budget. */
export const FIRECRAWL_MAX_MARKDOWN_CHARS = 2000000

/** Default local markdown budget; the tool still owns its complete output cap. */
export const FIRECRAWL_DEFAULT_MAX_CHARACTERS = 100000

/** Config fields accepted by this provider; unknown fields fail at mount. */
const CONFIG_FIELDS = new Set(['apiKey', 'baseURL', 'timeoutMs', 'maxAttempts', 'maxResponseBytes', 'maxCharacters', 'onlyMainContent', 'maxAgeMs', 'waitForMs', 'includeTags', 'excludeTags', 'onlyCleanContent', 'blockAds', 'removeBase64Images', 'proxy', 'pdfMaxPages', 'minAgeMs', 'storeInCache'])

/** Reject malformed rows and literal keys before the first credential resolution. */
function validateConfig(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('web-fetch-firecrawl: config must be an object')
  }
  for (const field of Object.keys(config)) {
    if (!CONFIG_FIELDS.has(field)) throw new Error('web-fetch-firecrawl: unknown config.' + field)
    if (config[field] === null) throw new Error('web-fetch-firecrawl: config.' + field + ' must not be null')
  }
  if (config.apiKey !== undefined && (typeof config.apiKey !== 'string' || /[\r\n]/.test(config.apiKey))) {
    throw new Error('web-fetch-firecrawl: config.apiKey must be a string without line breaks')
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
  if (typeof apiKey !== 'string' || /[\r\n]/.test(apiKey)) throw new Error('web-fetch-firecrawl: config.apiKey must be a string without line breaks')
  apiKey = apiKey.trim()

  let baseURL = config.baseURL ?? FIRECRAWL_DEFAULT_BASE_URL
  if (!isValidBaseUrl(baseURL)) throw new Error('web-fetch-firecrawl: config.baseURL must be an HTTP(S) URL without credentials, query, or fragment')
  baseURL = new URL(baseURL).toString().replace(/\/+$/, '')

  const timeoutMs = config.timeoutMs ?? FIRECRAWL_DEFAULT_TIMEOUT_MS
  if (!isPositiveInteger(timeoutMs) || timeoutMs > 2147483647) throw new Error('web-fetch-firecrawl: config.timeoutMs must be a positive whole number no greater than 2147483647')

  const maxResponseBytes = config.maxResponseBytes ?? 16777216
  if (!isPositiveInteger(maxResponseBytes) || maxResponseBytes > 67108864) {
    throw new Error('web-fetch-firecrawl: config.maxResponseBytes must be a positive whole number no greater than 67108864')
  }

  const maxAttempts = config.maxAttempts ?? FIRECRAWL_DEFAULT_MAX_ATTEMPTS
  if (!isPositiveInteger(maxAttempts) || maxAttempts > 5) {
    throw new Error('web-fetch-firecrawl: config.maxAttempts must be a positive whole number no greater than 5')
  }

  const maxCharacters = config.maxCharacters ?? FIRECRAWL_DEFAULT_MAX_CHARACTERS
  if (!isPositiveInteger(maxCharacters) || maxCharacters > FIRECRAWL_MAX_MARKDOWN_CHARS) {
    throw new Error('web-fetch-firecrawl: config.maxCharacters must be a positive whole number no greater than 2000000')
  }

  const onlyMainContent = config.onlyMainContent ?? true
  if (typeof onlyMainContent !== 'boolean') throw new Error('web-fetch-firecrawl: config.onlyMainContent must be a boolean')

  const native = {}
  for (const field of ['onlyCleanContent', 'blockAds', 'removeBase64Images', 'storeInCache']) {
    if (config[field] !== undefined) {
      if (typeof config[field] !== 'boolean') throw new Error('web-fetch-firecrawl: config.' + field + ' must be a boolean')
      native[field] = config[field]
    }
  }
  if (config.proxy !== undefined) {
    if (!['basic', 'enhanced', 'auto'].includes(config.proxy)) throw new Error('web-fetch-firecrawl: config.proxy must be basic, enhanced, or auto')
    native.proxy = config.proxy
  }
  if (config.pdfMaxPages !== undefined) {
    if (!isPositiveInteger(config.pdfMaxPages) || config.pdfMaxPages > 10000) {
      throw new Error('web-fetch-firecrawl: config.pdfMaxPages must be a positive whole number no greater than 10000')
    }
    native.pdfMaxPages = config.pdfMaxPages
  }
  if (config.minAgeMs !== undefined) {
    if (!isPositiveInteger(config.minAgeMs)) throw new Error('web-fetch-firecrawl: config.minAgeMs must be a positive whole number')
    native.minAgeMs = config.minAgeMs
  }

  // Omitted `maxAge` keeps Firecrawl's own two-day cache window; 0 demands a
  // fresh scrape. Firecrawl takes milliseconds.
  const maxAgeMs = config.maxAgeMs
  if (maxAgeMs !== undefined && !(Number.isSafeInteger(maxAgeMs) && maxAgeMs >= 0)) {
    throw new Error('web-fetch-firecrawl: config.maxAgeMs must be a whole number of milliseconds, or 0')
  }

  // Extra wait before reading, for pages whose content appears only after their
  // own scripts settle. Firecrawl adds this to its smart wait, capped at 60s.
  const waitForMs = config.waitForMs
  if (waitForMs !== undefined && !(Number.isSafeInteger(waitForMs) && waitForMs >= 0 && waitForMs <= 60000)) {
    throw new Error('web-fetch-firecrawl: config.waitForMs must be a whole number from 0 to 60000')
  }
  if (waitForMs !== undefined && waitForMs >= Math.min(300000, Math.max(1000, timeoutMs - 1000))) {
    throw new Error('web-fetch-firecrawl: config.waitForMs must fit the server timeout (timeoutMs minus 1000ms, capped at 300000ms)')
  }

  // Elements to keep or drop, matched on the rendered page. Both are Firecrawl
  // tag selectors; an entry is passed through as written.
  const includeTags = config.includeTags
  if (includeTags !== undefined && !isTagList(includeTags)) {
    throw new Error('web-fetch-firecrawl: config.includeTags must be an array of non-empty strings')
  }
  const excludeTags = config.excludeTags
  if (excludeTags !== undefined && !isTagList(excludeTags)) {
    throw new Error('web-fetch-firecrawl: config.excludeTags must be an array of non-empty strings')
  }

  return {
    apiKey,
    baseURL,
    timeoutMs,
    maxAttempts,
    maxResponseBytes,
    maxCharacters,
    onlyMainContent,
    ...native,
    ...maxAgeMs === undefined ? {} : { maxAgeMs },
    ...waitForMs === undefined ? {} : { waitForMs },
    ...includeTags === undefined ? {} : { includeTags: [...includeTags] },
    ...excludeTags === undefined ? {} : { excludeTags: [...excludeTags] },
  }
}

/** True for a non-empty array of non-empty strings. */
function isTagList(value) {
  return Array.isArray(value) && value.length > 0
    && Array.from(value).every(item => typeof item === 'string' && item.trim().length > 0)
}

/**
 * Build the `/v2/scrape` request body for one URL from resolved options.
 *
 * @param url - the page to scrape.
 * @param options - resolved provider options.
 * @returns the JSON-serializable request body.
 */
export function scrapeRequestBody(url, options, remainingMs = options.timeoutMs) {
  return {
    url,
    formats: ['markdown'],
    // Firecrawl allows 1000..300000ms; leave room to receive/decode its response.
    timeout: Math.min(300000, Math.max(1000, Math.floor(remainingMs - 1000))),
    onlyMainContent: options.onlyMainContent,
    ...Object.fromEntries(['onlyCleanContent', 'blockAds', 'removeBase64Images', 'proxy', 'storeInCache']
      .filter(field => options[field] !== undefined).map(field => [field, options[field]])),
    ...options.minAgeMs === undefined ? {} : { minAge: options.minAgeMs },
    ...options.pdfMaxPages === undefined ? {} : { parsers: [{ type: 'pdf', maxPages: options.pdfMaxPages }, 'image'] },
    ...options.maxAgeMs === undefined ? {} : { maxAge: options.maxAgeMs },
    ...options.waitForMs === undefined ? {} : { waitFor: options.waitForMs },
    ...options.includeTags === undefined ? {} : { includeTags: options.includeTags },
    ...options.excludeTags === undefined ? {} : { excludeTags: options.excludeTags },
  }
}

/** Whether a failed attempt may be repeated; 401/402/403 never are. */
export function isRetryableStatus(status) {
  return RETRYABLE_STATUSES.has(status)
}

/**
 * Whether a failed attempt may be repeated, given both the HTTP status and the
 * body's machine-readable `code`. A code in {@link PERMANENT_FAILURE_CODES} wins
 * over a retryable status, because Firecrawl reports an unreachable address or a
 * rejected third-party request that way and another attempt cannot change it.
 *
 * @param status - the response's HTTP status.
 * @param payload - the parsed error body, when it was readable.
 * @returns whether another attempt is worth starting.
 */
export function isRetryableFailure(status, payload) {
  if (!isRetryableStatus(status)) return false
  const code = typeof payload?.code === 'string' ? payload.code : undefined
  return code === undefined || !PERMANENT_FAILURE_CODES.has(code)
}

/**
 * How long to wait before the next attempt. Honor standard Retry-After and the
 * legacy retry_after_seconds body field, choosing the longer reported wait.
 * A wait beyond {@link FIRECRAWL_MAX_RETRY_WAIT_MS} is not worth blocking a tool
 * call for, so it ends the retries instead.
 *
 * @param parsed - the parsed 429 body, when it was readable.
 * @param retryAfter - the parsed Retry-After header in milliseconds.
 * @param attempt - the 1-based attempt that just failed.
 * @returns the wait in milliseconds, or undefined when retrying is pointless.
 */
export function retryDelayMs(parsed, attempt, retryAfter) {
  const reported = parsed?.retry_after_seconds
  if (typeof reported === 'number' && Number.isFinite(reported) && reported >= 0) {
    const reportedMs = Math.max(Math.ceil(reported * 1000), retryAfter ?? 0)
    return reportedMs > FIRECRAWL_MAX_RETRY_WAIT_MS ? undefined : reportedMs
  }
  if (retryAfter !== undefined) return retryAfter > FIRECRAWL_MAX_RETRY_WAIT_MS ? undefined : retryAfter
  // No usable hint: back off gently instead of hammering the same one-minute window.
  const backoff = 1000 * 2 ** (attempt - 1)
  return backoff > FIRECRAWL_MAX_RETRY_WAIT_MS ? undefined : backoff
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

/**
 * Describe a failed Firecrawl response, keeping its machine-readable `code`.
 */
export function describeFailure(status, payload) {
  const message = typeof payload?.error === 'string' ? payload.error : `Firecrawl scrape failed (HTTP ${status})`
  const code = typeof payload?.code === 'string' ? payload.code : undefined
  return code === undefined ? message : `${message} [${code}]`
}

/**
 * Map one Firecrawl `/v2/scrape` response to the seam's fetch result.
 *
 * @param payload - the parsed response body.
 * @param requestUrl - the URL the operator asked for.
 * @param makeError - builds the seam error from a message and a machine-readable code.
 * @returns the normalized fetch result.
 * @throws the factory's error when Firecrawl reports no usable document.
 */
export function mapScrapeResponse(payload, requestUrl, makeError, maxCharacters = FIRECRAWL_DEFAULT_MAX_CHARACTERS) {
  if (payload?.success !== true) {
    throw makeError(describeFailure(200, payload), 'WEB_PROVIDER_ERROR')
  }
  const data = payload.data
  const markdown = typeof data?.markdown === 'string' ? data.markdown : ''
  const metadata = data?.metadata ?? {}
  const statusCode = metadata.statusCode === undefined ? 200 : metadata.statusCode
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    throw makeError('Firecrawl returned an invalid target HTTP status', 'WEB_PROVIDER_ERROR')
  }
  // Non-2xx targets are resource results even when the error page is empty.
  if (markdown.trim().length === 0 && statusCode >= 200 && statusCode < 300 && ![204, 205].includes(statusCode)) {
    throw makeError(`Firecrawl returned no readable content for ${requestUrl}`, 'WEB_PROVIDER_ERROR')
  }
  if (metadata.url !== undefined && typeof metadata.url !== 'string') {
    throw makeError('Firecrawl returned an invalid final URL', 'WEB_PROVIDER_ERROR')
  }
  const finalUrl = typeof metadata.url === 'string' && metadata.url.length > 0 ? metadata.url : requestUrl
  if (!URL.canParse(finalUrl) || !['http:', 'https:'].includes(new URL(finalUrl).protocol)
    || new URL(finalUrl).username || new URL(finalUrl).password) {
    throw makeError('Firecrawl returned an invalid final URL', 'WEB_PROVIDER_ERROR')
  }
  const truncatedByCharacters = markdown.length > maxCharacters
  const truncatedByPages = Number.isInteger(metadata.totalPages) && Number.isInteger(metadata.numPages)
    && metadata.numPages >= 0 && metadata.totalPages > metadata.numPages
  const truncated = truncatedByCharacters || truncatedByPages

  return {
    url: finalUrl,
    statusCode,
    body: { kind: 'text', content: truncatedByCharacters ? markdown.slice(0, maxCharacters) : markdown },
    truncated,
  }
}
