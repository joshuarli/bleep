**Yes—I’d build this. For diagnosing lag, Wi‑Fi instability, and the CAKE/SQM problem you were looking at, blip’s continuous latency display is often more useful than a headline Mbps result.** Cloudflare Workers is a good fit for a small, modern version.

The improvement I would make is to preserve the live, detailed visualization while replacing its opportunistic probes with **a tiny endpoint that returns verifiable responses**. That gives you much cleaner distinctions between a slow response, a failed request, and a browser that stopped taking measurements.

## What makes the technique useful?

Blip lets you change something and immediately see its effect: start an upload, move farther from the access point, switch networks, or enable SQM. Its value is the relationship between **what you just did and what happened to latency over time**. That is also the central idea described in its README. [GitHub](https://github.com/apenwarr/blip?utm_source=chatgpt.com)

For example, imagine two connections:

- One delivers 400 Mbps, but uploads repeatedly cause half-second stalls.
- Another delivers 200 Mbps and remains responsive throughout.

The first wins a bandwidth comparison. For interactive work, I would generally prefer the second. A continuous trace makes that tradeoff visible.

However, **modern speed tests already incorporate latency testing**. Cloudflare’s test sends small HTTP requests during transfers to measure loaded latency, and it measures packet loss separately through WebRTC. So blip’s advantage is the continuous diagnostic experience, rather than a fundamentally new measurement primitive. Cloudflare also says its test does not aim to saturate the connection, which matters when investigating worst-case bufferbloat. [Cloudflare Blog](https://blog.cloudflare.com/how-does-cloudflares-speed-test-really-work/?utm_source=chatgpt.com)

Here is how I would use the tools:

| Question | Best approach |
|---|---|
| How much sustained download/upload capacity do I have? | A throughput test |
| When does the connection become unresponsive? | A continuous blip-style trace |
| Does uploading interfere with everything else? | A latency trace while generating controlled upload load |
| Did enabling CAKE improve responsiveness? | Repeat the same load with SQM off/on and compare latency distributions and stalls |
| Where is the problem: Wi‑Fi, router, ISP, or destination? | Controlled comparisons across devices, wired/Wi‑Fi connections, and destinations |

For your use case, I would make **easy before/after experiments** the defining feature.

## What I would change in the original

I inspected the current source, which differs substantially from the README’s older implementation description.

The current [`blip.js`](https://github.com/apenwarr/blip/blob/d85ea18e0cf9f6bb1f092bc58d683a0ab2bcb087/blip.js):

- Uses `fetch()` with `HEAD` and `mode: "no-cors"`.
- Routes successful and rejected requests into the same completion handler.
- Uses a 2.2-second timeout and some “implausibly fast response” heuristics.
- Schedules new probes after earlier ones complete, with sampling coupled to animation frames.
- Discovers local-ish and remote targets through router-address candidates, gstatic, and external services.

That is clever for getting useful signals from arbitrary destinations. An owned endpoint lets us simplify considerably.

**A successful measurement should mean: “the endpoint returned the correct response to this particular probe.”** A failed fetch should remain a failed fetch. With `no-cors`, responses are opaque, so the application cannot inspect their status or contents to establish that distinction reliably. [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch?utm_source=chatgpt.com)

I would also avoid calling failed HTTP probes “packet loss.” They measure failed or overdue application requests. They do not reveal how many network packets were retransmitted along the way.

## How I would deploy it

The initial architecture can be very small:

| Component | Implementation |
|---|---|
| Interface | Static HTML, CSS, and vanilla JavaScript or TypeScript |
| Graph | Canvas, retaining blip’s useful detail/overview idea |
| Probe | Same-origin `GET /probe`, returning a tiny response containing the request’s unique ID |
| Measurement history | Bounded browser memory, with explicit JSON/CSV export |
| Deployment | One Cloudflare Worker with Static Assets |

Workers supports deploying static assets alongside the Worker, and matching assets can be served without invoking your code. Static asset requests are free and unlimited; dynamic probe requests count toward Workers usage. [Cloudflare Workers docs](https://developers.cloudflare.com/workers/static-assets/?utm_source=chatgpt.com)

**The main measurement boundary is the destination.** This would measure browser-visible turnaround to the Cloudflare edge selected by routing. It would not prove that every Internet destination is performing well. Leave Worker placement at its default for this endpoint; there is no remote database or origin that execution needs to move toward. [Cloudflare Workers docs](https://developers.cloudflare.com/workers/configuration/placement/?utm_source=chatgpt.com)

A later second destination should be contacted **directly by the browser** on independently hosted infrastructure. Putting two hostnames on Cloudflare would not, by itself, establish two independent measurement paths.

### Choose the sampling rate deliberately

I would start with:

- **5 probes/second** during normal observation.
- **20 probes/second for 30 seconds** when the user requests more detail.
- **A ten-minute default session**, with an explicit extension control.
- A visible count of probes sent and the actual achieved sampling rate.

At those configured rates, a normal ten-minute session is approximately **3,000 requests**; a 30-second burst is **600**. By comparison, sustained 100 Hz HTTP probing is **8.64 million requests/day** and would consume the Workers Free allowance of 100,000 requests in **16 minutes 40 seconds**, assuming no other account usage. These are calculated request counts using Cloudflare’s current allowance. [Cloudflare Workers docs](https://developers.cloudflare.com/workers/platform/pricing/?utm_source=chatgpt.com)

WebSocket echoes are a reasonable later option for prolonged monitoring: Cloudflare bills the initial Worker WebSocket upgrade as a request, while subsequent messages do not count as requests. But they measure an established message connection, and I would keep their results separate from HTTP turnaround. I would also verify runtime limits before promising indefinite free monitoring. [Cloudflare Workers docs](https://developers.cloudflare.com/workers/platform/pricing/?utm_source=chatgpt.com)

## Coding-agent prompt

This is the prompt I would use. It deliberately puts measurement correctness and a working deployment ahead of adding more types of tests.

Build and deploy a small, polished network responsiveness monitor based on:

https://github.com/apenwarr/blip

The purpose is to observe latency, stalls, and request failures continuously while experimenting with Wi‑Fi, network load, and router/SQM settings. Preserve blip’s immediate visual feedback and useful time scales.

Complete the implementation, verification, and deployment. Make reasonable implementation decisions autonomously.

## 1. Inspect the source and establish provenance

Read the repository instructions and the current upstream source, especially blip.js, index.html, app.yaml, and COPYING.

The README describes some historical behavior that differs from the current code. Verify the implementation before deciding what to retain.

Record the upstream commit used. Preserve the Apache-2.0 license, copyright notices, and appropriate attribution. Reuse useful drawing code where it makes sense; replace the measurement core where necessary.

Work within the target checkout’s existing conventions. Keep the application small and understandable.

## 2. Build a minimal Cloudflare architecture

Use one Cloudflare Worker with Static Assets.

Serve the UI directly as static assets. Reserve a clearly defined route for probes, such as GET /probe.

Use vanilla JavaScript or TypeScript and Canvas. Keep runtime dependencies minimal. This application needs no database, Durable Objects, queues, accounts, or server-side measurement history.

The probe handler should:

- Validate a short, bounded probe ID supplied by the client.
- Return a tiny response containing the same ID, a response-format version, and the Cloudflare colo when available.
- Set Cache-Control: no-store.
- Do no upstream fetching or storage access.
- Return clear responses for unsupported methods and malformed inputs.
- Avoid per-probe application logging.

Use normal edge execution placement. Keep Smart Placement and explicit regional placement out of the probe path.

Make the UI and endpoint work on the same HTTPS origin. Replace the original app’s external discovery services, opaque third-party probes, router-address scanning, and DNS-probe machinery with this controlled endpoint.

## 3. Define exactly what is measured

The primary metric is browser-observed HTTP request turnaround to the configured endpoint.

Use the browser’s monotonic performance.now() clock. Start timing immediately before issuing the request and stop after receiving the tiny response body, before parsing or rendering it. Validate the response before accepting it as a successful sample.

Use cache: "no-store" and a unique probe ID. Reject unexpected redirects, incorrect IDs, unexpected response formats, and server errors as invalid probe outcomes.

Keep these outcomes distinct:

- Valid response with a measured duration.
- Request timeout.
- Fetch failure.
- HTTP/server error.
- Invalid response.
- Cancellation caused by stopping or pausing.
- A scheduled probe that was never sent.

Do not represent failures as zero latency or assign a timeout an invented successful RTT equal to its deadline.

Do not call timeout percentage “packet loss.” Explain that these are application requests over a reliable transport.

Retain first-probe/warm-up information. Do not claim to force or measure a fresh TCP/TLS connection merely by changing the URL.

Do not subtract an invented Worker execution duration to report “pure network latency.” Keep the measurement definition honest.

## 4. Use bounded, explicit sampling

Default to 5 probes per second, with a lower-rate option.

Provide a 20-probes-per-second diagnostic burst lasting 30 seconds, after which the normal rate resumes. These are target rates; show the actual achieved rate.

Default sessions to ten minutes, with an explicit extension control.

Schedule against intended monotonic deadlines independently of rendering. Bound concurrent requests, initially to four per endpoint, and use a documented request timeout, initially three seconds.

When the concurrency cap is occupied or the browser misses a scheduling deadline:

- Record the skipped measurement opportunity.
- Preserve the elapsed gap on the time axis.
- Do not launch a burst of overdue requests.
- Do not silently make a stalled interval appear healthy.

Maintain a bounded ring buffer. Define and expose the retained time window. Clear resource-timing entries and other accumulating browser state as needed.

Stop and pause must cancel outstanding work and clean up timers. Late completions from an earlier run must never contaminate a later run.

Pause when the document becomes hidden. Mark the pause explicitly and resume without catch-up traffic. Track scheduling delays and annotate suspected browser suspension or long tasks without claiming that this perfectly separates browser delay from network delay.

Preserve observed slow measurements; do not silently filter away inconvenient samples.

## 5. Make the interface useful during real experiments

Build a responsive interface that works on desktop and mobile.

The main element should be a live latency plot with enough detail to see short spikes, plus a longer overview or selectable time window.

Use real elapsed time. Preserve visible gaps for pauses, missing measurements, and failures.

Include:

- Start, stop, clear, and session extension controls.
- Normal sampling and diagnostic burst controls.
- Current successful latency, median, p95, and maximum for a clearly identified window.
- Successful sample count alongside those statistics.
- Separate counts for timeouts, errors, cancellations, and unsent probes.
- Actual sampling rate and requests sent.
- Time since the last valid response.
- Endpoint and Cloudflare colo, when available.
- Clearly marked endpoint/colo changes and measurement gaps.
- A simple explanation of what the graph measures.

Add p99 only if the sample count and presentation make its limitations clear. Prefer a few trustworthy numbers over a crowded dashboard.

Keep successful-response percentiles visibly associated with failure and coverage information. An interval with many failures must not look excellent because its few successful responses were fast.

If including a jitter-like metric, call it RTT variation and document the exact formula. Do not calculate differences across pauses, failures, or endpoint changes.

Provide visible event markers with editable labels, for example:

- Baseline
- Upload started
- Download started
- SQM enabled
- Changed Wi‑Fi
- Moved to another room

Allow the user to select two marked intervals and compare their duration, successful-response latency statistics, failures, and measurement coverage. Keep this comparison simple.

Use accessible controls and distinguish failures through more than color alone. The graph should remain readable on a phone.

## 6. Support local export and repeatable experiments

Keep measurement results in the browser.

Provide user-triggered JSON and CSV exports containing raw retained samples, outcome types, relevant timestamps, event markers, endpoint metadata, sampling configuration, and the application version.

State the export’s retained time range and whether earlier samples were discarded. Do not imply that a bounded buffer contains an entire extended session.

Include a short practical guide for testing:

1. Record an idle baseline.
2. Generate sustained upload traffic while the monitor remains visible.
3. Repeat for download traffic.
4. Repeat the same experiment after changing SQM settings.
5. Compare equivalent intervals and retain the exports.

Explain that users should keep the monitor visible in a separate window or split-screen layout, or generate load through a CLI/native application or another device. Opening a load test in another tab would hide and pause this monitor.

For router/SQM experiments, suggest establishing a wired baseline before adding Wi‑Fi variables.

This first version can rely on external traffic generation. A built-in bandwidth test is outside the initial delivery.

## 7. Verify the failure modes that would corrupt conclusions

Write focused tests for the measurement model and lifecycle.

Demonstrate that:

- Known response timings produce the expected summary statistics.
- Timeouts and errors remain separate from successful latency values.
- Invalid IDs, unexpected HTML, and server errors cannot become successful probes.
- A long gap remains visible on the time axis.
- Missing scheduling slots are reported without catch-up bursts.
- Stop/start and hidden/visible transitions clean up correctly.
- A late response cannot modify a newer session.
- Memory and outstanding requests remain bounded.
- Exports preserve outcome distinctions and interval boundaries.

Use controlled fixtures for deterministic timing tests, and identify them as simulated behavior.

Verify the deployed application in a real browser. Check successful nonce validation, cache behavior, timeout/error presentation, pause/resume, mobile layout, and export.

Keep local browser emulation results separate from actual network observations. Do not claim a measured improvement to the user’s home network without performing that experiment.

## 8. Deploy and finish the task

Use the project’s existing Cloudflare authentication and deployment conventions. If this is a new project, select a dedicated Worker name and deploy to its workers.dev hostname.

Avoid overwriting an unrelated Worker or changing account-wide settings.

Use a pinned toolchain and lockfile. Provide clear development, test, and deployment commands and a checked-in Wrangler configuration.

Verify the deployed HTTPS URL and probe endpoint, then report:

- The live URL.
- The commit and deployed version.
- What was verified locally and in the deployed browser.
- The measurement definition and material limitations.
- Default request volume and current relevant Workers pricing/limits.
- Any concrete remaining blocker.

If credentials are unavailable, finish all implementation and local verification, then state the exact authentication step needed to deploy.

## 9. Keep follow-ups evidence driven

After the HTTP version is deployed, the main possible additions are:

- A separately labeled WebSocket echo mode for prolonged monitoring, after confirming deployed runtime limits and reconnect behavior.
- A directly contacted endpoint on another provider for a genuinely different destination.
- Explicitly initiated, time- and byte-bounded traffic generation for loaded-latency experiments.

Keep transport types and destinations separate in the statistics. Do not expand into these before the first version is correct, usable, and deployed.

The acceptance criterion is that I can open the page, run a controlled network experiment, see precisely when responsiveness deteriorates, and export enough evidence to compare the result with a later run.

The feature I would personally prioritize after the live graph is **marking and comparing intervals**. For your router investigation, being able to compare “upload, SQM off” against “same upload, SQM on”—including the slow tail and periods without valid replies—would make this a tool you can use repeatedly as you tune things.