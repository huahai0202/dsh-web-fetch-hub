import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, channelEnabled, CHANNELS } from '../index.js'

/** A context that records every provider the hub registers. */
function context(credentials, environment) {
  const registered = []
  return {
    get: name => name === 'credentials' ? credentials : undefined,
    launchEnvironment: { get: ref => environment?.[ref] === undefined ? undefined : { value: environment[ref] } },
    web: { registerFetchProvider: value => registered.push(value) },
    registered,
  }
}

const environment = { EXA_API_KEY: 'exa-key', FIRECRAWL_API_KEY: 'firecrawl-key' }

test('registers nothing until a channel is switched on', () => {
  const ctx = context()
  apply(ctx, {})
  assert.deepEqual(ctx.registered, [])
})

test('registers only the channel its config names', () => {
  const onlyExa = context()
  apply(onlyExa, { exa: {} })
  assert.deepEqual(onlyExa.registered.map(p => p.id), ['exa-fetch'])

  const onlyFirecrawl = context()
  apply(onlyFirecrawl, { firecrawl: {} })
  assert.deepEqual(onlyFirecrawl.registered.map(p => p.id), ['firecrawl'])
})

test('registers both channels when both are configured', () => {
  const ctx = context()
  apply(ctx, { exa: {}, firecrawl: {} })
  assert.deepEqual(ctx.registered.map(p => p.id).sort(), ['exa-fetch', 'firecrawl'])
  // Each keeps its own picker title, so the menu still tells them apart.
  assert.deepEqual(ctx.registered.map(p => p.title).sort(), ['Exa Contents API', 'Firecrawl Scrape API'])
})

test('each channel reads its own key from the same context', async () => {
  const ctx = context(undefined, environment)
  apply(ctx, { exa: {}, firecrawl: {} })
  const exa = ctx.registered.find(p => p.id === 'exa-fetch')
  const firecrawl = ctx.registered.find(p => p.id === 'firecrawl')
  // Each channel resolves its own reference from one shared launch environment.
  assert.equal(await exa.ready(), true)
  assert.equal(await firecrawl.ready(), true)
})

test('one channel reports unready when only the other key is configured', async () => {
  const ctx = context(undefined, { EXA_API_KEY: 'exa-key' })
  apply(ctx, { exa: {}, firecrawl: {} })
  const exa = ctx.registered.find(p => p.id === 'exa-fetch')
  const firecrawl = ctx.registered.find(p => p.id === 'firecrawl')
  assert.equal(await exa.ready(), true)
  assert.equal(await firecrawl.ready(), false)
})

test('a channel marked disabled stays out even when its key is set', () => {
  const ctx = context()
  apply(ctx, { exa: { enabled: false }, firecrawl: {} })
  assert.deepEqual(ctx.registered.map(p => p.id), ['firecrawl'])
})

test('channelEnabled accepts a bare on-switch and refuses off states', () => {
  // Anything present and not an explicit off state switches the channel on, so a
  // row can be `exa: {}`, `exa: true`, or carry real settings.
  for (const on of [{}, true, 1, 'yes', { timeoutMs: 5000 }]) {
    assert.equal(channelEnabled({ exa: on }, 'exa'), true, JSON.stringify(on))
  }
  // Absent and explicit off states leave the channel out.
  for (const off of [undefined, null, false]) {
    assert.equal(channelEnabled({ exa: off }, 'exa'), false, JSON.stringify(off))
  }
  assert.equal(channelEnabled({ exa: { enabled: false } }, 'exa'), false)
  assert.equal(channelEnabled({}, 'exa'), false)
  assert.equal(channelEnabled(undefined, 'exa'), false)
})

test('the channel ids are the ones a profile selects with fetchProvider', () => {
  // These strings are the contract with the profile's `web` row; a rename here
  // would silently break an existing `fetchProvider` value.
  assert.deepEqual(CHANNELS.map(c => c.id), ['exa-fetch', 'firecrawl'])
  assert.deepEqual(CHANNELS.map(c => c.configKey), ['exa', 'firecrawl'])
})

test('a per-channel config still reaches that channel row', () => {
  const ctx = context()
  apply(ctx, { firecrawl: { timeoutMs: 5000, maxAttempts: 1 } })
  assert.equal(ctx.registered.length, 1)
  assert.equal(ctx.registered[0].id, 'firecrawl')
})
