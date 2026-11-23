import { BUILD_REVISION } from "../generated/build-info.ts";

export const PROBE_PATH = "/probe";
export const PROBE_FORMAT_VERSION = 1;
export const PROBE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export type ProbeSite = {
  provider: "cloudflare" | "vercel";
  runtime: "workers" | "node-fluid";
  location: string | null;
  locationKind: "colo" | "execution-region";
};

const EXPOSED_HEADERS = [
  "x-blip-provider",
  "x-blip-runtime",
  "x-blip-location",
  "x-blip-location-kind",
  "x-blip-revision",
  "x-vercel-id",
  "cf-ray",
].join(", ");

function probeHeaders(site: ProbeSite): Headers {
  return new Headers({
    "access-control-allow-origin": "*",
    "access-control-expose-headers": EXPOSED_HEADERS,
    "cache-control": "no-store",
    "cdn-cache-control": "no-store",
    "content-type": "application/json",
    "timing-allow-origin": "*",
    "vercel-cdn-cache-control": "no-store",
    "x-blip-location": site.location ?? "unknown",
    "x-blip-location-kind": site.locationKind,
    "x-blip-provider": site.provider,
    "x-blip-revision": BUILD_REVISION,
    "x-blip-runtime": site.runtime,
  });
}

function validProbeId(url: URL): string | null {
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== "id") return null;
  const id = url.searchParams.get("id");
  return id !== null && PROBE_ID_PATTERN.test(id) ? id : null;
}

export function handleProbe(request: Request, site: ProbeSite): Response {
  const headers = probeHeaders(site);
  if (request.method !== "GET") {
    headers.set("allow", "GET");
    return new Response('{"error":"method_not_allowed"}', { status: 405, headers });
  }
  const id = validProbeId(new URL(request.url));
  if (id === null) {
    return new Response('{"error":"invalid_probe_id"}', { status: 400, headers });
  }
  return new Response(`{"v":${PROBE_FORMAT_VERSION},"id":"${id}"}`, { status: 200, headers });
}
