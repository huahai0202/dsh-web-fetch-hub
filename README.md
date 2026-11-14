# dsh-web-fetch-hub

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek_Harness-plugin-black.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![Dependencies](https://img.shields.io/badge/dependencies-none-brightgreen.svg)](./package.json)

Two third-party fetch channels for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) in one
bundle: [Exa Contents](https://exa.ai/docs/contents/quickstart) and
[Firecrawl scrape](https://docs.firecrawl.dev/api-reference/endpoint/scrape).

This package replaces installing `dsh-web-fetch-exa` and `dsh-web-fetch-firecrawl`
separately. The channel **ids are unchanged**, so a profile that already selects a
channel with `fetchProvider` keeps working without touching that line.

## Why one bundle

The two channels had become the same shape: identical `transport.js`, identical
test scaffolding, identical credential resolution. Only the request body and the
response mapping differ. Consolidating removes that duplication and gives one place
to read keys from.

## Install

```sh
git clone https://github.com/huahai0202/dsh-web-fetch-hub.git
dsh plugin --profile <name> add ./dsh-web-fetch-hub
```

## Enable the channels you want

The bundle's patch turns Exa on and leaves Firecrawl off:

```yaml
- insert:
    - id: web-fetch-hub
      name: 'dsh-web-fetch-hub'
      config:
        exa: {}
```

Add a `firecrawl` key to register both. A channel is on when its key is present
and not disabled; `firecrawl: {}` or `firecrawl: true` both work, and
`firecrawl: { enabled: false }` parks it while keeping its settings.

A channel that is off never registers, so it does not appear in the provider picker
and does not affect the seam's "exactly one usable provider" rule.

## Choose the active channel

Unchanged from the separate bundles: set `fetchProvider` on the profile's `web`
row to a channel id.

```yaml
- id: web
  config:
    searchProvider: exa
    fetchProvider: firecrawl     # or: exa-fetch, http, deepseek-fetch-api
```

| channel id | picker title | what it is |
|---|---|---|
| `exa-fetch` | Exa Contents API | reader-ready text; no target status |
| `firecrawl` | Firecrawl Scrape API | real target status and final URL |

Both stay registered; only the selection moves, so switching costs one line and no
restart of the bundle.

## Keys

Each channel resolves its own key on every fetch, in this order:

1. `apiKey` in that channel's config
2. the credentials seam — `EXA_API_KEY` / `FIRECRAWL_API_KEY` in
   `$DSH_HOME/.credentials.yaml`, which outranks the launch snapshot and reloads
   when the file changes
3. the launching environment

Prefer the credentials store. `.env` is read into an immutable snapshot at launch,
so a key added there while the app runs does not arrive until the next start.

## Channel settings

Each channel's own fields live under its key, unchanged from the standalone
packages.

```yaml
- id: web-fetch-hub
  name: 'dsh-web-fetch-hub'
  config:
    exa:
      verbosity: standard
      maxAttempts: 3
    firecrawl:
      onlyMainContent: true
      maxAttempts: 3
      waitForMs: 1500
```

Per-channel fields, defaults, and the deliberate approximations each one makes are
in [docs/DETAIL.md](docs/DETAIL.md).

## Tests

```sh
node --import ./tests/register.mjs tests/hub.test.mjs
node --import ./tests/register.mjs tests/exa-mapping.test.mjs
node --import ./tests/register.mjs tests/exa-provider.test.mjs
node --import ./tests/register.mjs tests/firecrawl-mapping.test.mjs
node --import ./tests/register.mjs tests/firecrawl-provider.test.mjs
```

124 checks: 9 covering this bundle's channel registration, and the 115 the two
standalone packages had, moved here unchanged.

## Migrating from the separate packages

1. Install this bundle.
2. Remove `dsh-web-fetch-exa` and `dsh-web-fetch-firecrawl` from the profile.
3. Move each old row's config under `exa:` / `firecrawl:` in this bundle's row.
4. Keep `fetchProvider` as it is.

The channel ids did not change, so step 4 needs no edit.

## License

MIT
