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
