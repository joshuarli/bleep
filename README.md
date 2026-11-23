# blip monitor

blip monitor measures how responsive two deployed destinations are from your browser and network, and shows both on one timeline. It answers:

1. Which destination is more responsive from here?
2. When responsiveness deteriorates during an experiment, does it affect both at the same time?

## Hosted pages

Both pages and both probes run the same revision. Either page probes both providers directly.

- [Cloudflare page](https://blip-monitor.joshua-r-li-98.workers.dev) — Workers, default placement.
- [Vercel page](https://blip-monitor.vercel.app) — Node 24 on Fluid, `sfo1`.

The page never takes an endpoint from its URL or from user input.

- [Measurement reference](docs/measurement.md) defines the metric, outcomes, and export format.
- [Run a network experiment](docs/experiments.md) is the upload, download, and SQM recipe.

## Output

The page plots both destinations on one log-scale latency timeline. Each destination shows successful latency with its count and coverage, failures, achieved rate, and observed location. Compare mode adds the median paired difference and reports UI-host sensitivity across runs.

Export writes one JSON and one CSV from the same snapshot. Run `node scripts/summarize-export.ts --check <files>` to confirm an export still reproduces the summary the page displayed.

## Request volume

A default 10-minute Compare session sends 3,000 requests to each provider, 6,000 in total. A 30-second burst sends 600 per destination instead of 150.

The endpoints are public and anonymous and have no rate limiter. Other people's traffic also counts against provider allowances. The last allowance check and the unmeasured Vercel Active CPU are in [Operations](docs/operations.md).

## Limitations

- Turnaround includes routing, geography, connection handling, and browser scheduling. It cannot isolate server or JavaScript runtime speed.
- Failed requests are application request failures, not packet loss. A CORS rejection looks like a network error.
- Browser delay and network delay cannot be fully separated. Long tasks and scheduler gaps are annotations, not corrections.
- There is no p99, jitter, or statistical significance claim.
- Mobile layout is verified only in browser emulation. Results from different UI hosts are never pooled.

## License

blip monitor derives from [blip](https://github.com/apenwarr/blip) by Avery Pennarun and Google, at commit `d85ea18e0cf9f6bb1f092bc58d683a0ab2bcb087`. It reuses the log-scale latency plot and is licensed under Apache-2.0. See `LICENSE` and `NOTICE`.
