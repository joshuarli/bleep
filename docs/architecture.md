# Architecture and scope

This document explains the design choices behind blip monitor. The probe contract, metric, and export format are in the [Measurement reference](measurement.md).

## Shape

- One Vite + TypeScript frontend with no runtime dependencies and Canvas graphs.
- `src/probe/handler.ts` is the only probe implementation. `worker/index.ts` and `api/probe.ts` only supply `ProbeSite`, so the contract cannot drift between providers.
- No database, Durable Objects, queues, accounts, server-side history, upstream fetches, storage access, or per-probe application logging.
- Cloudflare keeps default placement. Vercel runs Node 24 on Fluid with `regions: ["sfo1"]` and `fluid: true` in `vercel.json`; do not substitute a region.
- `scripts/stamp.ts` writes `BLIP_TARGET` and the Git revision into the build. `scripts/deploy.ts` forces `production` and refuses a dirty tree.
- `src/config/endpoints.ts` fixes the endpoints per target (`production`, `local`, `fixture`). The page never accepts an endpoint from a URL or user input.
- Browser proof runs through `agent-browser` in `scripts/browser/`. Tests use `node:test` with injected clock, timer, fetch, and visibility interfaces.
- CORS is `Access-Control-Allow-Origin: *` without credentials. There is no rate limiter.

## Code map

| Area | Path |
| --- | --- |
| Probe implementation | `src/probe/handler.ts` |
| Provider adapters | `worker/index.ts`, `api/probe.ts` |
| Probe contract | `test/probe-contract.ts` |
| Build stamp | `scripts/stamp.ts` |
| Deploy and verify | `scripts/deploy.ts`, `scripts/verify-live.ts`, `cloudflare.config.ts`, `vercel.json` |
| Browser scenarios | `scripts/browser/` |
| Workerd smoke | `scripts/smoke-workerd.ts` |

## Non-goals

- Built-in bandwidth or load generation. Experiments use external traffic.
- WebSocket echo mode, third destinations, independently hosted probes, router-address scanning, DNS probe machinery, m-lab discovery, third-party probes, jQuery, and App Engine hosting.
- Accounts, server-side history, and uploads of results.
- Packet-loss and fresh-connection measurement.
