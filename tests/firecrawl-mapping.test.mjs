/**
 * Self-test for the Firecrawl fetch provider's pure mapping, config, and retry
 * policy. Runs without Cordis or the dsh installation:
 *   node tests/mapping.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  describeFailure,
  isRetryableFailure,
  isRetryableStatus,
  mapScrapeResponse,
  resolveOptions,
  retryDelayMs,
  retryFitsDeadline,
  scrapeRequestBody,
  FIRECRAWL_MAX_RETRY_WAIT_MS,
} from '../providers/firecrawl-mapping.js'

const makeError = (message, code) => Object.assign(new Error(message), { code })
const map = (payload, url = 'https://a.test') => mapScrapeResponse(payload, url, makeError)
const scraped = (extra = {}) => ({
  success: true,
  data: {
    markdown: '# Title\n\nbody',
    metadata: { statusCode: 200, url: 'https://a.test', creditsUsed: 1, cacheState: 'miss' },
    ...extra,
  },
})

test('maps a successful scrape to the seam shape', () => {
  assert.deepEqual(map(scraped()), {
    url: 'https://a.test',
    statusCode: 200,
    body: { kind: 'text', content: '# Title\n\nbody' },
    truncated: false,
  })
})

test('reports the real target status, not the API status', () => {
  const payload = {
    success: true,
    data: { markdown: 'Not found page', metadata: { statusCode: 404, url: 'https://a.test/missing' } },
  }
  const result = map(payload, 'https://a.test/missing')
  assert.equal(result.statusCode, 404)
  assert.equal(result.body.content, 'Not found page')
})

test('reports the final URL after a redirect', () => {
  const payload = {
    success: true,
    data: { markdown: 'body', metadata: { statusCode: 200, url: 'https://final.test/page' } },
  }
  assert.equal(map(payload, 'http://original.test/page').url, 'https://final.test/page')
})

test('falls back to the request URL and 200 when metadata is absent', () => {
  const result = map({ success: true, data: { markdown: 'body' } }, 'https://asked.test')
  assert.equal(result.url, 'https://asked.test')
  assert.equal(result.statusCode, 200)
})

test('throws when success is false even on an HTTP 200', () => {
  assert.throws(() => map({ success: false, error: 'boom', code: 'BAD_REQUEST' }), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_ERROR')
    assert.match(error.message, /boom/)
    assert.match(error.message, /BAD_REQUEST/)
    return true
  })
})

test('throws when the markdown body is blank', () => {
  const payload = { success: true, data: { markdown: '   ', metadata: { statusCode: 200 } } }
  assert.throws(() => map(payload), /no readable content/)
})

test('keeps the machine-readable code and drops an absent one cleanly', () => {
  assert.equal(describeFailure(429, { error: 'slow down', code: 'RATE_LIMITED' }), 'slow down [RATE_LIMITED]')
  assert.equal(describeFailure(500, { error: 'boom' }), 'boom')
  assert.equal(describeFailure(500, undefined), 'Firecrawl scrape failed (HTTP 500)')
})

test('retries only the statuses that can succeed on another attempt', () => {
  for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(isRetryableStatus(status), true, String(status))
  for (const status of [400, 401, 402, 403, 404]) assert.equal(isRetryableStatus(status), false, String(status))
})

test('lets a permanent failure code override a retryable status', () => {
  // Measured: an unreachable address answers 500 SCRAPE_ALL_ENGINES_FAILED, and
  // every attempt retries the same engines against the same address.
  assert.equal(isRetryableFailure(500, { code: 'SCRAPE_ALL_ENGINES_FAILED' }), false)
  assert.equal(isRetryableFailure(503, { code: 'THIRD_PARTY_DATA_NOT_FOUND' }), false)
  assert.equal(isRetryableFailure(403, { code: 'THIRD_PARTY_DATA_TERMS_REQUIRED' }), false)
  assert.equal(isRetryableFailure(404, { code: 'UNKNOWN_PROVIDER' }), false)
})

test('still retries a retryable status when the body carries no permanent code', () => {
  assert.equal(isRetryableFailure(500, undefined), true)
  assert.equal(isRetryableFailure(500, { error: 'boom' }), true)
  assert.equal(isRetryableFailure(429, { code: 'RATE_LIMITED' }), true)
  // Firecrawl documents request_unresolved as "keep the same request and retry".
  assert.equal(isRetryableFailure(503, { code: 'request_unresolved' }), true)
})

test('a non-retryable status stays non-retryable whatever the code says', () => {
  assert.equal(isRetryableFailure(401, { code: 'request_unresolved' }), false)
  assert.equal(isRetryableFailure(400, { code: 'SOMETHING_NEW' }), false)
  assert.equal(isRetryableFailure(404, undefined), false)
})

test('honours the wait Firecrawl reports in the body', () => {
  assert.equal(retryDelayMs({ retry_after_seconds: 3 }, 1), 3000)
  assert.equal(retryDelayMs({ retry_after_seconds: 0 }, 1), 0)
})

test('stops retrying when the reported wait exceeds the ceiling', () => {
  const tooLong = FIRECRAWL_MAX_RETRY_WAIT_MS / 1000 + 1
  assert.equal(retryDelayMs({ retry_after_seconds: tooLong }, 1), undefined)
})

test('backs off exponentially when no wait is reported', () => {
  assert.equal(retryDelayMs(undefined, 1), 1000)
  assert.equal(retryDelayMs(undefined, 2), 2000)
  assert.equal(retryDelayMs(undefined, 3), 4000)
  assert.equal(retryDelayMs(undefined, 5), undefined)
})

test('ignores an unusable retry hint and falls back to backoff', () => {
  assert.equal(retryDelayMs({ retry_after_seconds: 'soon' }, 1), 1000)
  assert.equal(retryDelayMs({ retry_after_seconds: -1 }, 1), 1000)
})

test('applies defaults and accepts an override for every field', () => {
  assert.deepEqual(resolveOptions('key'), {
    apiKey: 'key',
    baseURL: 'https://api.firecrawl.dev',
    timeoutMs: 25000,
    maxAttempts: 3,
    maxResponseBytes: 16777216,
    maxCharacters: 100000,
    onlyMainContent: true,
  })
  assert.deepEqual(
    resolveOptions('key', { baseURL: 'https://proxy.test', timeoutMs: 5000, maxAttempts: 1, onlyMainContent: false, maxAgeMs: 0 }),
    { apiKey: 'key', baseURL: 'https://proxy.test', timeoutMs: 5000, maxAttempts: 1, maxResponseBytes: 16777216, maxCharacters: 100000, onlyMainContent: false, maxAgeMs: 0 },
  )
})

test('keeps maxAgeMs only when the row sets it', () => {
  assert.equal('maxAgeMs' in resolveOptions('key'), false)
  assert.equal(resolveOptions('key', { maxAgeMs: 0 }).maxAgeMs, 0)
  assert.equal(resolveOptions('key', { maxAgeMs: 172800000 }).maxAgeMs, 172800000)
})

test('accepts waitForMs only inside Firecrawl limits', () => {
  assert.equal('waitForMs' in resolveOptions('key'), false)
  assert.equal(resolveOptions('key', { waitForMs: 0 }).waitForMs, 0)
  assert.equal(resolveOptions('key', { waitForMs: 60000, timeoutMs: 70000 }).waitForMs, 60000)
  assert.throws(() => resolveOptions('key', { waitForMs: 60001 }), /waitForMs/)
  assert.throws(() => resolveOptions('key', { waitForMs: -1 }), /waitForMs/)
  assert.throws(() => resolveOptions('key', { waitForMs: 1.5 }), /waitForMs/)
})

test('accepts tag filters only as non-empty string lists', () => {
  assert.equal('includeTags' in resolveOptions('key'), false)
  assert.deepEqual(resolveOptions('key', { includeTags: ['article'] }).includeTags, ['article'])
  assert.deepEqual(resolveOptions('key', { excludeTags: ['nav', 'footer'] }).excludeTags, ['nav', 'footer'])
  assert.throws(() => resolveOptions('key', { includeTags: [] }), /includeTags/)
  assert.throws(() => resolveOptions('key', { includeTags: 'article' }), /includeTags/)
  assert.throws(() => resolveOptions('key', { excludeTags: ['  '] }), /excludeTags/)
})

test('builds the scrape body from resolved options', () => {
  assert.deepEqual(scrapeRequestBody('https://a.test', resolveOptions('key')), {
    url: 'https://a.test',
    formats: ['markdown'],
    timeout: 24000,
    onlyMainContent: true,
  })
  assert.deepEqual(
    scrapeRequestBody('https://a.test', resolveOptions('key', {
      onlyMainContent: false,
      maxAgeMs: 0,
      waitForMs: 2500,
      includeTags: ['main'],
      excludeTags: ['aside'],
    })),
    {
      url: 'https://a.test',
      formats: ['markdown'],
    timeout: 24000,
      onlyMainContent: false,
      maxAge: 0,
      waitFor: 2500,
      includeTags: ['main'],
      excludeTags: ['aside'],
    },
  )
})

test('omits unset optional fields instead of sending null', () => {
  const body = scrapeRequestBody('https://a.test', resolveOptions('key'))
  for (const field of ['maxAge', 'waitFor', 'includeTags', 'excludeTags']) {
    assert.equal(field in body, false, field)
  }
})

test('rejects an unusable key, endpoint, deadline, attempts, flag, and age', () => {
  assert.throws(() => resolveOptions(undefined), /apiKey/)
  assert.throws(() => resolveOptions(42), /apiKey/)
  assert.throws(() => resolveOptions('key', { baseURL: 'not a url' }), /baseURL/)
  assert.throws(() => resolveOptions('key', { timeoutMs: 0 }), /timeoutMs/)
  assert.throws(() => resolveOptions('key', { maxAttempts: 0 }), /maxAttempts/)
  assert.throws(() => resolveOptions('key', { maxAttempts: 6 }), /maxAttempts/)
  assert.throws(() => resolveOptions('key', { onlyMainContent: 'yes' }), /onlyMainContent/)
  assert.throws(() => resolveOptions('key', { maxAgeMs: -1 }), /maxAgeMs/)
  assert.throws(() => resolveOptions('key', { maxAgeMs: 1.5 }), /maxAgeMs/)
})

test('counts the whole fetch budget, and leaves room for the next attempt', () => {
  // Regression: the deadline covers the WHOLE fetch, so a wait must fit in what
  // is LEFT *and* leave time for the retried request. A 25s fetch with 1.2s
  // requests and 11s waits overran, and the third attempt spent an expired
  // signal, reporting a timeout instead of the provider's 429.
  const timeoutMs = 25000
  const request = 1200
  const fits = (wait, elapsed) => retryFitsDeadline(wait, timeoutMs, elapsed, request)

  // 25 - 1.2 = 23.8s left; an 10s wait plus a 1.2s request fits.
  assert.equal(fits(10000, request), true)
  // 25 - (1.2+10+1.2) = 12.6s left; 10s + 1.2s still fits.
  assert.equal(fits(10000, request + 10000 + request), true)
  // 25 - (1.2+11+1.2) = 11.6s left; 11s + 1.2s = 12.2s does NOT fit, so the
  // retry must not start rather than sleep into an expired deadline.
  assert.equal(fits(11000, request + 11000 + request), false)
  assert.equal(fits(10000, 13400), true)
})

test('the boundary is exact: the wait plus one attempt must be strictly inside', () => {
  const timeoutMs = 25000
  const attempt = 1000
  // 3000 remaining: 2000 + 1000 == 3000 is not strictly inside, so refused;
  // 1999 + 1000 = 2999 is.
  assert.equal(retryFitsDeadline(2000, timeoutMs, 22000, attempt), false)
  assert.equal(retryFitsDeadline(1999, timeoutMs, 22000, attempt), true)
  // 5000 remaining: 3999 + 1000 = 4999 fits, 4000 + 1000 = 5000 does not.
  assert.equal(retryFitsDeadline(3999, timeoutMs, 20000, attempt), true)
  assert.equal(retryFitsDeadline(4000, timeoutMs, 20000, attempt), false)
})

test('without an attempt estimate the wait alone must fit', () => {
  assert.equal(retryFitsDeadline(4999, 25000, 20000), true)
  assert.equal(retryFitsDeadline(5000, 25000, 20000), false)
  assert.equal(retryFitsDeadline(30000, 25000, 0), false)
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


test('validates native cleanliness, proxy, cache-only and PDF parser options', () => {
  for (const field of ['onlyCleanContent', 'blockAds', 'removeBase64Images', 'storeInCache']) {
    assert.throws(() => resolveOptions('key', { [field]: 'yes' }), new RegExp(field))
    assert.equal(resolveOptions('key', { [field]: false })[field], false)
  }
  assert.equal(resolveOptions('key', { proxy: 'enhanced' }).proxy, 'enhanced')
  assert.throws(() => resolveOptions('key', { proxy: 'stealth' }), /proxy/)
  assert.equal(resolveOptions('key', { pdfMaxPages: 10000 }).pdfMaxPages, 10000)
  assert.throws(() => resolveOptions('key', { pdfMaxPages: 10001 }), /pdfMaxPages/)
  assert.throws(() => resolveOptions('key', { pdfMaxPages: 0 }), /pdfMaxPages/)
  assert.throws(() => resolveOptions('key', { minAgeMs: 0 }), /minAgeMs/)
  assert.equal(resolveOptions('key', { minAgeMs: 1 }).minAgeMs, 1)
  assert.throws(() => resolveOptions('key', { includeTags: new Array(1) }), /includeTags/)
})

test('clamps server timeout to the remaining budget and official API bounds', () => {
  assert.equal(scrapeRequestBody('https://a.test', resolveOptions('key'), 8000).timeout, 7000)
  assert.equal(scrapeRequestBody('https://a.test', resolveOptions('key'), 500).timeout, 1000)
  assert.equal(scrapeRequestBody('https://a.test', resolveOptions('key', { timeoutMs: 400000 })).timeout, 300000)
  assert.throws(() => resolveOptions('key', { waitForMs: 24000 }), /waitForMs/)
})

test('forwards native options and preserves image OCR with a PDF page limit', () => {
  const body = scrapeRequestBody('https://a.test', resolveOptions('key', {
    onlyCleanContent: true, removeBase64Images: true, blockAds: false, proxy: 'basic',
    pdfMaxPages: 3, minAgeMs: 1, storeInCache: false,
  }))
  assert.equal(body.onlyCleanContent, true)
  assert.equal(body.removeBase64Images, true)
  assert.equal(body.blockAds, false)
  assert.equal(body.proxy, 'basic')
  assert.equal(body.minAge, 1)
  assert.equal(body.storeInCache, false)
  assert.deepEqual(body.parsers, [{ type: 'pdf', maxPages: 3 }, 'image'])
})

test('uses the longest valid retry hint from body and headers', () => {
  assert.equal(retryDelayMs({ retry_after_seconds: 1 }, 1, 3000), 3000)
  assert.equal(retryDelayMs({ retry_after_seconds: 4 }, 1, 3000), 4000)
  assert.equal(retryDelayMs(undefined, 1, 13000), undefined)
})

test('validates metadata and preserves legitimate empty resource responses', () => {
  for (const statusCode of [404, 204, 205, 304]) {
    assert.equal(map({ success: true, data: { markdown: '', metadata: { statusCode } } }).statusCode, statusCode)
  }
  for (const statusCode of [null, '404', 99, 600, 200.5]) {
    assert.throws(() => map({ success: true, data: { markdown: 'body', metadata: { statusCode } } }), /invalid target HTTP status/)
  }
  for (const finalUrl of ['file:///tmp/a', 'https://user:pass@a.test', 42]) {
    assert.throws(() => map({ success: true, data: { markdown: 'body', metadata: { url: finalUrl } } }), /invalid final URL/)
  }
})

test('marks only actual local cuts or confirmed PDF page loss as truncated', () => {
  const atCap = mapScrapeResponse({ success: true, data: { markdown: 'abc' } }, 'https://a.test', makeError, 3)
  assert.equal(atCap.truncated, false)
  const cut = mapScrapeResponse({ success: true, data: { markdown: 'abcd' } }, 'https://a.test', makeError, 3)
  assert.equal(cut.truncated, true)
  assert.equal(cut.body.content, 'abc')
  assert.equal(map({ success: true, data: { markdown: 'page', metadata: { numPages: 1, totalPages: 2 } } }).truncated, true)
  assert.equal(map({ success: true, data: { markdown: 'page', metadata: { numPages: 1 } } }).truncated, false)
})
