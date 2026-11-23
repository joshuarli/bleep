import type {
  Clock,
  InvalidReason,
  ProbeFetch,
  ProbeResult,
  ProbeTarget,
  ResourceTimingReader,
  ResponseMeta,
  Timers,
} from "./types.ts";

export const PROBE_TIMEOUT_MS = 3_000;

export type ProbeClientDeps = {
  clock: Clock;
  timers: Timers;
  fetch: ProbeFetch;
  resourceTiming: ResourceTimingReader;
};

export const PROBE_REQUEST: RequestInit = {
  method: "GET",
  cache: "no-store",
  credentials: "omit",
  redirect: "manual",
  mode: "cors",
};

export function newProbeId(fillRandom: (bytes: Uint8Array<ArrayBuffer>) => void): string {
  const bytes = new Uint8Array(16);
  fillRandom(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export const probeRequestUrl = (target: ProbeTarget, id: string): string =>
  `${target.origin}/probe?id=${id}`;

export const expectedProbeBody = (id: string): string => `{"v":1,"id":"${id}"}`;

function readMeta(response: Response, nextHopProtocol: string | null): ResponseMeta {
  const header = (name: string) => response.headers.get(name) || null;
  return {
    status: response.status,
    revision: header("x-blip-revision"),
    runtime: header("x-blip-runtime"),
    location: header("x-blip-location"),
    locationKind: header("x-blip-location-kind"),
    vercelId: header("x-vercel-id"),
    cfRay: header("cf-ray"),
    nextHopProtocol,
  };
}

export async function sendProbe(
  deps: ProbeClientDeps,
  target: ProbeTarget,
  id: string,
  cancel: AbortSignal,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  const url = probeRequestUrl(target, id);
  const controller = new AbortController();
  let timedOut = false;
  const onCancel = () => controller.abort();
  cancel.addEventListener("abort", onCancel, { once: true });
  const timer = deps.timers.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let response: Response | null = null;
  const dispatchedAt = deps.clock.now();
  try {
    if (cancel.aborted) throw new DOMException("cancelled before dispatch", "AbortError");
    response = await deps.fetch(url, { ...PROBE_REQUEST, signal: controller.signal });
    const body = await response.text();
    const completedAt = deps.clock.now();
    deps.timers.clearTimeout(timer);
    return classifyResponse(response, body, id, target, dispatchedAt, completedAt, deps.resourceTiming(url));
  } catch {
    const completedAt = deps.clock.now();
    deps.timers.clearTimeout(timer);
    const meta = response === null ? null : readMeta(response, null);
    const outcome = timedOut ? "timeout" : cancel.aborted ? "cancelled" : "network_error";
    return { outcome, latencyMs: null, dispatchedAt, completedAt, response: meta };
  } finally {
    cancel.removeEventListener("abort", onCancel);
  }
}

function classifyResponse(
  response: Response,
  body: string,
  id: string,
  target: ProbeTarget,
  dispatchedAt: number,
  completedAt: number,
  resource: { nextHopProtocol: string | null } | null,
): ProbeResult {
  const timing = { dispatchedAt, completedAt };
  const invalid = (invalidReason: InvalidReason, meta: ResponseMeta | null): ProbeResult => ({
    outcome: "invalid_response",
    latencyMs: null,
    invalidReason,
    response: meta,
    ...timing,
  });
  if (response.type === "opaqueredirect") return invalid("opaque_redirect", null);
  if (response.type !== "basic" && response.type !== "cors") return invalid("opaque_response", null);

  const meta = readMeta(response, resource?.nextHopProtocol || null);
  if (response.status !== 200) {
    return { outcome: "http_error", latencyMs: null, response: meta, ...timing };
  }
  if (body !== expectedProbeBody(id)) return invalid("body_mismatch", meta);
  if (response.headers.get("x-blip-provider") !== target.provider) return invalid("provider_mismatch", meta);
  return { outcome: "ok", latencyMs: completedAt - dispatchedAt, response: meta, ...timing };
}
