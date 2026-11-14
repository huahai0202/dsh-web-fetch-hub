# 验证记录

日期：2026-11-14。版本：1.0.0。

本文件记录合并后的验证结果。两个渠道的服务端行为、参数含义与取舍见
[DETAIL.md](./DETAIL.md)，配置与迁移见 [README.md](../README.md)。

## 合并验证

合并前后测试总数一致，**没有因为重构丢掉任何用例**：

| 测试文件 | 用例数 | 来源 |
|---|---:|---|
| `hub.test.mjs` | 9 | 新增：渠道注册与开关 |
| `exa-mapping.test.mjs` | 23 | 迁移，内容未改 |
| `exa-provider.test.mjs` | 28 | 迁移，仅改装配入口 |
| `firecrawl-mapping.test.mjs` | 32 | 迁移，内容未改 |
| `firecrawl-provider.test.mjs` | 32 | 迁移，仅改装配入口 |
| **合计** | **124** | 原两包合计 115 + 新增 9 |

两个 provider 测试不再直接调用各自的 `apply`，而是通过 hub 的 `apply`
挂载（`applyHub(ctx, { exa: config })`），因此测试走的是真实的注册路径。

### 真实 API 验证

两个渠道在合并包中同时注册并各自成功抓取：

| 渠道 | 注册 id | ready | 状态码 | 正文字符数 | 耗时（秒） |
|---|---|---|---:|---:|---:|
| Exa | `exa-fetch` | true | 200 | 172 | 7.05 |
| Firecrawl | `firecrawl` | true | 200 | 959 | 1.43 |

Exa 该次耗时偏高属单次波动；同一页面的多次测量见下节各渠道记录。

### 渠道 id 未变

这是合并的关键约束：`fetchProvider` 里写的是 `exa-fetch` 或 `firecrawl`，
两个独立包原本就是这两个值，因此已安装的 profile **不需要改配置行**。
`hub.test.mjs` 中有一条专门断言这两个 id 与 `configKey` 的映射，
若有人改动 id，测试会立即失败。

## 渠道：Exa Contents（0.4.1 记录）

### 不可用地址不再重试

`isRetryableContentsStatus` 原先用"临时 crawl 标签 **或** 上游 HTTP 状态"
判定，两个信号是或关系。现在 tag 只在明确属于临时性 crawl 结果时放行
（`CRAWL_TIMEOUT`、`CRAWL_UNKNOWN_ERROR`），上游状态作为独立条件保留：
目标返回 503/429 仍然重试。`UNSUPPORTED_URL`、`CRAWL_NOT_FOUND`、
`INVALID_URL` 及任何未知标签一律首次即失败。

修正过程中曾误把临时标签白名单当成唯一判据，导致 `CRAWL_HTTP_503`
（目标返回 503）不再重试——该用例由既有测试捕获。两条信号都必须保留。

### 参数在部分页面上不改变输出

`verbosity` 三档、`includeSections`、`excludeSections` 对同一页面均返回
14432 字符。已排除是本插件的问题：打印插件构建的请求体，各字段全部正确出现；
以 curl 直接请求 Exa API 结果一致。官方文档亦说明
"Some pages may produce identical standard and full output"。
**不应当据此判断配置是否失效。**

### 实测

| 场景 | 状态码 | 正文字符数 | 耗时（秒） |
|---|---:|---:|---:|
| 简单 HTML | 200 | 172 | 2.14 |
| 404 页 | — | `CRAWL_NOT_FOUND` 失败 | 6.62 |
| JS 渲染页 | 200 | 14432 | 0.57 |
| 重定向 http→https | 200 | 898 | 1.54 |
| 中文页面 | 200 | 520 | 0.63 |
| 真实 PDF（arXiv 论文） | 200 | 42464 | 1.90 |
| 内网地址 | — | `UNSUPPORTED_URL`，1 次请求 | 1.06 |
| 畸形 URL | — | `WEB_INVALID_URL`，**0 次请求** | 0 |
| 极小 `maxCharacters` | 200 | 100，`truncated: true` | 1.29 |

## 渠道：Firecrawl Scrape（0.3.1 记录）

### 永久失败码不再重试

不可达地址（内网主机、断网）返回 **HTTP 500 + `SCRAPE_ALL_ENGINES_FAILED`**。
此前 5xx 仅按状态码判定为可重试，于是每次尝试都用同样的引擎重试同一个地址。
`isRetryableFailure(status, payload)` 现在同时读 `code`：
`SCRAPE_ALL_ENGINES_FAILED`、`THIRD_PARTY_DATA_NOT_FOUND`、
`THIRD_PARTY_DATA_TERMS_REQUIRED`、`UNKNOWN_PROVIDER` 即使伴随 5xx 也立即失败；
`request_unresolved` 保持可重试（官方要求"沿用同一请求重试"）；
不带永久码的裸 5xx 仍然重试。

| 场景 | 修正前 | 修正后 |
|---|---:|---:|
| 内网地址 | 3 次请求 / 5.7 秒 | **1 次请求 / 2.5 秒** |

### 逐项探测的错误码

| 输入 | HTTP | code | 可重试 |
|---|---:|---|---|
| 内网 `127.0.0.1` | 500 | `SCRAPE_ALL_ENGINES_FAILED` | 否 |
| 畸形 URL | 400 | `BAD_REQUEST` | 否 |
| 非 http(s) 协议 | 400 | `BAD_REQUEST` | 否 |
| 无效密钥 | 401 | （无 code） | 否 |
| 不存在的域名 | 200 | （无 code，`success: true`） | — |

最后一行值得留意：不存在的域名返回 HTTP 200 且 `success: true`，只是
`markdown` 为空。本渠道因此以"无可读内容"失败，行为正确，但排查
"抓取成功却没内容"时，根因在服务端的这个假成功。

### 实测

| 场景 | 状态码 | 正文字符数 | 耗时（秒） |
|---|---:|---:|---:|
| 简单 HTML | 200 | 959 | 1.07 |
| 404 页 | 404 | 959 | 0.40 |
| JS 渲染页 | 200 | 19041 | 0.75 |
| 重定向 http→https | 200 | 8410 | 1.05 |
| 中文页面 | 200 | 971 | 1.32 |
| 真实 PDF（arXiv 论文） | 200 | 44520 | 8.70 |
| 内网地址 | — | 失败，1 次请求 | 1.26 |
| 畸形 URL | — | `WEB_INVALID_URL`，**0 次请求** | 0 |
| `onlyMainContent: false` | 200 | 15445 | 2.37 |
| 极小 `maxCharacters` | 200 | 100，`truncated: true` | 2.35 |

两个观察：`onlyMainContent` 对同一页面从 959 增至 15445 字符，默认开启合理；
单行 PDF 夹具只产出 17 字符，换成真实论文后为 44520 字符——**用夹具判断解析
能力容易得出错误结论**。

### 限流

13 个连续场景在一分钟内打满每分钟 12 次的配额。批量抓取需自行节流或升级套餐；
本渠道按约定"失败即报错、有限重试、不阻塞"，不内置令牌桶。
`retry_after_seconds` 超过 12 秒上限时只发 1 次请求即返回。

## 两个渠道的实测差异

| | Exa | Firecrawl |
|---|---|---|
| 目标 404 | 报错 `CRAWL_NOT_FOUND` | 返回状态码 404 与正文 |
| 内网失败耗时 | 1.06 秒 | 2.5 秒 |
| JS 页面耗时 | 0.57 秒 | 0.75 秒 |
| 每分钟请求上限 | 未见限制（18 次连发无 429） | 约 12 次，超出返回 429 |
| PDF 解析 | 42464 字符 | 44520 字符 |

按键只在内存中读取，未写入代码或本记录。
