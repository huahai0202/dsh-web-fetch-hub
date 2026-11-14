# Third-party fetch channels

One bundle registering the two third-party `ctx.web` fetch providers. This document
covers what each channel does, its settings, and the approximations it makes; the
selection contract lives in [README.md](../README.md).

## Exa Contents API — `exa-fetch`

Exa crawls the page (or serves it from its cache) and returns reader-ready text
that it extracted itself. The seam receives `kind: 'text'`, so the tool's
HTML→Markdown step never runs for this channel.

### Settings

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | `EXA_API_KEY` | Sent as `Authorization: Bearer`. |
| `baseURL` | `https://api.exa.ai` | API origin; `/contents` is the operation. |
| `maxCharacters` | `100000` | Per-page text budget, at most 5000000. |
| `verbosity` | `standard` | `compact`, `standard`, or `full`. |
| `linkStyle` | `full` | `full` or `citation`; how inline links are rendered. |
| `includeSections` / `excludeSections` | omitted | Semantic section filters: `header`, `navigation`, `banner`, `body`, `sidebar`, `footer`, `metadata`. |
| `timeoutMs` | `25000` | Provider-side deadline for the whole fetch. |
| `maxAttempts` | `3` | Attempts per fetch, at most 5. |
| `maxAgeHours` | omitted | `0` forces a live fetch, `-1` uses only the cache. |
| `livecrawlTimeoutMs` | API default | How long a live fetch may take. |

`verbosity` and the section filters change nothing on some pages — Exa documents
that "some pages may produce identical standard and full output". That is the
service, not a broken setting: the same request body against the API directly gives
the same result. See [VERIFICATION.zh.md](./VERIFICATION.zh.md).

### Approximations

- **Target HTTP status.** A successful Contents call reports `200`. Exa exposes
  only its own per-URL status, so a page that itself returns 404 still arrives as
  retrieved. A failed retrieval is an error carrying Exa's tag, for example
  `CRAWL_NOT_FOUND, HTTP 404`.
- **Final URL.** Exa echoes the requested URL, not the address after the target's
  redirects.
- **Truncation.** Exa reports no truncation flag; a body that reaches
  `maxCharacters` is treated as cut.

## Firecrawl Scrape API — `firecrawl`

Firecrawl scrapes through its own engines and returns markdown plus metadata, so
this channel fills the two fields a direct fetch cannot reconstruct: the target's
own status and the final URL after redirects.

### Settings

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | `FIRECRAWL_API_KEY` | Sent as `Authorization: Bearer`. |
| `baseURL` | `https://api.firecrawl.dev` | API origin; `/v2/scrape` is the operation. |
| `timeoutMs` | `25000` | Per-attempt deadline, kept under the tool-call budget. |
| `maxAttempts` | `3` | Attempts per fetch, at most 5. |
| `onlyMainContent` | `true` | Drop headers, navs, and footers before markdown. |
| `maxAgeMs` | omitted | Firecrawl's cache window; `0` demands a fresh scrape. |
| `minAgeMs` | omitted | Cache-only read: never triggers a scrape. |
| `waitForMs` | omitted | Extra wait before reading, 0–60000. |
| `includeTags` / `excludeTags` | omitted | Keep or drop rendered element selectors. |
| `maxCharacters` | `100000` | Local cap on returned markdown. |
| `pdfMaxPages` | omitted | Page limit for PDF parsing. |
| `onlyCleanContent`, `blockAds`, `removeBase64Images`, `proxy`, `storeInCache` | omitted | Firecrawl pass-throughs; each adds cost or latency. |

### Retry boundary

`408`, `429`, `5xx` retry; authentication, billing, and permanent errors do not.
The response body's `code` can veto a retryable status: `SCRAPE_ALL_ENGINES_FAILED`
arrives as a `500` for an unreachable address and every attempt would retry the
same engines against the same target. `request_unresolved` stays retryable because
Firecrawl documents it as "keep the same request and retry".

### Approximations

- **Truncation.** Firecrawl reports no truncation flag; `truncated` reflects only
  the local `maxCharacters` cap and the parsed PDF page limit.
- **Body kind.** Output is always `text`: Firecrawl converts to markdown itself.

## Keys

Both channels read their key on every fetch: the channel's own `apiKey`, then the
credentials seam (`$DSH_HOME/.credentials.yaml`, which outranks the launch snapshot
and reloads on change), then the launching environment. A key added to `.env` while
the app runs is not visible until the next start.

## Cost

- Exa: about `$0.001` per page of text.
- Firecrawl: one credit per page, billed per PDF page, and a 404 still bills a
  credit because the error page comes back as content. Its account also limits
  requests per minute, so bulk work needs its own throttling.
