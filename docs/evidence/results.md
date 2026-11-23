# Repeated live comparison results

These are measurements from one machine and network on 2026-11-23, around 14:34 to 14:48 Pacific time. They describe this setup only. They say nothing about the owner's home network or about any change to it.

## Setup

- **Client:** headless Chrome 158 driven by `agent-browser` on macOS (Darwin 27.2), on this machine's network. The network path and ISP were not recorded.
- **Revision:** both pages and both probes ran `b8b0f92b8183b0a4b34a0eabe1f45a562ca9759a`.
- **Destinations:** Cloudflare Workers with default placement, observed in colo `SJC` for every request. Vercel Node 24 on Fluid compute, configured and observed in `sfo1` for every request.
- **Runs:** 3 Compare runs from each hosted page, alternating pages, each 130 s: the 10 s warm-up plus 120 s of sustained sampling at 5 requests per second per destination. `node scripts/browser/live.ts runs` recorded them.

The figures below exclude the warm-up. Paired difference is `Vercel − Cloudflare` for pairs where both requests succeeded and were sent within 5 ms of each other.

## Per run

| Page | Run started (UTC) | Segment | Cloudflare ok of attempted | Cloudflare median / p95 / max ms | Vercel ok of attempted | Vercel median / p95 / max ms | Median paired difference ms | Pairs used | Skew flagged | Locations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| blip-monitor.joshua-r-li-98.workers.dev | 2026-11-23T22:34:25 | 1 | 601 of 601 | 15.4 / 38.6 / 307.7 | 600 of 600 | 33.4 / 72.8 / 365.0 | 17.4 | 600 | 0 | SJC, sfo1 |
| blip-monitor.vercel.app | 2026-11-23T22:36:36 | 1 | 601 of 601 | 19.8 / 36.6 / 319.7 | 600 of 600 | 33.7 / 74.9 / 352.1 | 13.6 | 598 | 2 | SJC, sfo1 |
| blip-monitor.joshua-r-li-98.workers.dev | 2026-11-23T22:38:48 | 1 | 601 of 601 | 14.7 / 18.4 / 322.3 | 600 of 600 | 33.3 / 72.3 / 324.0 | 18.7 | 600 | 0 | SJC, sfo1 |
| blip-monitor.vercel.app | 2026-11-23T22:41:00 | 1 | 598 of 598 | 20.8 / 51.6 / 664.8 | 598 of 598 | 33.1 / 56.4 / 529.8 | 12.0 | 596 | 2 | SJC, sfo1 |
| blip-monitor.joshua-r-li-98.workers.dev | 2026-11-23T22:43:12 | 1 | 600 of 600 | 22.1 / 53.6 / 329.3 | 600 of 600 | 33.8 / 79.9 / 372.5 | 12.3 | 597 | 3 | SJC, sfo1 |
| blip-monitor.vercel.app | 2026-11-23T22:45:27 | 1 | 601 of 601 | 20.8 / 33.1 / 176.5 | 601 of 601 | 34.2 / 61.6 / 236.7 | 13.4 | 599 | 2 | SJC, sfo1 |

| Page | Single-segment runs | Run medians of paired difference ms | Median of run medians ms |
| --- | --- | --- | --- |
| blip-monitor.joshua-r-li-98.workers.dev | 3 | 17.4, 18.7, 12.3 | 17.4 |
| blip-monitor.vercel.app | 3 | 13.6, 12.0, 13.4 | 13.4 |

UI-host sensitivity: yes. The median paired difference is 17.4 ms from blip-monitor.joshua-r-li-98.workers.dev and 13.4 ms from blip-monitor.vercel.app.

The second table summarizes each page. "Median of run medians" is the nearest-rank median of the three run-level median paired differences.

## What the runs show

- Every sent request succeeded: there were no timeouts or errors. In the second run from the Vercel page, the page woke late once and skipped 3 slots per destination as `deadline_missed`, about 0.5% of that run. The only other non-`ok` records are 1 or 2 requests per run cancelled by Stop.
- Vercel took longer than Cloudflare in the typical pair from both pages, by 12.0 to 18.7 ms per run. This is turnaround from this browser and network. It includes routing, geography, transport behavior, and platform handling, so it cannot isolate runtime performance.
- Both destinations showed occasional slow requests above 300 ms in the same runs. When both spike together, that is consistent with a shared influence such as this machine or its network. These runs were not designed to tell which.
- **UI-host sensitivity: yes.** The median paired difference was 17.4 ms from the Cloudflare page and 13.4 ms from the Vercel page. The 4.0 ms change exceeds `max(2 ms, 20%)`. Each page is same-origin with its own provider's probe, so results from the two pages are reported separately and never pooled.
- No result here is a statistical significance claim.

## Reproduce

```sh
node scripts/summarize-export.ts --check docs/evidence/runs
node scripts/summarize-export.ts --results docs/evidence/runs
```

The first command checks that each export reproduces the summary its page displayed. The second regenerates the tables above.

## Request volume and cost

These runs sent about 3,900 requests to each provider. All live verification in the campaign sent fewer than 10,000 requests to each provider, within the 20,000 budget.

Vercel Active CPU for these runs was not measured. The Vercel CLI's `metrics` command requires a Pro plan on this account, and the campaign may not change plans. The Vercel dashboard's usage page shows Active CPU for the project.
