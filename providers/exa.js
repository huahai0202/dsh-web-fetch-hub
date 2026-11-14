/**
 * Exa fetch provider for the native ctx.web registry.
 * Mapping is pure; transport owns bounded reads, cancellation, and retries.
 * @module dsh-web-fetch-exa
 */
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { WebError } from '@deepseek-ai/dsh-web'
import {
  contentsRequestBody,
  describeApiFailure,
  describeStatusError,
  EXA_MAX_RETRY_WAIT_MS,
  isRetryableContentsStatus,
  mapContentsResponse,
  statusFor,
  isRetryableStatus,
  resolveOptions,
  retryDelayMs,
  retryFitsDeadline,
} from './exa-mapping.js'
import {
  createDeadline,
  isRetryableTransportError,
  jitterDelayMs,
  readJsonCapped,
  redactSecret,
  retryAfterMs,
  validateRequestUrl,
} from '../transport.js'

export const EXA_FETCH_PROVIDER_ID = 'exa-fetch'
const USER_AGENT = 'dsh-web-fetch-exa/0.4.1'
const KEY_REFERENCE = 'EXA_API_KEY'
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

export class ExaFetchProvider {
  id = EXA_FETCH_PROVIDER_ID
  title = 'Exa Contents API'
  description = {
    en: 'Reader-ready text from Exa, including pages that need JavaScript or are PDFs. Incurs Exa charges and cannot reach intranet or local addresses.',
    zh: '由 Exa 抓取并返回可读正文，可处理需要 JavaScript 的页面和 PDF。会产生 Exa 费用，且无法访问内网和本机地址。',
    ja: 'Exa が取得した読みやすい本文を返し、JavaScript が必要なページや PDF にも対応します。Exa の料金が発生し、イントラネットやローカルのアドレスにはアクセスできません。',
    es: 'Texto listo para leer de Exa, incluidas páginas que requieren JavaScript y PDF. Genera cargos de Exa y no accede a direcciones de la intranet ni locales.',
    fr: 'Texte prêt à lire fourni par Exa, y compris les pages nécessitant JavaScript et les PDF. Entraîne des frais Exa et n’accède pas aux adresses intranet ou locales.',
    de: 'Von Exa aufbereiteter Lesetext, auch für Seiten mit JavaScript und PDFs. Verursacht Exa-Kosten und erreicht keine Intranet- oder lokalen Adressen.',
    ru: 'Готовый к чтению текст от Exa, включая страницы с JavaScript и PDF. Влечёт расходы Exa и не даёт доступа к адресам интрасети и локальным адресам.',
    pt: 'Texto pronto para leitura fornecido pela Exa, inclusive páginas que exigem JavaScript e PDFs. Gera cobranças da Exa e não acessa endereços da intranet nem locais.',
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
    const url = validateRequestUrl(request?.url, makeError, 2048)
    const initial = this.readOptions('')
    const deadline = createDeadline(signal, initial.timeoutMs, makeError)
    const startedAt = performance.now()
    try {
      const key = await deadline.waitFor(Promise.resolve().then(() => this.readApiKey()))
      // Snapshot retrieval options at entry, normalize the freshly resolved key.
      const options = { ...initial, apiKey: this.readOptions(key).apiKey }
      deadline.throwIfAborted()
      if (options.apiKey.length === 0) {
        throw makeError('Exa fetch needs ' + KEY_REFERENCE + '; set it in credentials or the launching environment', 'WEB_PROVIDER_CREDENTIAL_MISSING')
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
        wait = jitterDelayMs(wait, EXA_MAX_RETRY_WAIT_MS)
        if (!retryFitsDeadline(wait, options.timeoutMs, performance.now() - startedAt, lastAttemptMs)) throw outcome.failure
        await deadline.sleep(wait)
      }
    } finally { deadline.dispose() }
  }

  /** One API request. Resource failures remain distinct from API failures. */
  async attempt(url, options, deadline, fail) {
    let response
    try {
      response = await deadline.waitFor(fetch(options.baseURL + '/contents', {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: 'Bearer ' + options.apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(contentsRequestBody(url, options, deadline.remainingMs())),
        signal: deadline.signal,
      }))
    } catch (error) {
      const aborted = deadline.abortError(error)
      if (aborted !== undefined) throw aborted
      return {
        failure: fail('Exa request failed', 'WEB_PROVIDER_ERROR', { cause: error }),
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
        return { failure: fail(describeApiFailure(response.status), 'WEB_PROVIDER_ERROR'), retryable: isRetryableStatus(response.status), retryAfter }
      }
      return {
        failure: fail('Exa returned an unprocessable response body', 'WEB_PROVIDER_ERROR', { cause: error }),
        retryable: !(error instanceof SyntaxError) && isRetryableTransportError(error),
        retryAfter,
      }
    }
    if (!response.ok) {
      return { failure: fail(describeApiFailure(response.status, payload), 'WEB_PROVIDER_ERROR'), retryable: isRetryableStatus(response.status), parsed: payload, retryAfter }
    }
    const status = statusFor(payload, url)
    if (status?.status === 'error') {
      return { failure: fail(describeStatusError(url, status), 'WEB_PROVIDER_ERROR'), retryable: isRetryableContentsStatus(status), retryAfter }
    }
    return { result: mapContentsResponse(payload, url, options.maxCharacters, fail) }
  }
}

/**
 * Build the Exa provider for a hub mount.
 *
 * @param ctx - context supplying credentials and the launch environment.
 * @param config - this channel's row config.
 * @returns the provider instance the hub registers.
 */
export function createExaProvider(ctx, config = {}) {
  const readApiKey = () => resolveApiKey(ctx, config)
  const readOptions = apiKey => resolveOptions(apiKey, config)
  // Validate the row at mount so a mistyped field fails with its name instead of
  // waiting for the first fetch. The key resolves per fetch, because it can
  // arrive after mount (the credentials store hot-reloads).
  readOptions('')
  return new ExaFetchProvider(readApiKey, readOptions)
}
