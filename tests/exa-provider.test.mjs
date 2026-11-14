import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ExaFetchProvider, EXA_FETCH_PROVIDER_ID } from '../providers/exa.js'
import { resolveOptions, contentsRequestBody } from '../providers/exa-mapping.js'
import { createDeadline, retryAfterMs, jitterDelayMs } from '../transport.js'
import { apply as applyHub } from '../index.js'

/** Mount this channel through the hub, the way a profile row does. */
const apply = (ctx, config = {}) => applyHub(ctx, { exa: config })

const url = 'https://a.test'
const key = 'fixture-key'
const makeError = (message, code, options) => Object.assign(new Error(message, options), { code })
const provider = (config = {}, readKey = async () => key) => new ExaFetchProvider(readKey, value => resolveOptions(value, config))
const payload = (content = 'body') => ({ statuses: [{ id: url, status: 'success' }], results: [{ url, text: content }] })
const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers })
const codeIs = code => error => error.code === code

function context(credentials, environment) {
  let registered
  return {
    get: name => name === 'credentials' ? credentials : undefined,
    launchEnvironment: { get: reference => environment?.[reference] === undefined ? undefined : { value: environment[reference] } },
    web: { registerFetchProvider: value => { registered = value } },
    provider: () => registered,
  }
}

test('registers the native id and rejects a malformed row at mount', () => {
  const ctx = context()
  apply(ctx)
  assert.equal(ctx.provider().id, EXA_FETCH_PROVIDER_ID)
  assert.equal(typeof ctx.provider().ready, 'function')
  assert.throws(() => apply(ctx, { timeoutMS: 2 }), /timeoutMS/)
  assert.throws(() => apply(ctx, { apiKey: 42 }), /apiKey/)
})

test('missing credentials recover on the next readiness check without remounting', async t => {
  let current = ''
  let calls = 0
  const p = provider({}, async () => current)
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response(payload()) })
  assert.equal(p.available(), true)
  assert.equal(await p.ready(), false)
  await assert.rejects(p.fetch({ url }), codeIs('WEB_PROVIDER_CREDENTIAL_MISSING'))
  current = key
  assert.equal(p.available(), true)
  assert.equal(await p.ready(), true)
  assert.equal((await p.fetch({ url })).body.content, 'body')
  current = ''
  assert.equal(await p.ready(), false)
  assert.equal(p.available(), true)
  assert.equal(calls, 1)
})

test('literal row credentials outrank store and environment and are trimmed', async t => {
  const ctx = context({ resolve: () => { throw new Error('store must not be read') } }, { EXA_API_KEY: 'environment' })
  apply(ctx, { apiKey: '  literal  ' })
  t.mock.method(globalThis, 'fetch', async (_endpoint, init) => {
    assert.equal(init.headers.authorization, 'Bearer literal')
    return response(payload())
  })
  await ctx.provider().fetch({ url })
})

test('managed credentials are re-read per fetch and fall back to launch environment', async t => {
  let current = 'managed-one'
  const seen = []
  const ctx = context({ resolve: async () => current === undefined ? undefined : { value: current } }, { EXA_API_KEY: 'environment' })
  apply(ctx, { apiKey: '  ' })
  t.mock.method(globalThis, 'fetch', async (_endpoint, init) => {
    seen.push(init.headers.authorization)
    return response(payload())
  })
  await ctx.provider().fetch({ url })
  current = 'managed-two'
  await ctx.provider().fetch({ url })
  current = undefined
  await ctx.provider().fetch({ url })
  assert.deepEqual(seen, ['Bearer managed-one', 'Bearer managed-two', 'Bearer environment'])
})

test('readiness keeps credential-store errors visible for fetch to report', async () => {
  const fault = new Error('credential store unavailable')
  const p = provider({}, async () => { throw fault })
  assert.equal(await p.ready(), true)
  await assert.rejects(p.fetch({ url }), error => error === fault)
})

test('validates target URLs before reading credentials or issuing requests', async t => {
  let reads = 0
  const p = provider({}, async () => { reads++; return key })
  t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected fetch') })
  for (const bad of [undefined, 'not a URL', 'file:///tmp/a', 'https://user:password@a.test', 'https://a.test/' + 'a'.repeat(8192)]) {
    await assert.rejects(p.fetch({ url: bad }), codeIs('WEB_INVALID_URL'))
  }
  assert.equal(reads, 0)
})

test('sends the expected operation, auth and body without local-only options', async t => {
  const config = { baseURL: 'https://proxy.test/api///', maxCharacters: 1000, maxAgeHours: 0, verbosity: 'compact', linkStyle: 'full', includeSections: ['body'], excludeSections: ['navigation'] }
  const p = provider(config)
  t.mock.method(globalThis, 'fetch', async (endpoint, init) => {
    assert.equal(endpoint, 'https://proxy.test/api/contents')
    assert.equal(init.method, 'POST')
    assert.equal(init.redirect, 'error')
    assert.equal(init.headers.authorization, 'Bearer ' + key)
    const body = JSON.parse(init.body)
    const expected = contentsRequestBody(url, resolveOptions(key, config))
    assert.ok(body.livecrawlTimeout > 0 && body.livecrawlTimeout <= expected.livecrawlTimeout)
    expected.livecrawlTimeout = body.livecrawlTimeout
    assert.deepEqual(body, expected)
    assert.equal('maxResponseBytes' in body, false)
    assert.equal('maxAttempts' in body, false)
    return response(payload())
  })
  await p.fetch({ url })
})

test('snapshots options and selector arrays before asynchronous credential reads', async t => {
  const config = { maxCharacters: 100, includeSections: ['body'] }
  let resolveKey
  const p = provider(config, () => new Promise(resolve => { resolveKey = resolve }))
  t.mock.method(globalThis, 'fetch', async (endpoint, init) => {
    assert.equal(endpoint, 'https://api.exa.ai/contents')
    const body = JSON.parse(init.body)
    assert.equal(body.text.maxCharacters, 100)
    assert.deepEqual(body.text.includeSections, ['body'])
    return response(payload())
  })
  const pending = p.fetch({ url })
  await Promise.resolve()
  config.baseURL = 'https://changed.test'
  config.maxCharacters = 200
  config.includeSections.push('footer')
  resolveKey(key)
  await pending
})

test('retries transient API statuses, preserving one credential snapshot', async t => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    let calls = 0
    let reads = 0
    const p = provider({}, async () => { reads++; return key })
    t.mock.method(globalThis, 'fetch', async () => ++calls === 1
      ? response({ error: 'temporary', retry_after_seconds: 0 }, status, { 'retry-after': '0' })
      : response(payload()))
    assert.equal((await p.fetch({ url })).statusCode, 200)
    assert.equal(calls, 2)
    assert.equal(reads, 1)
  }
})

test('does not retry authentication, billing, or permanent API errors', async t => {
  for (const status of [400, 401, 402, 403, 404, 422]) {
    let calls = 0
    t.mock.method(globalThis, 'fetch', async () => { calls++; return response({ error: 'permanent' }, status) })
    await assert.rejects(provider().fetch({ url }), codeIs('WEB_PROVIDER_ERROR'))
    assert.equal(calls, 1)
  }
})

test('honors attempt caps and long retry hints without masking the API failure', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response({ error: 'quota exhausted' }, 429, { 'retry-after': '0' }) })
  await assert.rejects(provider({ maxAttempts: 2 }).fetch({ url }), /quota exhausted/)
  assert.equal(calls, 2)
  calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response({ error: 'wait for quota' }, 429, { 'retry-after': '13' }) })
  await assert.rejects(provider().fetch({ url }), /wait for quota/)
  assert.equal(calls, 1)
})

test('declines a retry that cannot fit in the total deadline', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response({ error: 'retry later' }, 503, { 'retry-after': '1' }) })
  await assert.rejects(provider({ timeoutMs: 30 }).fetch({ url }), /retry later/)
  assert.equal(calls, 1)
})

test('deadline includes an uncooperative credential read', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected fetch') })
  await assert.rejects(provider({ timeoutMs: 20 }, () => new Promise(() => {})).fetch({ url }), codeIs('WEB_FETCH_TIMEOUT'))
})

test('caller cancellation interrupts credential reads and observes late rejections', async () => {
  let rejectKey
  const p = provider({}, () => new Promise((_resolve, reject) => { rejectKey = reject }))
  const controller = new AbortController()
  const pending = p.fetch({ url }, controller.signal)
  await Promise.resolve()
  controller.abort()
  await assert.rejects(pending, codeIs('WEB_ABORTED'))
  rejectKey(new Error('late credential failure'))
  await Promise.resolve()
})

test('deadline interrupts an uncooperative transport', async t => {
  t.mock.method(globalThis, 'fetch', () => new Promise(() => {}))
  await assert.rejects(provider({ timeoutMs: 20 }).fetch({ url }), codeIs('WEB_FETCH_TIMEOUT'))
})

test('caller cancellation wins before the provider deadline', async t => {
  const controller = new AbortController()
  t.mock.method(globalThis, 'fetch', () => { controller.abort(); return new Promise(() => {}) })
  await assert.rejects(provider().fetch({ url }, controller.signal), codeIs('WEB_ABORTED'))
})

test('timeouts during successful and failed response bodies preserve the timeout code', async t => {
  for (const status of [200, 429]) {
    let cancelled = 0
    let calls = 0
    t.mock.method(globalThis, 'fetch', async () => {
      calls++
      return new Response(new ReadableStream({ cancel() { cancelled++ } }), { status })
    })
    await assert.rejects(provider({ timeoutMs: 20 }).fetch({ url }), codeIs('WEB_FETCH_TIMEOUT'))
    assert.equal(cancelled, 1)
    assert.equal(calls, 1)
  }
})

test('caller cancellation during body reading cancels the reader', async t => {
  const controller = new AbortController()
  let cancelled = 0
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start() { setTimeout(() => controller.abort(), 5) },
    cancel() { cancelled++ },
  })))
  await assert.rejects(provider().fetch({ url }, controller.signal), codeIs('WEB_ABORTED'))
  assert.equal(cancelled, 1)
})

test('rejects declared and streamed oversize bodies and releases the stream', async t => {
  for (const declared of [false, true]) {
    let cancelled = 0
    t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('a'.repeat(33))) },
      cancel() { cancelled++ },
    }), { headers: declared ? { 'content-length': '33' } : {} }))
    await assert.rejects(provider({ maxResponseBytes: 32 }).fetch({ url }), codeIs('WEB_FETCH_TOO_LARGE'))
    assert.equal(cancelled, 1)
  }
})

test('byte caps count UTF-8 bytes and accept an exactly full JSON response', async t => {
  const encoded = new TextEncoder().encode(JSON.stringify(payload('中文')))
  t.mock.method(globalThis, 'fetch', async () => new Response(encoded))
  assert.equal((await provider({ maxResponseBytes: encoded.length }).fetch({ url })).body.content, '中文')
  await assert.rejects(provider({ maxResponseBytes: encoded.length - 1 }).fetch({ url }), codeIs('WEB_FETCH_TOO_LARGE'))
})

test('invalid success JSON fails once; unreadable gateway bodies still retry', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('{broken') })
  await assert.rejects(provider().fetch({ url }), /unprocessable/)
  assert.equal(calls, 1)
  calls = 0
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1
    ? new Response('<html>gateway error</html>', { status: 502, headers: { 'retry-after': '0' } })
    : response(payload()))
  await provider().fetch({ url })
  assert.equal(calls, 2)
})

test('known permanent DNS failures are not retried', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new TypeError('fetch failed', { cause: Object.assign(new Error('DNS'), { code: 'ENOTFOUND' }) }) })
  await assert.rejects(provider().fetch({ url }), codeIs('WEB_PROVIDER_ERROR'))
  assert.equal(calls, 1)
})

test('redacts a key echoed by a custom API error', async t => {
  t.mock.method(globalThis, 'fetch', async () => response({ error: 'bad token ' + key }, 401))
  await assert.rejects(provider().fetch({ url }), error => {
    assert.equal(error.message.includes(key), false)
    assert.match(error.message, /REDACTED/)
    return error.code === 'WEB_PROVIDER_ERROR'
  })
})

test('one cancelled concurrent fetch does not cancel another', async t => {
  const controller = new AbortController()
  let calls = 0
  let resolveStarted
  const started = new Promise(resolve => { resolveStarted = resolve })
  t.mock.method(globalThis, 'fetch', async () => {
    if (++calls === 1) { resolveStarted(); return new Promise(() => {}) }
    return response(payload('second'))
  })
  const p = provider()
  const first = p.fetch({ url }, controller.signal)
  const second = p.fetch({ url })
  await started
  controller.abort()
  await assert.rejects(first, codeIs('WEB_ABORTED'))
  assert.equal((await second).body.content, 'second')
})

test('retry waits stop at the total deadline and preserve the first abort reason', async () => {
  const deadline = createDeadline(undefined, 20, makeError)
  try { await assert.rejects(deadline.sleep(1000), codeIs('WEB_FETCH_TIMEOUT')) }
  finally { deadline.dispose() }
  const controller = new AbortController()
  const first = createDeadline(controller.signal, 10, makeError)
  try {
    controller.abort()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(first.abortError().code, 'WEB_ABORTED')
  } finally { first.dispose() }
})

test('parses retry hints and adds bounded non-negative jitter', () => {
  assert.equal(retryAfterMs('1.25'), 1250)
  assert.equal(retryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:27:58 GMT')), 2000)
  assert.equal(retryAfterMs('-1'), undefined)
  assert.equal(retryAfterMs('bad header'), undefined)
  assert.equal(jitterDelayMs(1000, 12000, () => 0.5), 1125)
  assert.equal(jitterDelayMs(12000, 12000, () => 0.5), 12000)
})

test('retries documented transient per-URL failures inside API HTTP 200', async t => {
  for (const tag of ['CRAWL_TIMEOUT', 'CRAWL_UNKNOWN_ERROR', 'CRAWL_HTTP_503']) {
    let calls = 0
    t.mock.method(globalThis, 'fetch', async () => ++calls === 1
      ? response({ statuses: [{ id: url, status: 'error', error: { tag, httpStatusCode: tag === 'CRAWL_HTTP_503' ? 503 : undefined } }], results: [] }, 200, { 'retry-after': '0' })
      : response(payload()))
    assert.equal((await provider().fetch({ url })).body.content, 'body')
    assert.equal(calls, 2)
  }
})

test('does not repeat not-found, unsupported-url, or configured livecrawl timeout failures', async t => {
  // UNSUPPORTED_URL arrives with no `httpStatusCode`, so it can only be excluded
  // by its tag: the address is unusable, and another attempt cannot change that.
  for (const [tag, httpStatusCode] of [
    ['CRAWL_NOT_FOUND', 404],
    ['UNSUPPORTED_URL', undefined],
    ['CRAWL_LIVECRAWL_TIMEOUT', undefined],
    ['INVALID_URL', undefined],
  ]) {
    let calls = 0
    t.mock.method(globalThis, 'fetch', async () => { calls++; return response({ statuses: [{ id: url, status: 'error', error: { tag, httpStatusCode } }], results: [] }) })
    await assert.rejects(provider().fetch({ url }), new RegExp(tag))
    assert.equal(calls, 1, `${tag} must not be retried`)
  }
})
