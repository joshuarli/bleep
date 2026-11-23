# Live browser proof

  `node scripts/browser/live.ts` produced these files on 2026-11-23 from one machine and network. They are a functional proof, not a performance result.

  Both pages and both probes ran revision `f13582e3e4ee2b895047d8d1680d32d437674bef`. Each page ran Compare mode in headless Chrome for about 8 s after the 10 s warm-up, with one pause and resume. The figures below exclude the warm-up and cancelled requests.

  | Page | Probe | Arrangement | Successful of attempted | Failed | Not sent | Median | Observed location | Protocol |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | cloudflare page | cloudflare probe | same-origin | 46 of 46 | 0 | 0 | 18.4 ms | SJC | h3 |
| cloudflare page | vercel probe | cross-origin | 46 of 46 | 0 | 0 | 33.7 ms | sfo1 | h2 |
| vercel page | cloudflare probe | cross-origin | 46 of 46 | 0 | 0 | 37.2 ms | SJC | h3 |
| vercel page | vercel probe | same-origin | 46 of 46 | 0 | 0 | 33.4 ms | sfo1 | h2 |

  The check also verified these facts:

  - No probe request from either page caused an `OPTIONS` preflight. A control request with a custom header did cause one, so the check can fail.
  - Every probe ID was unique, and every successful response echoed its ID byte for byte.
  - Every backend reported the page's revision. Vercel reported `sfo1`.
  - Each page paused and resumed, and neither page overflows horizontally at 390 × 844.
  - Each export reproduces the summary its page displayed: `node scripts/summarize-export.ts --check docs/evidence/live`.

  `node scripts/verify-live.ts --all` covers the server side: anonymous access, the probe contract, nonce echoes, `no-store` with no cache hits, CORS on success and errors, and that Vercel is not served through Cloudflare.

  The exports contain no credentials or IP addresses. They contain random probe IDs, page-relative times, and the raw `cf-ray` and `x-vercel-id` request identifiers.
  