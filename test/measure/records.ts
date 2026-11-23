import type { Provider } from "../../src/config/targets.ts";
import type {
  AttemptRecord,
  ProbeResult,
  ResponseMeta,
  RunInfo,
  UnsentRangeRecord,
} from "../../src/measure/types.ts";

export function run(overrides: Partial<RunInfo> = {}): RunInfo {
  return {
    runId: "run-1",
    mode: "compare",
    providers: ["cloudflare", "vercel"],
    endpoints: { cloudflare: "https://cf.test", vercel: "https://v.test" },
    uiOrigin: "https://cf.test",
    uiRevision: "rev-a",
    startedAt: 0,
    startedAtWallMs: 1_800_000_000_000,
    endsAt: 600_000,
    endedAt: null,
    endReason: null,
    timeoutMs: 3_000,
    inflightCap: 4,
    warmupMs: 0,
    ...overrides,
  };
}

export function meta(overrides: Partial<ResponseMeta> = {}): ResponseMeta {
  return {
    status: 200,
    revision: "rev-a",
    runtime: null,
    location: null,
    locationKind: null,
    vercelId: null,
    cfRay: null,
    nextHopProtocol: null,
    ...overrides,
  };
}

type AttemptSpec = {
  provider: Provider;
  slot: number;
  intendedAt?: number;
  dispatchedAt?: number;
  latencyMs?: number;
  outcome?: ProbeResult["outcome"];
  runId?: string;
  segment?: number;
  warmup?: boolean;
  response?: Partial<ResponseMeta>;
};

export function attempt(spec: AttemptSpec): AttemptRecord {
  const intendedAt = spec.intendedAt ?? spec.slot * 200;
  const dispatchedAt = spec.dispatchedAt ?? intendedAt;
  const outcome = spec.outcome ?? "ok";
  const latency = spec.latencyMs ?? 10;
  const completedAt = dispatchedAt + latency;
  const response = meta(spec.response);
  let result: ProbeResult;
  if (outcome === "ok") result = { outcome, latencyMs: latency, dispatchedAt, completedAt, response };
  else if (outcome === "invalid_response") {
    result = { outcome, latencyMs: null, invalidReason: "body_mismatch", dispatchedAt, completedAt, response };
  } else if (outcome === "http_error") {
    result = { outcome, latencyMs: null, dispatchedAt, completedAt, response: { ...response, status: 500 } };
  } else result = { outcome, latencyMs: null, dispatchedAt, completedAt, response: null };
  return {
    kind: "attempt",
    runId: spec.runId ?? "run-1",
    segment: spec.segment ?? 1,
    provider: spec.provider,
    targetHz: 5,
    slot: spec.slot,
    pairSeq: spec.slot,
    probeId: `p-${spec.provider}-${spec.slot}`,
    intendedAt,
    sameOrigin: spec.provider === "cloudflare",
    firstInRun: spec.slot === 0,
    firstAfterIdle: spec.slot === 0,
    warmup: spec.warmup ?? false,
    result,
  };
}

export function unsent(
  provider: Provider,
  fromSlot: number,
  count: number,
  reason: UnsentRangeRecord["reason"] = "concurrency_cap",
): UnsentRangeRecord {
  return {
    kind: "unsent",
    runId: "run-1",
    segment: 1,
    provider,
    targetHz: 5,
    reason,
    fromSlot,
    toSlot: fromSlot + count - 1,
    count,
    fromIntendedAt: fromSlot * 200,
    toIntendedAt: (fromSlot + count - 1) * 200,
    suspectedSuspension: reason === "scheduler_gap",
  };
}
