Expand the blip modernization project to support a rigorous, lightweight Cloudflare-versus-Vercel comparison.

Build and deploy the same application to both providers. From either hosted interface, I must be able to observe both destinations on the same timeline, run controlled network experiments, and export the results.

All earlier requirements concerning measurement correctness, bounded resource use, failure reporting, accessibility, and local export still apply. Integrate this into the current implementation without maintaining two copies of the measurement logic.

## 1. Share the application and probe implementation

Use one repository, one frontend implementation, and one shared probe protocol, with thin deployment adapters for:

- Cloudflare Workers with Static Assets.
- Vercel static hosting with a small Node.js Function on Fluid Compute.

A framework-free Vercel function is sufficient. Preserve the existing lightweight frontend.

Deploy both from the same Git revision. Keep provider-specific configuration separate from shared application behavior, and expose enough version information to detect mismatched deployments.

Both probe endpoints must use the same HTTP method, nonce format, response schema, small application payload, success criteria, and timeout policy. Keep provider metadata in a consistently defined location, preferably response headers, so the application payload can remain identical.

The timed handlers should perform only validation and response construction. Keep upstream requests, storage, and per-probe application logging out of that path.

## 2. Make placement and routing explicit

Keep Cloudflare’s default execution placement and report the observed colo.

Configure the primary Vercel deployment explicitly for `sfo1`, appropriate for my initial SF Bay Area testing. Verify the actual runtime region after deployment. If that region is unavailable, report the limitation instead of silently substituting another.

Label the destinations accurately, for example:

- Cloudflare Worker — observed colo.
- Vercel Node/Fluid — observed execution region.

Use provider-native HTTPS endpoints initially, such as the dedicated workers.dev and vercel.app URLs.

The browser must contact each provider directly. Ensure the Vercel endpoint is not accidentally behind a Cloudflare-proxied hostname. Neither backend should relay probes to the other.

Explain that the comparison includes routing, geography, transport behavior, browser scheduling, and platform handling. It cannot isolate JavaScript runtime performance.

## 3. Support direct cross-origin probes correctly

Either hosted interface must be able to call both endpoints.

Use ordinary GET requests with the probe nonce in the query string, `credentials: "omit"`, and no custom request headers that would introduce CORS preflights.

Configure an intentional CORS policy on both endpoints, including relevant error responses. Expose the response headers used for version and location metadata.

If collecting detailed cross-origin Resource Timing, configure Timing-Allow-Origin as well. Treat unavailable timing fields as unknown; ordinary client-side elapsed time remains the primary metric.

Disable browser and CDN caching for probes. Check all relevant provider cache directives, including Vercel’s higher-priority CDN cache headers. Verify fresh nonce echoes and inspect deployed cache behavior.

Use the intentionally public endpoint of the dedicated diagnostic project. An authentication page, redirect, or platform challenge must not count as a valid probe. Never embed deployment-protection bypass secrets in frontend code or exported results.

Verify in a real browser that normal probes do not generate an OPTIONS request before each measurement.

## 4. Add paired sampling

Provide three modes:

- Cloudflare only.
- Vercel only.
- Compare both.

In comparison mode, create a shared sequence number and intended dispatch time for each pair. Launch both fetches without waiting for either to complete, alternating which endpoint is dispatched first.

Record each request’s actual dispatch time and the dispatch skew. Pair measurements by their sequence number, never by response arrival order. Flag pairs whose dispatch skew exceeds a documented tolerance.

Maintain independent deadlines and in-flight limits for each endpoint. A stalled Cloudflare request must not stop Vercel sampling, and vice versa.

Preserve one-sided results, timeouts, skipped opportunities, and browser scheduling gaps. Apply the original no-catch-up-burst behavior.

Use 5 probes per second per endpoint by default. Display both per-endpoint and aggregate rates: this means 10 requests per second in comparison mode.

Keep the ten-minute default session. At the configured rate, that is approximately 3,000 requests per provider and 6,000 total, excluding setup requests. Make diagnostic-burst rates equally explicit.

Keep request counts and resource use bounded, and check current provider allowances before estimating costs.

## 5. Separate warm-up from sustained observation

Start comparison runs with a short, fixed, clearly marked warm-up phase applied equally to both endpoints.

Retain warm-up samples, but keep them separate from the sustained-run summaries. Do not extend warm-up until results look favorable.

Keep initial requests and first-after-idle observations inspectable. Do not call them confirmed “cold starts”: opening the UI may already have established a connection, and a first browser request does not prove a new function instance.

Record the UI origin and whether each probe is same-origin or cross-origin.

Verify and exercise both arrangements:

| Interface served by | Probe Cloudflare directly | Probe Vercel directly |
|---|---|---|
| Cloudflare | Required | Required |
| Vercel | Required | Required |

Keep results from these arrangements distinguishable. If the apparent advantage changes when the UI host changes, report that sensitivity rather than pooling everything into an unqualified winner.

No third hosting provider is required for this first comparison.

## 6. Build a useful comparison view

Overlay both latency series on the same elapsed-time axis with clear labels and accessible visual distinctions.

Show a compact side-by-side summary containing:

- Successful response count.
- Median, p95, and maximum successful request latency.
- Timeouts and other errors, with attempted-request denominators.
- Skipped measurement opportunities and achieved sample rate.
- Time since the last valid response.
- Observed endpoint location and deployment revision.

Add a paired-difference view:

`difference = Vercel request duration − Cloudflare request duration`

Positive values mean Vercel took longer for that pair.

Show the median paired difference alongside the number of valid complete pairs. Keep incomplete pairs visible and summarize whether Cloudflare alone succeeded, Vercel alone succeeded, both succeeded, or neither produced a valid response. Distinguish failed attempts from probes that were never sent.

Do not let a destination with many failures look excellent merely because its few successful responses were fast.

Keep statistical labels precise. The difference between the two endpoints’ p95 values is different from the p95 of individual paired differences. The initial implementation only needs per-endpoint p95 and median paired difference.

Avoid statistical significance claims based on treating thousands of closely spaced samples as independent experiments.

## 7. Compare responsiveness under the same load

Extend the existing interval markers and before/after comparison so both providers remain visible throughout:

- Idle baseline.
- External upload.
- Recovery.
- External download.
- Recovery.
- Repetition after changing SQM or Wi‑Fi settings.

Allow the user to mark a baseline interval and show latency increases relative to each endpoint’s own baseline, alongside the raw latency.

Document the calculation. For example, compare each selected phase’s median with that endpoint’s baseline median, and its p95 with that endpoint’s baseline p95. Keep the baseline fixed for the experiment.

Do not normalize away failures, gaps, or raw latency.

Separate comparison segments when the endpoint location, deployment revision, or experiment phase changes.

Describe coincident spikes as evidence consistent with a shared influence. Describe one-destination spikes as evidence of a difference worth investigating. Do not automatically assign blame to the router, ISP, or hosting provider.

Continue using external traffic generation for this delivery. Keep the monitor visible while generating load through another visible window, a CLI/native application, or another device.

## 8. Export enough evidence to reproduce the comparison

Extend the existing JSON/CSV export to include:

- UI origin and frontend revision.
- Both endpoint URLs and backend revisions.
- Runtime, configured region, and observed location metadata.
- Pair sequence numbers and intended dispatch times.
- Actual dispatch times, dispatch skew, completion times, and outcomes.
- Warm-up and experiment-phase markers.
- Sampling rates, deadlines, concurrency limits, and skipped slots.
- The retained time range and any buffer truncation.

For Vercel, use documented runtime information such as VERCEL_REGION for execution location. Retain raw x-vercel-id information separately when available instead of guessing its structure.

For Cloudflare, retain the observed colo with its documented meaning.

Keep ingress information and execution location distinct. Record optional negotiated-protocol information when available, without making unsupported claims when it is missing.

Verify that exported samples reproduce the displayed summaries.

## 9. Verify the comparison, then deploy both versions

Add focused checks for failures that would invalidate the comparison:

- Both adapters obey the same probe contract.
- A known simulated delay on one endpoint produces the expected signed paired difference.
- Response completion order cannot swap or mismatch pairs.
- One endpoint timing out does not block the other.
- Missing pairs do not become fabricated latency differences.
- Excessive dispatch skew is reported.
- Warm-up, pauses, location changes, and revision mismatches are handled explicitly.
- Existing lifecycle cleanup and memory bounds still hold.

Keep simulated timing fixtures clearly separate from real network observations.

Deploy both providers from the same revision and verify all four interface-to-endpoint combinations in a real browser. Check anonymous access, CORS, nonce validation, caching, reported region, pause/resume, and export.

Perform repeated short comparison runs from both hosted interfaces. State the actual environment and location of those runs when known. Measurements from a cloud agent are not measurements from my home connection.

If authentication for one provider is unavailable, finish its implementation and local verification, complete any available deployment, and identify the exact remaining authentication step.

## Deliverables

Return:

1. Both live application URLs and both direct probe URLs.
2. The shared Git revision and each provider’s deployed version.
3. Evidence that either interface probes both providers directly.
4. The configured and observed locations.
5. Sample exports and a concise explanation of the observed results.
6. A short recipe for repeating the comparison from my Bay Area connection under upload/download load and with SQM off/on.
7. Current usage implications for the default session and any concrete remaining limitation.

The result should let me answer two practical questions:

“Which of these deployed destinations is more responsive from this browser and network?”

“When responsiveness deteriorates during my experiment, does it affect both destinations at the same time?”