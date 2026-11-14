/**
 * One bundle for the third-party fetch channels in the web capability seam
 * (`ctx.web`): Exa Contents and Firecrawl scrape.
 *
 * Both channels register under the ids they always had, so a profile keeps
 * choosing between them with `fetchProvider` on the `web` row and nothing about
 * the selection changes. What consolidation buys is one install, one key store to
 * read, and one copy of the transport layer.
 *
 * A channel registers only when its row config enables it, so an operator who
 * never configured Firecrawl never sees it in the provider picker, and the seam's
 * "exactly one usable provider" rule keeps working for a single-channel setup.
 *
 * @module dsh-web-fetch-hub
 */

import { createExaProvider, EXA_FETCH_PROVIDER_ID } from './providers/exa.js'
import { createFirecrawlProvider, FIRECRAWL_FETCH_PROVIDER_ID } from './providers/firecrawl.js'

export const name = 'web-fetch-hub'

/** The web seam this bundle registers its channels into. */
export const inject = ['web']

/**
 * The channels this bundle can mount, keyed by the provider id a profile selects
 * with `fetchProvider`. Each entry names the config switch that enables it, so a
 * channel that is off stays out of the picker rather than appearing unusable.
 */
const CHANNELS = [
  {
    id: EXA_FETCH_PROVIDER_ID,
    label: 'Exa Contents API',
    configKey: 'exa',
    create: createExaProvider,
  },
  {
    id: FIRECRAWL_FETCH_PROVIDER_ID,
    label: 'Firecrawl Scrape API',
    configKey: 'firecrawl',
    create: createFirecrawlProvider,
  },
]

/**
 * Whether a channel's row config turns it on. A channel is on when its config key
 * is present and not explicitly disabled; `false` and `{ enabled: false }` both
 * turn it off, so an operator can keep one channel's settings while parking it.
 *
 * @param config - the hub row config.
 * @param configKey - the channel's key inside that config.
 * @returns whether the channel registers.
 */
export function channelEnabled(config, configKey) {
  const value = config?.[configKey]
  if (value === undefined || value === null || value === false) return false
  if (typeof value === 'object' && value.enabled === false) return false
  return true
}

/**
 * Register every enabled channel with `ctx.web`.
 *
 * @param ctx - context whose `web` registry receives the providers.
 * @param config - the hub row config, one key per channel.
 */
export function apply(ctx, config = {}) {
  for (const channel of CHANNELS) {
    if (!channelEnabled(config, channel.configKey)) continue
    // A channel's own row keeps its shape, so an existing per-channel config
    // moves into this bundle unchanged.
    const channelConfig = typeof config[channel.configKey] === 'object' ? config[channel.configKey] : {}
    ctx.web.registerFetchProvider(channel.create(ctx, channelConfig))
  }
}

export { CHANNELS }
