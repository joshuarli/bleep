# blip monitor

blip monitor is a browser page that measures how responsive two deployed destinations are from your browser and network, and shows both on one timeline. It answers two questions:

1. Which destination is more responsive from this browser and network?
2. When responsiveness deteriorates during an experiment, does it affect both destinations at the same time?

The same revision runs on two providers. Each one serves the page and a `/probe` endpoint, and either page probes both endpoints directly:

| Provider | Page and probe origin | Runtime | Configured location |
| --- | --- | --- | --- |
| Cloudflare | `https://blip-monitor.joshua-r-li-98.workers.dev` | Workers | default placement |
| Vercel | `https://blip-monitor.vercel.app` | Node 24 on Fluid compute | `sfo1` |

- [Measurement reference](docs/measurement.md) defines the metric, outcomes, formulas, and export format.
- [Run a network experiment](docs/experiments.md) is the recipe for upload, download, and SQM experiments.

## Commands

Install dependencies first with `npm ci`. Deployed functions run Node 24. Local work also runs on newer Node, which prints an `EBADENGINE` warning you can ignore.

| Command | What it does |
| --- | --- |
| `npm run check` | Type-checks the repository |
| `npm test` | Runs the unit tests |
| `npm run accept:foundation` | Checks, tests, builds both providers, and runs the probe contract under `workerd` |
| `node scripts/browser/check.ts <stack\|live\|compare\|intervals\|export\|all>` | Builds the page against simulated fixture endpoints and verifies it in a real browser through `agent-browser` |
| `npx cf dev` | Serves the page and the Cloudflare probe locally on port 8787 |
| `npm run dev:vercel` | Serves the Vercel probe adapter locally on port 8788, so the local page can probe both |
| `node scripts/summarize-export.ts [--check] <files or directories>` | Summarizes exports, or checks that they reproduce the displayed summary |

Builds read `BLIP_TARGET` (`production`, `local`, or `fixture`, default `local`) to choose which endpoints the page probes. The page never takes an endpoint from its URL or from user input. Local and fixture results are simulated.

## Deploy

Deploy only from a clean, committed tree:

```sh
node scripts/deploy.ts all
node scripts/verify-live.ts --all
```

`scripts/deploy.ts` stamps the current revision with `BLIP_TARGET=production`, deploys the Worker with the `cf` CLI, and builds and deploys the Vercel project with the `vercel` CLI. It refuses a dirty tree. `scripts/verify-live.ts --all` checks the probe contract, caching, CORS, location, and that all four deployed pieces report the same revision.

## Request volume and provider allowances

At default settings, a 10-minute Compare session sends 3,000 requests to each provider, 6,000 in total. A full 30 s burst sends 600 requests per destination instead of the normal 150.

Allowances checked on 2026-11-23:

- **Cloudflare Workers Free:** 100,000 requests per day, about 33 default Compare sessions. Static assets are free.
- **Vercel Hobby:** 1,000,000 function invocations, 4 hours of Active CPU, 360 GB-hours of provisioned memory, and 100 GB of Fast Data Transfer per month. Invocations allow about 333 default sessions.

The endpoints are public and anonymous, and there is no rate limiter, so other people's traffic also counts against these allowances.

## Limitations

- Turnaround includes routing, geography, connection handling, and browser scheduling. The comparison cannot isolate server or JavaScript runtime speed.
- Failed requests are application requests that failed. They are not packet loss.
- A CORS rejection looks like a network error to the page.
- Browser delay and network delay cannot be fully separated. Long tasks and scheduler gaps are annotations, not corrections.
- The monitor shows no p99, jitter, or statistical significance.
- Mobile layout is verified only in browser emulation.

## Attribution

blip monitor is derived from [blip](https://github.com/apenwarr/blip) by Avery Pennarun and Google, at commit `d85ea18e0cf9f6bb1f092bc58d683a0ab2bcb087`. It reuses the idea of a live log-scale latency plot. It is licensed under the Apache License 2.0. See `LICENSE` and `NOTICE`.
