import type { Provider } from "../config/targets.ts";

export const ATTEMPT_OUTCOMES = [
  "ok",
  "timeout",
  "network_error",
  "http_error",
  "invalid_response",
  "cancelled",
] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];
export type FailedOutcome = Exclude<AttemptOutcome, "ok">;

export const UNSENT_REASONS = ["concurrency_cap", "deadline_missed", "scheduler_gap"] as const;
export type UnsentReason = (typeof UNSENT_REASONS)[number];

export const INVALID_REASONS = [
  "opaque_redirect",
  "opaque_response",
  "body_mismatch",
  "provider_mismatch",
] as const;
export type InvalidReason = (typeof INVALID_REASONS)[number];

export type Milliseconds = number;

export type Clock = { now(): Milliseconds };

export type TimerHandle = unknown;
export type Timers = {
  setTimeout(callback: () => void, delay: Milliseconds): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
};

export type ProbeFetch = (url: string, init: RequestInit) => Promise<Response>;

export type ResourceDetail = { nextHopProtocol: string | null };
export type ResourceTimingReader = (url: string) => ResourceDetail | null;

export type ResponseMeta = {
  status: number;
  revision: string | null;
  runtime: string | null;
  location: string | null;
  locationKind: string | null;
  vercelId: string | null;
  cfRay: string | null;
  nextHopProtocol: string | null;
};

type ProbeTiming = { dispatchedAt: Milliseconds; completedAt: Milliseconds };

export type ProbeResult = ProbeTiming &
  (
    | { outcome: "ok"; latencyMs: Milliseconds; response: ResponseMeta }
    | { outcome: "invalid_response"; latencyMs: null; invalidReason: InvalidReason; response: ResponseMeta | null }
    | { outcome: "http_error"; latencyMs: null; response: ResponseMeta }
    | { outcome: "timeout" | "network_error" | "cancelled"; latencyMs: null; response: ResponseMeta | null }
  );

export type ProbeTarget = { provider: Provider; origin: string };

export const MODES = ["cloudflare", "vercel", "compare"] as const;
export type Mode = (typeof MODES)[number];

export const SELECTED_RATES = ["normal", "low"] as const;
export type SelectedRate = (typeof SELECTED_RATES)[number];

export type RunId = string;

export type RunInfo = {
  runId: RunId;
  mode: Mode;
  providers: readonly Provider[];
  endpoints: Record<Provider, string>;
  uiOrigin: string;
  uiRevision: string;
  startedAt: Milliseconds;
  startedAtWallMs: number;
  endsAt: Milliseconds;
  endedAt: Milliseconds | null;
  endReason: "stopped" | "session_limit" | null;
  timeoutMs: Milliseconds;
  inflightCap: number;
  warmupMs: Milliseconds;
};

type SlotFields = {
  runId: RunId;
  segment: number;
  provider: Provider;
  targetHz: number;
};

export type AttemptRecord = SlotFields & {
  kind: "attempt";
  slot: number;
  pairSeq: number | null;
  probeId: string;
  intendedAt: Milliseconds;
  sameOrigin: boolean;
  firstInRun: boolean;
  firstAfterIdle: boolean;
  warmup: boolean;
  result: ProbeResult;
};

export type UnsentRangeRecord = SlotFields & {
  kind: "unsent";
  reason: UnsentReason;
  fromSlot: number;
  toSlot: number;
  count: number;
  fromIntendedAt: Milliseconds;
  toIntendedAt: Milliseconds;
  suspectedSuspension: boolean;
};

export type MeasurementRecord = AttemptRecord | UnsentRangeRecord;

export type SessionEvent =
  | { type: "pause"; runId: RunId; at: Milliseconds; reason: "hidden" | "user" }
  | { type: "resume"; runId: RunId; at: Milliseconds; segment: number }
  | { type: "rate"; runId: RunId; at: Milliseconds; targetHz: number; burst: boolean }
  | { type: "end"; runId: RunId; at: Milliseconds; reason: "stopped" | "session_limit" }
  | { type: "longtask"; at: Milliseconds; durationMs: Milliseconds };

export const recordStart = (record: MeasurementRecord): Milliseconds =>
  record.kind === "attempt" ? record.intendedAt : record.fromIntendedAt;

export const recordEnd = (record: MeasurementRecord): Milliseconds =>
  record.kind === "attempt" ? record.intendedAt : record.toIntendedAt;
