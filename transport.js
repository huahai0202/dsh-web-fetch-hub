/**
 * Bounded transport helpers. Kept local so each plugin installs independently.
 * No Cordis imports: the provider supplies its WebError factory.
 */

/** One disposable deadline covers credentials, requests, bodies, and retry waits. */
export function createDeadline(callerSignal, timeoutMs, makeError) {
  const expiresAt = performance.now() + timeoutMs
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(
    makeError('web fetch timed out', 'WEB_FETCH_TIMEOUT'),
  ), timeoutMs)
  const signal = callerSignal === undefined
    ? controller.signal
    : AbortSignal.any([callerSignal, controller.signal])

  function abortError(cause) {
    if (!signal.aborted) return undefined
    const ownTimeout = controller.signal.aborted && signal.reason === controller.signal.reason
    return makeError(
      ownTimeout ? 'web fetch timed out' : 'web fetch aborted',
      ownTimeout ? 'WEB_FETCH_TIMEOUT' : 'WEB_ABORTED',
      { cause: cause ?? signal.reason },
    )
  }

  function throwIfAborted() {
    const error = abortError()
    if (error !== undefined) throw error
  }

  // Race even local credential reads against cancellation. Every branch observes
  // the underlying promise, including a late rejection after the race ends.
  function waitFor(promise) {
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(abortError())
      const cleanup = () => signal.removeEventListener('abort', onAbort)
      Promise.resolve(promise).then(
        value => { cleanup(); resolve(value) },
        error => { cleanup(); reject(abortError(error) ?? error) },
      )
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  function sleep(ms) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(abortError()); return }
      const onAbort = () => { clearTimeout(waitTimer); reject(abortError()) }
      const waitTimer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  return { signal, abortError, throwIfAborted, waitFor, sleep, remainingMs: () => Math.max(0, expiresAt - performance.now()), dispose: () => clearTimeout(timer) }
}

/** Validate the target locally before sending its URL to the upstream service. */
export function validateRequestUrl(value, makeError, maxLength = 8192) {
  let parsed
  try {
    if (typeof value !== 'string' || value.length > maxLength) throw new Error()
    parsed = new URL(value)
  } catch {
    throw makeError('web fetch needs an absolute HTTP(S) URL of at most ' + maxLength + ' characters', 'WEB_INVALID_URL')
  }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw makeError('web fetch needs an HTTP(S) URL without embedded credentials', 'WEB_INVALID_URL')
  }
  // Preserve the caller's spelling: Exa matches statuses to the submitted URL.
  return value
}

/** Read JSON through a byte cap; never swallow cancellation or size failures. */
export async function readJsonCapped(response, maxBytes, deadline, makeError) {
  deadline.throwIfAborted()
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > maxBytes) {
    void response.body?.cancel().catch(() => {})
    throw makeError('provider response exceeds maxResponseBytes', 'WEB_FETCH_TOO_LARGE')
  }
  if (response.body === null) throw new SyntaxError('empty response body')

  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  let done = false
  try {
    for (;;) {
      const chunk = await deadline.waitFor(reader.read())
      if (chunk.done) { done = true; break }
      total += chunk.value.byteLength
      if (total > maxBytes) {
        throw makeError('provider response exceeds maxResponseBytes', 'WEB_FETCH_TOO_LARGE')
      }
      chunks.push(chunk.value)
    }
    deadline.throwIfAborted()
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return JSON.parse(new TextDecoder().decode(bytes))
  } finally {
    if (!done) void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Parse standard Retry-After seconds or dates, including reverse-proxy hints. */
export function retryAfterMs(value, now = Date.now()) {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  const trimmed = value.trim()
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const ms = Math.ceil(Number(trimmed) * 1000)
    return Number.isFinite(ms) ? ms : undefined
  }
  if (/^[+\-\d.]+$/.test(trimmed)) return undefined
  const date = Date.parse(trimmed)
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined
}

/** Add up to 250ms of jitter without retrying earlier than an upstream hint. */
export function jitterDelayMs(wait, ceiling, random = Math.random) {
  return Math.min(ceiling, wait + Math.floor(random() * Math.min(250, wait * 0.25)))
}

/** Avoid retrying known permanent TLS, DNS, or request-construction failures. */
export function isRetryableTransportError(error) {
  const code = error?.cause?.code ?? error?.code
  if (typeof code === 'string' && /^(?:ERR_TLS|ERR_INVALID|ERR_UNESCAPED|CERT_|DEPTH_|UNABLE_TO_|SELF_SIGNED|ENOTFOUND)/.test(code)) return false
  // A TypeError without a cause usually describes a bad fetch argument or redirect.
  return error?.name !== 'TypeError' || error.cause !== undefined
}

/** Protect errors returned by a custom endpoint from echoing the active API key. */
export function redactSecret(value, secret) {
  const text = String(value)
  return secret ? text.split(secret).join('[REDACTED]') : text
}
