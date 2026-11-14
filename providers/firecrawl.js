/**
 * Firecrawl fetch provider for the native ctx.web registry.
 * Mapping is pure; transport owns bounded reads, cancellation, and retries.
 * @module dsh-web-fetch-firecrawl
 */
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { WebError } from '@deepseek-ai/dsh-web'
import {
  describeFailure,
  FIRECRAWL_MAX_RETRY_WAIT_MS,
  mapScrapeResponse,
  scrapeRequestBody,
  isRetryableFailure,
  isRetryableStatus,
  resolveOptions,
  retryDelayMs,
  retryFitsDeadline,
} from './firecrawl-mapping.js'
import {
  createDeadline,
  isRetryableTransportError,
  jitterDelayMs,
  readJsonCapped,
  redactSecret,
  retryAfterMs,
  validateRequestUrl,
} from '../transport.js'

export const FIRECRAWL_FETCH_PROVIDER_ID = 'firecrawl'
const USER_AGENT = 'dsh-web-fetch-firecrawl/0.3.1'
const KEY_REFERENCE = 'FIRECRAWL_API_KEY'
const makeError = (message, code, options) => new WebError(message, code, options)

/** Resolve current credentials; an empty literal key allows fallback. */
async function resolveApiKey(ctx, config) {
  if (typeof config.apiKey === 'string' && config.apiKey.trim().length > 0) return config.apiKey
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const resolved = await credentials.resolve(KEY_REFERENCE)
    if (typeof resolved?.value === 'string' && resolved.value.trim().length > 0) return resolved.value
  }
  return launchEnvironmentOf(ctx).get(KEY_REFERENCE)?.value ?? ''
}

export class FirecrawlFetchProvider {
  id = FIRECRAWL_FETCH_PROVIDER_ID
  title = 'Firecrawl Scrape API'
  description = {
    en: 'Reports the real HTTP status and final URL, and reads JavaScript pages and PDFs. Slower than a direct fetch and rate-limited per minute; incurs Firecrawl credits.',
    zh: '回报真实 HTTP 状态码与跳转后的最终地址，能读取需要 JavaScript 的页面和 PDF。比直连抓取慢，且有每分钟速率限制；会消耗 Firecrawl 额度。',
    ja: '実際の HTTP ステータスと最終 URL を返し、JavaScript が必要なページや PDF も読み取ります。直接取得より遅く、毎分のレート制限があります。Firecrawl のクレジットを消費します。',
    es: 'Informa el estado HTTP real y la URL final, y lee páginas con JavaScript y PDF. Más lento que una descarga directa y con límite de peticiones por minuto; consume créditos de Firecrawl.',
    fr: 'Renvoie le vrai statut HTTP et l’URL finale, et lit les pages JavaScript et les PDF. Plus lent qu’un accès direct, avec une limite de requêtes par minute ; consomme des crédits Firecrawl.',
    de: 'Meldet den echten HTTP-Status und die endgültige URL und liest JavaScript-Seiten sowie PDFs. Langsamer als ein direkter Abruf und mit Ratenlimit pro Minute; verbraucht Firecrawl-Guthaben.',
    ru: 'Возвращает настоящий код HTTP и итоговый URL, читает страницы с JavaScript и PDF. Медленнее прямого запроса, с ограничением запросов в минуту; расходует кредиты Firecrawl.',
    pt: 'Informa o status HTTP real e a URL final, e lê páginas com JavaScript e PDFs. Mais lento que um acesso direto e com limite de requisições por minuto; consome créditos da Firecrawl.',
  }
  constructor(readApiKey, readOptions) {
    this.readApiKey = readApiKey
    this.readOptions = readOptions
  }

  /** Synchronous configuration check; never caches credential availability. */
  available() {
    try { this.readOptions(''); return true } catch { return false }
  }

  /** Native admission hook: re-read local credentials on every model step. */
  async ready() {
    if (!this.available()) return true // fetch reports the configuration error
    const deadline = createDeadline(undefined, Math.min(this.readOptions('').timeoutMs, 1000), makeError)
    try {
      const key = await deadline.waitFor(Promise.resolve().then(() => this.readApiKey()))
      return this.readOptions(key).apiKey.length > 0
    } catch {
      // Keep the tool visible on credential-store faults; fetch reports the reason.
      return true
    } finally { deadline.dispose() }
  }

  /** Retrieve one page inside a single budget, including local credential reads. */
  async fetch(request, signal) {
    if (signal?.aborted) throw makeError('web fetch aborted', 'WEB_ABORTED')
    const url = validateRequestUrl(request?.url, makeError)
    const initial = this.readOptions('')
    const deadline = createDeadline(signal, initial.timeoutMs, makeError)
    const startedAt = performance.now()
    try {
      const key = await deadline.waitFor(Promise.resolve().then(() => this.readApiKey()))
      // Snapshot retrieval options at entry, normalize the freshly resolved key.
      const options = { ...initial, apiKey: this.readOptions(key).apiKey }
      deadline.throwIfAborted()
      if (options.apiKey.length === 0) {
        throw makeError('Firecrawl fetch needs ' + KEY_REFERENCE + '; set it in credentials or the launching environment', 'WEB_PROVIDER_CREDENTIAL_MISSING')
      }
      const fail = (message, code, details) => makeError(redactSecret(message, options.apiKey), code, details)
      for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
        deadline.throwIfAborted()
        const attemptStartedAt = performance.now()
        const outcome = await this.attempt(url, options, deadline, fail)
        const lastAttemptMs = performance.now() - attemptStartedAt
        deadline.throwIfAborted()
        if (outcome.result !== undefined) return outcome.result
        if (attempt === options.maxAttempts || !outcome.retryable) throw outcome.failure
        let wait = retryDelayMs(outcome.parsed, attempt, outcome.retryAfter)
        if (wait === undefined) throw outcome.failure
        wait = jitterDelayMs(wait, FIRECRAWL_MAX_RETRY_WAIT_MS)
        if (!retryFitsDeadline(wait, options.timeoutMs, performance.now() - startedAt, lastAttemptMs)) throw outcome.failure
        await deadline.sleep(wait)
      }
    } finally { deadline.dispose() }
  }

  /** One API request. Resource failures remain distinct from API failures. */
  async attempt(url, options, deadline, fail) {
    const body = scrapeRequestBody(url, options, deadline.remainingMs())
    if (body.waitFor !== undefined && body.waitFor >= Math.min(body.timeout, Math.max(0, deadline.remainingMs() - 1000))) {
      return {
        failure: fail('remaining fetch budget cannot fit Firecrawl waitForMs', 'WEB_FETCH_TIMEOUT'),
        retryable: false,
      }
    }
    let response
    try {
      response = await deadline.waitFor(fetch(options.baseURL + '/v2/scrape', {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: 'Bearer ' + options.apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        signal: deadline.signal,
      }))
    } catch (error) {
      const aborted = deadline.abortError(error)
      if (aborted !== undefined) throw aborted
      return {
        failure: fail('Firecrawl request failed', 'WEB_PROVIDER_ERROR', { cause: error }),
        retryable: isRetryableTransportError(error),
      }
    }
    const retryAfter = retryAfterMs(response.headers.get('retry-after'))
    let payload
    try {
      payload = await readJsonCapped(response, options.maxResponseBytes, deadline, fail)
    } catch (error) {
      const aborted = deadline.abortError(error)
      if (aborted !== undefined) throw aborted
      if (error?.code === 'WEB_FETCH_TOO_LARGE') throw error
      if (!response.ok) {
        return { failure: fail(describeFailure(response.status), 'WEB_PROVIDER_ERROR'), retryable: isRetryableStatus(response.status), retryAfter }
      }
      return {
        failure: fail('Firecrawl returned an unprocessable response body', 'WEB_PROVIDER_ERROR', { cause: error }),
        retryable: !(error instanceof SyntaxError) && isRetryableTransportError(error),
        retryAfter,
      }
    }
    if (!response.ok) {
      return {
        failure: fail(describeFailure(response.status, payload), 'WEB_PROVIDER_ERROR'),
        // The body's `code` decides too: `SCRAPE_ALL_ENGINES_FAILED` arrives as a
        // 500 but cannot succeed on a later attempt.
        retryable: isRetryableFailure(response.status, payload),
        ...payload === undefined ? {} : { parsed: payload },
        retryAfter,
      }
    }
    return { result: mapScrapeResponse(payload, url, fail, options.maxCharacters) }
  }
}

/**
 * Build the Firecrawl provider for a hub mount.
 *
 * @param ctx - context supplying credentials and the launch environment.
 * @param config - this channel's row config.
 * @returns the provider instance the hub registers.
 */
export function createFirecrawlProvider(ctx, config = {}) {
  const readApiKey = () => resolveApiKey(ctx, config)
  const readOptions = apiKey => resolveOptions(apiKey, config)
  // Validate the row at mount so a mistyped field fails with its name instead of
  // waiting for the first fetch. The key resolves per fetch, because it can
  // arrive after mount (the credentials store hot-reloads).
  readOptions('')
  return new FirecrawlFetchProvider(readApiKey, readOptions)
}
