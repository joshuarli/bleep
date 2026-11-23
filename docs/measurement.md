# Measurement reference

This page defines what blip monitor measures, how it classifies each request, and how it computes every displayed figure. The code is the source of truth: `src/measure/` for measurement and `src/export/` for files.

## Metric

The primary metric is browser-observed HTTP request turnaround. The page reads `performance.now()` immediately before `fetch`, and again after `response.text()` resolves. Parsing, validation, and rendering happen after the second reading, so they are not included.

Turnaround includes DNS, connection setup when one is needed, TLS, routing, geography, the provider's edge and runtime, the response body transfer, and browser scheduling. The monitor does not subtract server execution time, and it does not drop slow samples.

## Probe request

Each probe is `GET /probe?id=<id>`, where `id` is 22 base64url characters from 128 random bits. The request uses `cache: "no-store"`, `credentials: "omit"`, `redirect: "manual"`, `mode: "cors"`, and no custom headers, so the browser sends no preflight.

A successful response body is exactly `{"v":1,"id":"<id>"}` and is byte-identical on both providers. Responses carry `Cache-Control: no-store`, `CDN-Cache-Control: no-store`, `Vercel-CDN-Cache-Control: no-store`, `Access-Control-Allow-Origin: *`, and these metadata headers:

| Header | Meaning |
| --- | --- |
| `x-blip-provider` | `cloudflare` or `vercel` |
| `x-blip-runtime` | `workers` or `node-fluid` |
| `x-blip-location` | Cloudflare: the data center (`colo`) that ran the Worker. Vercel: the function's execution region from `VERCEL_REGION`. `unknown` when the platform does not say. |
| `x-blip-location-kind` | `colo` or `execution-region` |
| `x-blip-revision` | the Git revision the backend was built from |
| `cf-ray`, `x-vercel-id` | raw platform identifiers, stored as received and never parsed |

## Outcomes

Every sent request ends in exactly one outcome. Only `ok` has a latency.

| Outcome | When |
| --- | --- |
| `ok` | Status 200, a `basic` or `cors` response, the exact expected body, and the expected `x-blip-provider` |
| `timeout` | No complete response within 3,000 ms, including the body |
| `network_error` | `fetch` rejected for any other reason |
| `http_error` | Any status other than 200 |
| `invalid_response` | An opaque redirect, an opaque response, a body that is not the exact expected body (wrong ID, HTML, challenge page, malformed JSON), or another provider's response |
| `cancelled` | The page aborted the request because you stopped, paused, or hid the tab |

A request the browser blocks for CORS is indistinguishable from a network failure, so it is reported as `network_error`.

Scheduled slots that were never sent are `unsent`, with one of these reasons:

| Reason | When |
| --- | --- |
| `concurrency_cap` | The destination already had 4 requests in flight |
| `deadline_missed` | The page woke more than `min(interval / 2, 100 ms)` after the slot's deadline |
| `scheduler_gap` | The page woke more than 1,000 ms late, usually because the browser suspended it. One record covers the whole gap per destination. |

These are failed requests, not packet loss. Each probe is an application request over a reliable transport, so a lost packet shows up as extra latency or a timeout, never as a missing sample.

## Sampling

| Setting | Value |
| --- | --- |
| Normal rate | 5 requests per second per destination |
| Low rate | 1 per second per destination |
| Burst | 20 per second for 30 s, then the selected rate. Another burst is available 60 s after a burst ends. |
| Timeout | 3,000 ms per request |
| In-flight cap | 4 per destination |
| Session length | 10 minutes. Each extension adds 10 minutes, up to 60 minutes. |
| Retained records | 36,000 attempts or unsent ranges. Older records are discarded, and the page and exports report how many. |

Requests follow fixed deadlines on the page's monotonic clock, not animation frames. A late page dispatches at most the current slot and marks earlier slots `unsent`. It never sends catch-up traffic. Each destination has its own cap and timeout, so a stalled destination never delays the other.

When the tab is hidden, the page cancels in-flight requests and pauses. When the tab is visible again, it resumes in a new segment without catching up. Paused time stays on the graph's time axis and is not counted as unsent. Long main-thread tasks reported by the browser are recorded as annotations. They suggest browser delay, but they cannot fully separate browser delay from network delay.

Each attempt records whether it was the first request to that destination in the run, and whether no request went to that destination for at least 5 s before it. These flags are not cold starts, and they do not mean a fresh TCP or TLS connection.

## Statistics

Percentiles use nearest rank: the value at 1-based rank `ceil(q × n)` of the sorted `ok` latencies. The median is `q = 0.5` and the 95th percentile is `q = 0.95`. The monitor shows no p99 and no jitter figure.

Every latency figure appears beside its counts:

- **Attempted:** sent requests other than `cancelled`.
- **Failed:** `timeout`, `network_error`, `http_error`, and `invalid_response`, each also shown separately.
- **Cancelled** and **not sent:** shown separately and never counted as failures.
- **Coverage:** `ok / (attempted + unsent)`. A destination with many failures has low coverage even when its successful requests are fast.
- **Achieved rate:** requests sent divided by measured time, excluding pauses and the compare warm-up.

## Comparison

Compare mode sends to both destinations on shared slots. Each pair has a `pairSeq` and one intended dispatch time. Both requests launch without waiting for each other. Cloudflare goes first on even `pairSeq` and Vercel on odd.

- **Pairing:** by `pairSeq` only, never by arrival order.
- **Dispatch skew:** the absolute difference of the two actual dispatch times. Pairs over 5 ms stay in the raw data and counts, are flagged, and are left out of the median paired difference.
- **Paired difference:** `Vercel duration − Cloudflare duration`, only for pairs where both are `ok`. A positive value means Vercel took longer.
- **Median paired difference:** the nearest-rank median of paired differences. The monitor never shows a p95 of paired differences or a difference of p95s.
- **Pair categories:** `both_ok`, `cloudflare_only`, `vercel_only`, `neither_valid` (both sent, neither `ok`), and `not_fully_sent` (a side unsent and no side `ok`).
- **Warm-up:** each compare run starts with a fixed 10 s warm-up. Warm-up samples are kept and drawn, and they are left out of summaries.

The comparison cannot isolate JavaScript runtime performance. It includes routing, geography, transport behavior, browser scheduling, and platform handling.

When both destinations spike together, the pattern is consistent with a shared influence, such as the local network. When one destination spikes alone, that is a difference worth investigating. The monitor does not assign blame to a router, ISP, or provider, and it makes no claims of statistical significance.

## Segments

A segment is a stretch of measurements that may be pooled. A new segment starts at a new run, a resume after a pause, a change in a destination's reported location, a change in backend revision, or a new marker. A segment is flagged when a backend revision differs from the page's own revision, and the page shows a warning.

A window that spans segments shows one row per segment and no pooled figure.

## UI host

Each run records the page's origin, and each attempt records whether the probe was same-origin or cross-origin. Results from different UI hosts are never pooled. Report UI-host sensitivity when the sign of the median paired difference flips between hosts, or when its magnitude changes by more than `max(2 ms, 20%)`.

## Markers, intervals, and baseline

A marker starts an interval that runs to the next marker or to the end of the data. Markers also start new segments.

An experiment has one baseline interval, locked once set. Clearing it starts a new experiment ID. Baseline deltas are `interval median − baseline median` and `interval p95 − baseline p95`, per destination. They appear beside the raw latency, failures, and coverage, never instead of them.

## Export format

JSON exports have `schemaVersion: 1`. CSV exports have one row per record with `record_type` set to `run`, `attempt`, `unsent_range`, `marker`, or `segment`. CSV fields follow RFC 4180, and text that starts with `=`, `+`, `-`, `@`, a tab, a carriage return, or `'` gets a leading `'` so spreadsheets do not run it as a formula.

Times are milliseconds on the page's monotonic clock. Add them to `timeOriginWallMs` (JSON) or `time_origin_wall_ms` (CSV run rows) for wall-clock time. The JSON export also holds the summary the page displayed. `node scripts/summarize-export.ts --check <files>` recomputes that summary from the JSON and from the CSV beside it, and fails if either differs.

JSON-only fields are `events` (pauses, resumes, rate changes, and long tasks), `pairs`, and `displayed`. The CSV carries pause boundaries through `segment` rows whose `start_reasons` include `resume`.
