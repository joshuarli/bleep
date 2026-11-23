import type { Provider } from "../config/targets.ts";
import type { AttemptRecord, FailedOutcome, MeasurementRecord, Milliseconds, RunInfo, UnsentRangeRecord } from "./types.ts";

export type Window = { fromAt: Milliseconds; toAt: Milliseconds };

export function nearestRank(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1] ?? null;
}

export const median = (sorted: readonly number[]) => nearestRank(sorted, 0.5);
export const p95 = (sorted: readonly number[]) => nearestRank(sorted, 0.95);

export const ascending = (values: Iterable<number>): number[] => [...values].sort((a, b) => a - b);

export type EndpointSummary = {
  provider: Provider;
  sent: number;
  attempted: number;
  ok: number;
  failures: Record<Exclude<FailedOutcome, "cancelled">, number>;
  failed: number;
  cancelled: number;
  unsent: number;
  coverage: number | null;
  latestMs: number | null;
  medianMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  lastOkAt: Milliseconds | null;
};

export const inWindow = (at: Milliseconds, window: Window): boolean => at >= window.fromAt && at < window.toAt;

export function unsentSlotsIn(record: UnsentRangeRecord, window: Window): number {
  if (record.count === 1) return inWindow(record.fromIntendedAt, window) ? 1 : 0;
  const interval = (record.toIntendedAt - record.fromIntendedAt) / (record.count - 1);
  const first = Math.max(0, Math.ceil((window.fromAt - record.fromIntendedAt) / interval - 1e-9));
  const last = Math.min(record.count - 1, Math.ceil((window.toAt - record.fromIntendedAt) / interval - 1e-9) - 1);
  return Math.max(0, last - first + 1);
}

export type SummaryOptions = { excludeWarmup: boolean };

export function summarizeEndpoint(
  provider: Provider,
  records: Iterable<MeasurementRecord>,
  window: Window,
  runs: ReadonlyMap<string, RunInfo>,
  options: SummaryOptions,
): EndpointSummary {
  const latencies: number[] = [];
  const failures = { timeout: 0, network_error: 0, http_error: 0, invalid_response: 0 };
  let sent = 0;
  let cancelled = 0;
  let unsent = 0;
  let latest: AttemptRecord | null = null;
  let lastOkAt: number | null = null;

  for (const record of records) {
    if (record.provider !== provider) continue;
    if (record.kind === "unsent") {
      if (options.excludeWarmup) {
        const run = runs.get(record.runId);
        const warmupEnd = run === undefined ? window.fromAt : run.startedAt + run.warmupMs;
        unsent += unsentSlotsIn(record, { fromAt: Math.max(window.fromAt, warmupEnd), toAt: window.toAt });
      } else {
        unsent += unsentSlotsIn(record, window);
      }
      continue;
    }
    if (!inWindow(record.intendedAt, window)) continue;
    if (options.excludeWarmup && record.warmup) continue;
    sent++;
    const result = record.result;
    if (result.outcome === "ok") {
      latencies.push(result.latencyMs);
      if (latest === null || record.intendedAt > latest.intendedAt) latest = record;
      if (lastOkAt === null || result.completedAt > lastOkAt) lastOkAt = result.completedAt;
    } else if (result.outcome === "cancelled") {
      cancelled++;
    } else {
      failures[result.outcome]++;
    }
  }

  const sorted = ascending(latencies);
  const ok = sorted.length;
  const failed = failures.timeout + failures.network_error + failures.http_error + failures.invalid_response;
  const attempted = ok + failed;
  const slots = attempted + unsent;
  return {
    provider,
    sent,
    attempted,
    ok,
    failures,
    failed,
    cancelled,
    unsent,
    coverage: slots === 0 ? null : ok / slots,
    latestMs: latest?.result.latencyMs ?? null,
    medianMs: median(sorted),
    p95Ms: p95(sorted),
    maxMs: sorted.at(-1) ?? null,
    lastOkAt,
  };
}

export const runIndex = (runs: Iterable<RunInfo>): Map<string, RunInfo> =>
  new Map([...runs].map((run) => [run.runId, run]));
