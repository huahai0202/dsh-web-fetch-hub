/**
 * Self-test for the Exa fetch provider's pure mapping and config rules.
 * Runs without Cordis or the dsh installation:
 *   node tests/mapping.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  describeStatusError,
  isRetryableStatus,
  mapContentsResponse,
  readableText,
  resolveOptions,
  retryDelayMs,
  retryFitsDeadline,
  statusFor,
  EXA_MAX_RETRY_WAIT_MS,
} from '../providers/exa-mapping.js'

const makeError = (message, code) => Object.assign(new Error(message), { code })
const map = (payload, url, budget) => mapContentsResponse(payload, url, budget, makeError)
const success = (url, extra = {}) => ({
  statuses: [{ id: url, status: 'success' }],
  results: [{ url, ...extra }],
})

test('maps a text result to the seam shape', () => {
  const result = map(success('https://a.test', { text: 'hello' }), 'https://a.test', 1000)
  assert.deepEqual(result, {
    url: 'https://a.test',
    statusCode: 200,
    body: { kind: 'text', content: 'hello' },
    truncated: false,
  })
})

test('falls back to summary when text is absent', () => {
  const result = map(success('https://a.test', { summary: 'condensed' }), 'https://a.test', 1000)
  assert.equal(result.body.content, 'condensed')
})

test('falls back to highlights when text and summary are absent', () => {
  const result = map(success('https://a.test', { highlights: ['one', 'two'] }), 'https://a.test', 1000)
  assert.equal(result.body.content, 'one\n\ntwo')
})

test('ignores blank text and blank highlights', () => {
  assert.equal(readableText({ text: '   ' }), '')
  assert.equal(readableText({ text: '  ', highlights: ['', '  '] }), '')
})

test('marks a body at the budget as truncated and cuts it', () => {
  const result = map(success('https://a.test', { text: 'abcdefghij' }), 'https://a.test', 5)
  assert.equal(result.truncated, true)
  assert.equal(result.body.content, 'abcdefghij'.slice(0, 5))
})

test('keeps a body under the budget untruncated', () => {
  const result = map(success('https://a.test', { text: 'abc' }), 'https://a.test', 5)
  assert.equal(result.truncated, false)
  assert.equal(result.body.content, 'abc')
})

test('reports a per-URL failure with Exa tag and upstream status', () => {
  const payload = {
    statuses: [{ id: 'https://a.test', status: 'error', error: { tag: 'CRAWL_NOT_FOUND', httpStatusCode: 404 } }],
    results: [],
  }
  assert.throws(() => map(payload, 'https://a.test', 1000), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_ERROR')
    assert.match(error.message, /CRAWL_NOT_FOUND, HTTP 404/)
    return true
  })
})

test('reports a failure whose status carries only a tag', () => {
  assert.match(describeStatusError('https://a.test', { error: { tag: 'UNSUPPORTED_URL' } }), /UNSUPPORTED_URL$/)
  assert.match(describeStatusError('https://a.test', { status: 'error' }), /unknown error/)
})

test('throws when Exa returns no readable body', () => {
  assert.throws(() => map(success('https://a.test', { text: '  ' }), 'https://a.test', 1000), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_ERROR')
    assert.match(error.message, /no readable content/)
    return true
  })
})

test('answers for an empty payload without inventing a page', () => {
  assert.equal(statusFor({}, 'https://a.test'), undefined)
  assert.throws(() => map({}, 'https://a.test', 1000), /no readable content/)
})

test('matches the requested URL among several statuses', () => {
  const payload = {
    statuses: [
      { id: 'https://other.test', status: 'success' },
      { id: 'https://a.test', status: 'error', error: { tag: 'CRAWL_TIMEOUT' } },
    ],
    results: [],
  }
  assert.throws(() => map(payload, 'https://a.test', 1000), /CRAWL_TIMEOUT/)
})

test('applies defaults and accepts an override for every field', () => {
  assert.deepEqual(resolveOptions('key'), {
    apiKey: 'key',
    baseURL: 'https://api.exa.ai',
    maxCharacters: 100000,
    verbosity: 'standard',
    timeoutMs: 25000,
    maxAttempts: 3,
    maxResponseBytes: 8388608,
    livecrawlTimeoutMs: 10000,
    linkStyle: 'full',
  })
  assert.deepEqual(
    resolveOptions('key', { baseURL: 'https://proxy.test', maxCharacters: 500, verbosity: 'compact', timeoutMs: 1000, maxAttempts: 1 }),
    {
      apiKey: 'key',
      baseURL: 'https://proxy.test',
      maxCharacters: 500,
      verbosity: 'compact',
      timeoutMs: 1000,
      maxAttempts: 1,
      maxResponseBytes: 8388608,
    livecrawlTimeoutMs: 10000,
    linkStyle: 'full',
    },
  )
})

test('keeps maxAgeHours only when the row sets it', () => {
  assert.equal('maxAgeHours' in resolveOptions('key'), false)
  assert.equal(resolveOptions('key', { maxAgeHours: 0 }).maxAgeHours, 0)
  assert.equal(resolveOptions('key', { maxAgeHours: -1 }).maxAgeHours, -1)
  assert.equal(resolveOptions('key', { maxAgeHours: 24 }).maxAgeHours, 24)
  assert.throws(() => resolveOptions('key', { maxAgeHours: 1.5 }), /maxAgeHours/)
})

test('rejects an unusable key, endpoint, budget, verbosity, and deadline', () => {
  assert.throws(() => resolveOptions(undefined), /apiKey/)
  assert.throws(() => resolveOptions(42), /apiKey/)
  assert.throws(() => resolveOptions('key', { baseURL: 'not a url' }), /baseURL/)
  assert.throws(() => resolveOptions('key', { maxCharacters: 0 }), /maxCharacters/)
  assert.throws(() => resolveOptions('key', { maxCharacters: 5000001 }), /maxCharacters/)
  assert.throws(() => resolveOptions('key', { maxCharacters: 1.5 }), /maxCharacters/)
  assert.throws(() => resolveOptions('key', { verbosity: 'verbose' }), /verbosity/)
  assert.throws(() => resolveOptions('key', { timeoutMs: -1 }), /timeoutMs/)
  assert.throws(() => resolveOptions('key', { maxAttempts: 0 }), /maxAttempts/)
  assert.throws(() => resolveOptions('key', { maxAttempts: 6 }), /maxAttempts/)
})

test('retries only the statuses that can succeed on another attempt', () => {
  for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(isRetryableStatus(status), true, String(status))
  for (const status of [400, 401, 402, 403, 404]) assert.equal(isRetryableStatus(status), false, String(status))
})

test('backs off exponentially when no Retry-After header is supplied', () => {
  assert.equal(retryDelayMs(undefined, 1), 1000)
  assert.equal(retryDelayMs(undefined, 2), 2000)
  assert.equal(retryDelayMs(undefined, 3), 4000)
  assert.equal(retryDelayMs(undefined, 4), 8000)
  assert.equal(retryDelayMs(undefined, 5), undefined)
  assert.equal(EXA_MAX_RETRY_WAIT_MS, 12000)
})

test("ignores the Firecrawl-specific retry_after_seconds body field", () => {
  // Even if a proxy injected `retry_after_seconds`, the wait stays on backoff.
  assert.equal(retryDelayMs({ retry_after_seconds: 30 }, 1), 1000)
})

test('a retry must fit in the budget and leave room for the next attempt', () => {
  const timeoutMs = 25000
  const request = 1200
  const fits = (wait, elapsed) => retryFitsDeadline(wait, timeoutMs, elapsed, request)
  assert.equal(fits(1000, request), true)
  // 25 - (1.2+1+1.2) = 21.6s left; the next 2s wait plus a request fits.
  assert.equal(fits(2000, request + 1000 + request), true)
  // An 8s wait after 20s of work cannot leave room for another request.
  assert.equal(fits(8000, 20000), false)
  // The exact boundary is strict: wait + attempt must be inside the remainder.
  assert.equal(retryFitsDeadline(2000, timeoutMs, 22000, 1000), false)
  assert.equal(retryFitsDeadline(1999, timeoutMs, 22000, 1000), true)
})



test('strictly validates row fields, key types, limits and endpoint hygiene', () => {
  for (const config of [null, [], 'bad']) assert.throws(() => resolveOptions('key', config), /config/)
  assert.throws(() => resolveOptions('key', { timeoutMS: 1 }), /timeoutMS/)
  assert.throws(() => resolveOptions('key', { apiKey: 42 }), /apiKey/)
  assert.throws(() => resolveOptions('key', { apiKey: 'bad\nkey' }), /apiKey/)
  assert.throws(() => resolveOptions('key', { timeoutMs: 2147483648 }), /timeoutMs/)
  assert.throws(() => resolveOptions('key', { maxResponseBytes: 0 }), /maxResponseBytes/)
  assert.throws(() => resolveOptions('key', { maxResponseBytes: 67108865 }), /maxResponseBytes/)
  assert.throws(() => resolveOptions('key', { maxCharacters: null }), /maxCharacters/)
  for (const baseURL of ['file:///tmp', 'https://user:pass@api.test', 'https://api.test/?key=x', 'https://api.test/#fragment']) {
    assert.throws(() => resolveOptions('key', { baseURL }), /baseURL/)
  }
  assert.equal(resolveOptions('  key  ', { baseURL: 'https://proxy.test/api///' }).baseURL, 'https://proxy.test/api')
  assert.equal(resolveOptions('  key  ').apiKey, 'key')
})


test('applies the current official character, freshness and livecrawl bounds', () => {
  assert.equal(resolveOptions('key', { maxCharacters: 5000000 }).maxCharacters, 5000000)
  assert.equal(resolveOptions('key', { maxAgeHours: 720 }).maxAgeHours, 720)
  assert.throws(() => resolveOptions('key', { maxAgeHours: 721 }), /maxAgeHours/)
  assert.throws(() => resolveOptions('key', { maxAgeHours: -2 }), /maxAgeHours/)
  assert.equal(resolveOptions('key', { livecrawlTimeoutMs: 90000 }).livecrawlTimeoutMs, 90000)
  assert.throws(() => resolveOptions('key', { livecrawlTimeoutMs: 90001 }), /livecrawlTimeoutMs/)
  assert.throws(() => resolveOptions('key', { livecrawlTimeoutMs: 0 }), /livecrawlTimeoutMs/)
})

test('validates link formats and copies best-effort semantic section filters', () => {
  const sections = ['body']
  const options = resolveOptions('key', { includeSections: sections, excludeSections: ['navigation'], linkStyle: 'citation' })
  sections.push('footer')
  assert.deepEqual(options.includeSections, ['body'])
  assert.equal(options.linkStyle, 'citation')
  assert.throws(() => resolveOptions('key', { linkStyle: 'html' }), /linkStyle/)
  assert.throws(() => resolveOptions('key', { includeSections: ['article'] }), /includeSections/)
  assert.throws(() => resolveOptions('key', { excludeSections: [] }), /excludeSections/)
  assert.throws(() => resolveOptions('key', { includeSections: new Array(1) }), /includeSections/)
})

test('honors Retry-After headers within the retry ceiling', () => {
  assert.equal(retryDelayMs(undefined, 1, 2000), 2000)
  assert.equal(retryDelayMs(undefined, 1, 13000), undefined)
})

test('does not substitute an unrelated page from a multi-result response', () => {
  assert.throws(() => map({ results: [{ url: 'https://b.test', text: 'wrong' }, { url: 'https://c.test', text: 'wrong' }] }, 'https://a.test', 1000), /no readable content/)
})
