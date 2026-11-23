# blip monitor campaign

## Status

- **Goal:** a browser network-responsiveness monitor, deployed to Cloudflare and Vercel from one revision, that shows both destinations on one timeline during controlled experiments and exports reproducible evidence.
- **Last accepted revision:** `6588059` (M3, milestone M-A passed).
- **Accepted:** F0, L0, M1, M2, M3.
- **Red:** none.
- **Parked:** none.
- **Next slice:** H1, then X1, then U1.
- **First command:** `npm ci && npm run accept:foundation`
- **Live:** `https://blip-monitor.joshua-r-li-98.workers.dev` and `https://blip-monitor.vercel.app`, both at `7b5c342`, Vercel observed in `sfo1`. `node scripts/deploy.ts all` deploys the clean HEAD; `node scripts/verify-live.ts --contract|--all` checks it.
- **Decisions later slices depend on:** builds read `BLIP_TARGET` (`production`, `local`, `fixture`, default `local`) through `scripts/stamp.ts`; the deploy script forces `production`. Fixture endpoints are `127.0.0.1:8791` (Cloudflare) and `127.0.0.1:8792` (Vercel); local endpoints are `8787` and `8788`. "Attempted" counts sent requests other than `cancelled`; cancellations and unsent slots are reported separately, and coverage is `ok / (attempted + unsent)`. Lanes were not used: each slice was cheaper serially.

The campaign answers two questions:

1. Which of these deployed destinations is more responsive from this browser and network?
2. When responsiveness deteriorates during an experiment, does it affect both destinations at the same time?

The final acceptance is that the owner can open either hosted page, run a controlled network experiment, see precisely when responsiveness deteriorates, and export enough evidence to compare the result with a later run.

## Charter

- This document and the repo are the executor's complete brief. Decide and keep going. Record a decision here only when a later slice depends on it.
- The owner's grant covers local work, local commits on `master`, and the deployments in **Execution boundary**. Park anything that needs more authority.
- Hard stops park the item and let other work continue: an action outside **Execution boundary**, an irreversible action, or a loop that cannot check anything.
- Never push. The repo has no remote.
- Build parity and completeness first. Performance budgets are measured and logged until O1, except for the egregious-problem thresholds below.
- Fix these on sight in their own commit: a slice acceptance command over 2 minutes, `npm test` over 60 seconds, a UI frame task over 250 ms at default rates, unbounded growth in any buffer or timer set, or any path that can record a failure as a successful latency. Record anything else in the final report and leave it.
- For a failing item, establish the cause before retrying (`root-cause`). After 3 attempts, park it on `park/<item>` with the cause and a retry condition. A shared environment blocker gets one owner.
- Run the [parent steering checkpoint](/Users/josh/.claude/skills/orchestrate/references/campaigns.md#parent-steering-checkpoint) after each accepted slice. Rewrite **Status** only; never append logs or checkpoints.
- Run the parallel sets named in **Sequence** in worktrees at `.work/wt/<lane>`, following the `orchestrate` worktree lifecycle. Everything else runs serially. `package.json`, `package-lock.json`, `tsconfig.json`, and `plan.md` have one writer, the parent.
- Use Conventional Commits with the workstream as scope: `foundation`, `measure`, `ui`, `export`, `deploy`, `docs`. Put the item ID in the commit body. Code comments never cite this document.
- Keep scratch in `.work/tmp`, which is disposable. Durable evidence goes under `docs/evidence/`.
- Do not run formatters.

## Decisions

### Owner

| ID | Decision (2026-11-23) |
| --- | --- |
| O-1 | The campaign may create and deploy dedicated `blip-monitor` projects on the owner's Cloudflare and Vercel accounts as public, anonymous endpoints. Quota exhaustion by third parties is an accepted risk. |
| O-2 | Use the `cf` CLI for every Cloudflare operation. Do not use Wrangler directly or add a `wrangler.*` config. |
| O-3 | Check useful spike results in, so the campaign starts from a working foundation. |

### Prescribed: architecture

| ID | Decision | Reason, and what would reverse it |
| --- | --- | --- |
| A-1 | One repo, one Vite + TypeScript frontend, no runtime dependencies, Canvas for graphs. | Smallest design meeting the drafts. |
| A-2 | `src/probe/handler.ts` is the only probe implementation. `worker/index.ts` and `api/probe.ts` only supply `ProbeSite`. | Prevents contract drift. |
| A-3 | No database, Durable Objects, queues, accounts, server-side history, upstream fetches, storage access, or per-probe application logging. | Required by both drafts. |
| A-4 | Cloudflare keeps default placement, with no Smart Placement or regional placement. | The Worker has no backend to move toward. |
| A-5 | Vercel runs Node 24 on Fluid with `regions: ["sfo1"]` and `fluid: true`. If `sfo1` is unavailable or the observed region differs after the remedy in L0, park Vercel deployment and report it. Never substitute a region. | Vercel's default is `iad1`. |
| A-6 | The build revision comes from `scripts/stamp.ts`, because CLI deployments without a connected Git repo cannot rely on `VERCEL_GIT_COMMIT_SHA`. Deployment refuses a `-dirty` revision. | One mechanism for both providers. |
| A-7 | Endpoints are fixed at build time in `src/config/endpoints.ts`, with `production`, `local`, and `fixture` maps selected by `BLIP_TARGET`, which `scripts/stamp.ts` writes to build info. The page never accepts an endpoint from a URL or user input. | Prevents misdirected probes and mislabeled evidence. |
| A-8 | Use `agent-browser` for browser proof, driven by `scripts/browser/check.ts`. Do not add Playwright. | Already installed and proven here, and avoids a large dependency. |
| A-9 | Tests use `node:test`. Measurement logic takes injected clock, timer, fetch, and visibility interfaces. | Deterministic lifecycle tests with no new dependency. |
| A-10 | CORS is `Access-Control-Allow-Origin: *` without credentials. | Responses carry no private data, and an allowlist would not limit non-browser quota use. |
| A-11 | Add no rate limiter in this campaign. | It needs storage or account-level configuration. Reverse if real abuse appears. |

### Prescribed: probe protocol

Implemented in F0. Changing it requires updating `test/probe-contract.ts` and both adapters together.

- **Request:** `GET /probe?id=<id>`. `id` is exactly 22 base64url characters from 128 random bits, and no other query parameter is allowed.
- **Client options:** `cache: "no-store"`, `credentials: "omit"`, `redirect: "manual"`, `mode: "cors"`, no custom request headers.
- **Success body:** exactly `{"v":1,"id":"<id>"}`, byte-identical across providers.
- **Errors:** malformed input returns 400 and unsupported methods return 405, both with CORS and no-store headers.
- **Cache headers:** `Cache-Control`, `CDN-Cache-Control`, and `Vercel-CDN-Cache-Control` are all `no-store`.
- **Metadata headers:** `x-blip-provider`, `x-blip-runtime`, `x-blip-location`, `x-blip-location-kind`, and `x-blip-revision`. Raw `x-vercel-id` and `cf-ray` are exposed when present.
- **Location meaning:** Cloudflare `colo` is the observed Cloudflare data center. Vercel `execution-region` comes from `VERCEL_REGION`. Retain raw `x-vercel-id` separately and never parse it. Keep ingress information and execution location in separate fields.
- **Resource Timing:** optional detail. Missing fields are `null`, meaning unknown. Record `nextHopProtocol` only when the browser provides it.

### Prescribed: measurement

| ID | Decision |
| --- | --- |
| M-1 | The primary metric is browser-observed HTTP request turnaround. Start `performance.now()` immediately before `fetch`, and stop after `response.text()` resolves, before parsing or rendering. |
| M-2 | Attempt outcomes are the closed set `ok`, `timeout`, `network_error`, `http_error`, `invalid_response`, `cancelled`. Scheduled slots that were never sent are `unsent`, with reason `concurrency_cap`, `deadline_missed`, or `scheduler_gap`. |
| M-3 | `ok` requires status 200, a basic or cors response type, the exact expected body, and the expected provider header. An opaque redirect, wrong ID, HTML, challenge page, or malformed body is `invalid_response`. Any other HTTP status is `http_error`. A CORS rejection is indistinguishable from `network_error`, and the docs say so. |
| M-4 | Only `ok` has a latency value. Never record a failure as zero or as the timeout deadline. Do not subtract Worker execution time. Do not filter slow samples. |
| M-5 | Call failures "failed requests", never "packet loss". Explain that these are application requests over a reliable transport. |
| M-6 | Rates: normal 5 Hz per endpoint, low 1 Hz, diagnostic burst 20 Hz for 30 seconds with a 60-second cooldown, after which the selected rate resumes. Show target and achieved rates, per endpoint and aggregate. |
| M-7 | Sessions default to 10 minutes. "Extend" adds 10 minutes, up to 60 minutes total. |
| M-8 | Each endpoint has its own 3,000 ms timeout, in-flight cap of 4, and deadlines. A stall on one endpoint never delays the other. |
| M-9 | Scheduling uses intended monotonic deadlines, independent of rendering. A slot is late when dispatch would be more than `min(interval / 2, 100 ms)` after its deadline. On wake, each endpoint dispatches at most its current slot, and earlier slots become `unsent`. No catch-up traffic. |
| M-10 | A wake gap over 1,000 ms creates one `scheduler_gap` record per endpoint holding the slot range and count, so a sleeping laptop cannot flood the buffer. Annotate it as suspected browser suspension. Annotate `longtask` entries where supported. Never claim this perfectly separates browser delay from network delay. |
| M-11 | Hidden document: cancel in-flight work, mark an explicit pause, and resume on visibility in a new run segment without catch-up. Paused time remains visible on the time axis and is not counted as missed slots. |
| M-12 | Each start gets a run ID. A completion whose run ID or request token is stale is dropped. Stop and pause abort requests and clear timers. |
| M-13 | The ring buffer holds 36,000 attempt or unsent-range records. The UI and exports state the retained time range and the number of discarded records. Clear Resource Timing entries after reading them. |
| M-14 | Percentiles use nearest rank: the value at 1-based rank `ceil(q * n)` of sorted `ok` latencies. Median is `q = 0.5`. |
| M-15 | Omit p99 and any jitter metric in this delivery. Few trustworthy numbers were preferred, and both drafts make them optional. |
| M-16 | Every latency statistic is displayed with its successful count, attempted denominator, failures, unsent count, and coverage. Coverage is `ok / (attempted + unsent)`. A destination with many failures must not look healthy. |
| M-17 | Retain first-in-run and first-after-idle flags, where idle means no dispatch to that endpoint for at least 5 seconds. Never call them cold starts, and never claim a fresh TCP or TLS connection. |

### Prescribed: comparison

| ID | Decision |
| --- | --- |
| C-1 | Modes are Cloudflare only, Vercel only, and Compare both. |
| C-2 | In Compare, each pair has a shared `pairSeq` and intended dispatch time. Both fetches launch without awaiting either. Even `pairSeq` dispatches Cloudflare first, odd dispatches Vercel first. |
| C-3 | Pairing is by `pairSeq` only, never by arrival order. |
| C-4 | Dispatch skew is the absolute difference of actual dispatch times. Tolerance is 5 ms. Over-tolerance pairs remain in raw data and counts, are flagged, and are excluded from the median paired difference. |
| C-5 | `difference = Vercel duration − Cloudflare duration`, for pairs where both are `ok`. Positive means Vercel took longer. |
| C-6 | Pair categories are `both_ok`, `cloudflare_only`, `vercel_only`, `neither_valid` (both attempted, neither valid), and `not_fully_sent` (at least one side unsent and no valid side). Display all with counts. |
| C-7 | Show per-endpoint p95 and median paired difference. Label them precisely. Do not show p95 of paired differences or a difference of p95s. |
| C-8 | Compare runs begin with a fixed 10-second warm-up on both endpoints. It is retained, marked, and excluded from sustained summaries. It is never extended. |
| C-9 | Segments split on endpoint location, backend revision, UI-versus-backend revision mismatch, or experiment phase. A selected interval that spans segments shows per-segment rows and no pooled figure. |
| C-10 | The baseline is one marked interval per experiment and is locked once set. Clearing it starts a new experiment ID. Baseline deltas are `phase median − baseline median` and `phase p95 − baseline p95`, per endpoint, shown beside raw latency and failures. |
| C-11 | Wording: coincident spikes are "consistent with a shared influence". One-destination spikes are "a difference worth investigating". Never assign blame to a router, ISP, or provider. Make no statistical significance claims. |
| C-12 | Record UI origin and same-origin or cross-origin per probe. Results from different UI hosts are never pooled. Report **UI-host sensitivity** when the sign of the median paired difference flips between hosts, or its magnitude changes by more than `max(2 ms, 20%)`. |
| C-13 | The comparison cannot isolate JavaScript runtime performance. It includes routing, geography, transport behavior, browser scheduling, and platform handling. The UI and docs say so. |

### Delegated

| Area | Bound | Tie-break |
| --- | --- | --- |
| Internal module layout | Inside the slice's owned paths | Fewer files |
| Visual design | Must meet U1–U3 acceptance, readable at 390 px wide, failures distinguishable without color | Plain and dense over decorative |
| Ring buffer representation | Meets M-13 and the memory budget | Simpler structure |
| Marker UI details | Preset labels below, all editable | Fewest controls |

## Baseline

- **Known red:** none at `0c20283`.
- **Expected noise:** `npm install` prints an `EBADENGINE` warning on local Node 26 because deployed functions pin Node 24. npm also reports skipped install scripts. Neither fails the build.
- **Local-only caveat:** `cf dev` can report a real-looking colo such as `SJC`. Treat all local output as simulated.

| Loop | Time |
| --- | --- |
| `npm install` from lockfile | 3 s |
| `npm run accept:foundation` | 4.3 s |
| `vercel build --prod --yes` with a temporary local project link | 1.9 s |

Proven on this machine before planning:

- The shared handler passes the contract under `workerd` through `cf dev`, in the Node test harness, and from a local `vercel build` bundle.
- A real browser ran all four UI-to-endpoint pairs against local Cloudflare and Node origins with zero `OPTIONS` requests. A custom-header control did trigger a preflight, so the check can fail.
- `cf deploy --dry-run` succeeds, `cf` is authenticated with Workers write scope on one account, and `vercel` is authenticated on a Hobby scope. No `blip` project exists on either provider.

## Sequence

Each slice ends with its acceptance command and `npm run check && npm test` on the integrated tree. Run `npm run accept:foundation` at milestones M-A, M-B, and close.

| ID | Slice | Owns | Needs | Acceptance |
| --- | --- | --- | --- | --- |
| F0 | Foundation (**accepted**) | scaffold | — | `npm run accept:foundation` |
| L0 | First live deploy and endpoint map | `scripts/deploy.ts`, `scripts/verify-live.ts`, `src/config/`, `scripts/stamp.ts` | F0 | `node scripts/verify-live.ts --contract` |
| M1 | Probe client and outcomes | `src/measure/types.ts`, `src/measure/probe-client.ts`, `test/measure/probe-client.test.ts` | F0 | `npm run stamp && node --test test/measure/probe-client.test.ts` |
| M2 | Scheduler, session lifecycle, ring buffer | `src/measure/scheduler.ts`, `session.ts`, `ring.ts`, matching tests | M1 | `npm run stamp && node --test test/measure/session.test.ts test/measure/ring.test.ts` |
| M3 | Statistics, pairing, segments | `src/measure/stats.ts`, `pairs.ts`, `segments.ts`, matching tests | M1 | `npm run stamp && node --test test/measure/stats.test.ts test/measure/pairs.test.ts` |
| H1 | Local stack and fault fixture | `scripts/browser/`, `test/fixtures/` | M1 | `node scripts/browser/check.ts stack` |
| U1 | Live graph and run controls | `src/ui/graph*`, `src/ui/controls*`, `src/ui/main.ts`, `index.html` | M2, M3, H1 | `node scripts/browser/check.ts live` |
| U2 | Summaries and comparison view | `src/ui/summary*`, `src/ui/compare*` | U1 | `node scripts/browser/check.ts compare` |
| U3 | Markers, intervals, baseline | `src/ui/markers*`, `src/measure/intervals.ts` | U2 | `node scripts/browser/check.ts intervals` |
| X1 | JSON and CSV export | `src/export/`, `test/export/` | M2, M3 | `npm run stamp && node --test "test/export/*.test.ts"` |
| X2 | Export UI and displayed-summary reproduction | `src/ui/export*`, `scripts/summarize-export.ts` | U3, X1 | `node scripts/browser/check.ts export` |
| D1 | Measurement and experiment docs | `README.md`, `docs/measurement.md`, `docs/experiments.md` | U3 | `mdtool check --untracked README.md docs/measurement.md docs/experiments.md` |
| L1 | Same-revision deploy and four-way live proof | `scripts/browser/live.ts`, `docs/evidence/` | X2, D1, L0 | `node scripts/verify-live.ts --all` |
| L2 | Repeated live comparison runs | `docs/evidence/` | L1 | `node scripts/summarize-export.ts --check docs/evidence/runs` |
| O1 | Optimization and polish | files named by the measured finding | L2 | `npm run accept:foundation && node scripts/browser/check.ts all` |
| Z1 | Close | any | O1 | see **Close** |

**Parallel sets, each with disjoint files:** `{L0, M1}`, then `{M2, M3}`, then `{H1, X1}` once their prerequisites are accepted. H1 needs only M1, so it may also run beside M2 and M3. All other slices are serial. The parent adds any `package.json` scripts.

**Milestones:** M-A after M3. M-B after X2.

### L0: First live deploy

1. Confirm `git status` is clean, `vercel --version` is `66.6.0`, and `npx cf --version` is `1.0.0-rc.2`.
2. Run `npx cf workers list`. Stop and park if a Worker named `blip-monitor` already exists. Do the same for the Vercel project with `vercel project ls`. Never overwrite an unrelated project.
3. Deploy Cloudflare with `npx cf deploy --message <revision>`. If the account has no workers.dev subdomain, park Cloudflare deployment, because creating one is an account-wide setting, and give the owner the exact step.
4. Create the project with `vercel link --yes --project blip-monitor`, then run `vercel build --prod --yes` and `vercel deploy --prebuilt --prod --yes`.
5. Read the actual production URLs, write them to `src/config/endpoints.ts`, and commit.
6. Verify anonymously with `curl`, from a shell with no provider credentials used: the contract, fresh nonce echoes, `no-store`, CORS on success and errors, and the location.
7. Vercel must report `x-blip-location: sfo1`. The local build output does not record the region, so this is the proof. If it differs, the only permitted remedy is redeploying with `--regions sfo1` or setting this dedicated project's function region to `sfo1`. If it still differs, apply A-5.
8. The Vercel response must not carry `cf-ray`, and must identify Vercel through `server` or `x-vercel-id`. An authentication page, redirect, or challenge fails. If Deployment Protection blocks the production URL, disable protection for this dedicated project only. Never use or embed a bypass secret.

### M1: Probe client

Test that each case in M-2 and M-3 classifies correctly: valid response; timeout; fetch rejection; 500; 404; wrong ID; HTML with status 200; malformed JSON; opaque redirect; caller abort. Assert that timing stops after the body and before parsing, and that non-`ok` outcomes have no latency.

### M2: Scheduler and session

Use a fake clock to prove:

- 5 Hz, 1 Hz, and 20 Hz schedules hit intended deadlines, and a burst returns to the selected rate after 30 seconds and honors the cooldown.
- A blocked timer produces `unsent` records and no catch-up burst.
- A long gap stays on the time axis and creates one bounded range record per endpoint.
- The fourth in-flight request caps an endpoint, later slots are `unsent:concurrency_cap`, and the other endpoint keeps sampling.
- Stop, start, hidden, and visible transitions abort requests and leave zero timers and zero in-flight requests.
- A late response from an earlier run cannot modify a newer run.
- The ring never exceeds capacity and reports discarded records and retained range.
- Default session end, extension, and the 60-minute limit behave as specified.

### M3: Statistics and pairing

Use hand-computed fixtures to prove:

- Known timings produce the expected count, median, p95, and maximum.
- Timeouts and errors never enter latency values.
- A known simulated delay on one endpoint produces the expected signed paired difference.
- Reversed completion order cannot swap or mismatch pairs.
- One side timing out does not block the other, and missing pairs produce no difference.
- Excess skew is flagged and excluded from the median difference.
- Warm-up is excluded from sustained summaries and retained in raw data.
- Pauses, location changes, and revision mismatches split segments.

### H1: Local stack and fault fixture

`scripts/browser/check.ts <scenario>` starts everything it needs, uses an `agent-browser` session named for the scenario, and always cleans up. Fixture servers are clearly labeled simulated and support scripted delay, hang, status, wrong ID, HTML, redirect, and connection close per endpoint. The `stack` scenario proves that the browser reaches both fixture endpoints from both fixture UI origins with zero `OPTIONS` requests, and that it fails if a custom header is added.

### U1: Live graph and controls

Carry these upstream behaviors forward: live continuous plot, three time scales (10 seconds detail, 90 seconds, 15 minutes), logarithmic latency axis, a distinct marker for failures, and click on the graph to pause or resume.

Controls: mode, start, stop, clear, extend, normal rate, low rate, and burst. Use real elapsed time. Show visible gaps for pauses, missing measurements, and failures. Mark endpoint or colo changes. Include a short plain explanation of what the graph measures. Controls are keyboard accessible with visible labels, and failures differ by shape as well as color. The layout works on desktop and at 390 × 844.

The `live` scenario verifies rendered state through a test-readable DOM summary and canvas pixels changing, including pause, resume, a hang gap, and mobile layout with no horizontal overflow.

### U2: Summaries and comparison

Show side by side, per endpoint and for a clearly identified window:

- Current successful latency, successful count, median, p95, maximum.
- Timeouts and other errors with attempted-request denominators, plus separate cancellation and unsent counts.
- Target and achieved rate, requests sent, per-endpoint and aggregate.
- Time since last valid response.
- Endpoint, observed location, configured region, runtime, and deployment revision.

In Compare, overlay both series on one elapsed-time axis with accessible distinctions, and show the median paired difference, valid complete pair count, all C-6 categories, flagged skew count, and warm-up state. Show a visible warning on UI and backend revision mismatch.

### U3: Markers and intervals

Preset editable marker labels: Baseline, Upload started, Download started, Recovery, SQM enabled, SQM disabled, Changed Wi‑Fi, Moved to another room.

Users select two marked intervals and compare duration, successful-latency statistics, failures, and coverage, with both providers visible throughout. Support the sequence idle baseline, external upload, recovery, external download, recovery, then repetition after an SQM or Wi‑Fi change. Baseline deltas follow C-10 and never hide raw latency, failures, or gaps. Labels render as text, never HTML.

### X1 and X2: Export

Exports are user-triggered, local only, and contain no secrets. JSON has `schemaVersion: 1`. CSV has one row per record with a `record_type` of `run`, `attempt`, `unsent_range`, `marker`, or `segment`, RFC 4180 quoting, and spreadsheet-formula neutralization for label text.

Both contain:

- App version, UI origin, and frontend revision.
- Both endpoint URLs, backend revisions, runtime, configured region, observed location, ingress information when available, raw `x-vercel-id` and `cf-ray`, and negotiated protocol when available.
- Pair sequence numbers, intended dispatch times, actual dispatch times, dispatch skew, completion times, durations, outcomes, same-origin or cross-origin, and first-probe flags.
- Warm-up and phase markers, event markers, and interval boundaries.
- Sampling rates, deadlines, timeouts, concurrency limits, and unsent slots.
- Retained time range, discarded count, and whether earlier samples were lost.

X2 proves that `scripts/summarize-export.ts` recomputes the summaries displayed in the UI from each exported format.

### D1: Docs

- `README.md`: what it is, commands, deploy, limitations, attribution.
- `docs/measurement.md`: exact metric, outcomes, formulas, percentiles, coverage, pairing, and every wording limit from M-5, M-17, C-11, and C-13.
- `docs/experiments.md`: the repeatable recipe. Record an idle baseline, generate sustained upload, recover, repeat for download, recover, change SQM, repeat, compare equivalent intervals, and retain exports. Start with a wired baseline before adding Wi‑Fi variables. Keep the monitor visible in another window or split-screen, or generate load from a CLI, native app, or another device, because a load test in another tab hides and pauses the monitor.
- Current request volume and provider allowances, from **Reference**, rechecked before L1.

### L1 and L2: Live proof

L1 deploys one clean revision to both providers and verifies all four UI-to-endpoint arrangements in a real browser: anonymous access, CORS, nonce validation, caching, reported location, no per-probe `OPTIONS`, pause and resume, mobile layout, and export. Save redacted evidence under `docs/evidence/`.

L2 runs 3 two-minute Compare runs from each hosted UI, then writes `docs/evidence/results.md` with the actual environment and location when known, per-UI-host summaries, and C-12 sensitivity. Label them as measurements from this machine and network. Do not claim improvement to the owner's home network. Live verification may use at most 20,000 requests per provider in total.

### O1: Optimization and polish

Measure, then improve only what is over budget:

- First-load JS at or under 50 KB gzip.
- Retained-buffer heap growth at or under 32 MB when full.
- No frame task over 50 ms at default rates on this machine.
- No probe-handler dependency beyond the shared module.

Check `perf-gate-ready` once before timing. If the host is busy, use the busy-host evidence rules in `~/.agents/instructions/performance.md` and label the result.

### Close

1. Delete dead code and unused dependencies, proving liveness with `dead-code-archaeology`.
2. Run the `review` skill as an independent completion review of the full campaign diff, and fix every demonstrated defect.
3. Run `npm run accept:foundation`, `node scripts/browser/check.ts all`, and, if the deployed revision still matches product code, `node scripts/verify-live.ts --all`. Redeploy both providers first if product code changed.
4. Run the campaign closeout from `orchestrate`.
5. Write the final report with:
   - Both live application URLs and both direct probe URLs.
   - The shared Git revision and each provider's deployed version.
   - Evidence that either interface probes both providers directly.
   - Configured and observed locations.
   - Sample exports and a concise explanation of observed results.
   - What was verified locally and in the deployed browser.
   - The measurement definition and material limitations.
   - The short recipe for the owner's Bay Area connection under upload and download load with SQM off and on.
   - Default request volume, current provider allowances, and any concrete remaining limitation.

## Acceptance

| Deliverable | Proof | Must fail when |
| --- | --- | --- |
| Shared probe contract | `npm run accept:foundation` | An adapter changes body, status, or cache/CORS headers |
| Correct outcomes | M1 command | A failure gets a latency or an invalid response counts as `ok` |
| Bounded lifecycle | M2 command | Catch-up traffic, leaked timers, stale completions, or buffer growth |
| Correct statistics and pairing | M3 command | Pairs follow arrival order or a missing side yields a difference |
| Local browser path | `node scripts/browser/check.ts all` | Preflights occur, gaps vanish, or the UI overflows on mobile |
| Reproducible export | X1 and X2 commands | Export loses outcome distinctions, interval boundaries, or displayed summaries |
| Two live providers | `node scripts/verify-live.ts --all` | Revisions differ, Vercel is not `sfo1`, an endpoint is cached or protected, or Vercel is behind Cloudflare |
| Four-way live comparison | L1 evidence | Any UI-to-endpoint arrangement is missing |
| Repeatable evidence | L2 command | Saved exports do not reproduce the reported summaries |

## Needs environment

These do not hold the campaign open.

- **Owner's Bay Area experiment.** Open either live URL, follow `docs/experiments.md` with SQM off and on, and export each run. Then run `node scripts/summarize-export.ts <exports...>`.
- **Physical phone.** Open a live URL on a real phone and confirm layout, pause on background, and export. The campaign proves mobile layout only through browser emulation.

## Execution boundary and non-goals

**Authorized:** local commits on `master`; creating and deploying the Cloudflare Worker `blip-monitor` and the Vercel project `blip-monitor`; project-scoped configuration of those two projects needed by L0; read-only provider queries; anonymous requests to the deployed endpoints within the request budget; exact-version dev dependencies needed by a slice after vetting maintenance, license, and transitive weight, reporting build-time and size impact.

**Forbidden:** pushing; custom domains or DNS changes; account-wide provider settings, including creating a workers.dev subdomain; plan or billing changes; touching any other project; Deployment Protection bypass secrets in code or exports; a third hosting provider; proxying one provider through the other; committing credentials or `.vercel/`; deleting a deployed project.

**Contract changes for the owner:** the only public contract is `GET /probe` and export `schemaVersion: 1`, both defined above.

**Non-goals:**

- Built-in bandwidth or load generation. Experiments use external traffic.
- WebSocket echo mode, third destinations, and independently hosted probes. These are follow-ups only after this delivery is correct and in use, and any future transport or destination stays separate in statistics.
- Upstream's router-address scanning, DNS probe machinery, m-lab discovery, third-party probes, jQuery, and App Engine hosting. The owned endpoints replace them.
- Accounts, server-side history, and uploads of results.
- Packet-loss measurement or fresh-connection measurement.

## Reference

- **Upstream:** `https://github.com/apenwarr/blip` at `d85ea18e0cf9f6bb1f092bc58d683a0ab2bcb087`, Apache-2.0. Preserved in `LICENSE` and `NOTICE`. Upstream uses `HEAD` with `no-cors`, routes success and rejection to one handler, has a 2.2-second timeout, and couples sampling to animation frames. Reuse drawing ideas only where useful, and keep upstream notices on anything derived.
- **Request volume at default settings:** 3,000 requests per provider and 6,000 total per 10-minute Compare session. A full 30-second burst sends 600 per endpoint instead of the normal 150, adding 450 per endpoint and 900 total.
- **Provider allowances checked 2026-11-23:** Cloudflare Workers Free has 100,000 requests per day, about 33 default sessions, and static assets are free. Workers Paid includes 10 million per month, then $0.30 per million. Vercel Hobby includes 1,000,000 function invocations, 4 hours of Active CPU, 360 GB-hours of provisioned memory, and 100 GB of Fast Data Transfer per month. Invocations allow about 333 default sessions. Measure actual Active CPU in L2.
- **Commands:** `npm run accept:foundation`; `npx cf dev`; `npx cf deploy --dry-run`; `vercel build --prod --yes`; `vercel deploy --prebuilt --prod --yes`.
- **Code map:** shared handler `src/probe/handler.ts`; adapters `worker/index.ts` and `api/probe.ts`; contract `test/probe-contract.ts`; revision stamp `scripts/stamp.ts`; workerd smoke `scripts/smoke-workerd.ts`.
