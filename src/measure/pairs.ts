import { ascending, inWindow, median, type Window } from "./stats.ts";
import type { AttemptRecord, MeasurementRecord, Milliseconds, RunInfo } from "./types.ts";

export const SKEW_TOLERANCE_MS = 5;

export const PAIR_CATEGORIES = [
  "both_ok",
  "cloudflare_only",
  "vercel_only",
  "neither_valid",
  "not_fully_sent",
] as const;
export type PairCategory = (typeof PAIR_CATEGORIES)[number];

type Side = { kind: "attempt"; record: AttemptRecord } | { kind: "unsent" };

export type Pair = {
  runId: string;
  pairSeq: number;
  intendedAt: Milliseconds;
  category: PairCategory;
  skewMs: Milliseconds | null;
  skewFlagged: boolean;
  differenceMs: Milliseconds | null;
  warmup: boolean;
};

export type PairSummary = {
  counts: Record<PairCategory, number>;
  pairs: number;
  incomplete: number;
  skewFlagged: number;
  warmupExcluded: number;
  differenceCount: number;
  medianDifferenceMs: number | null;
};

const okLatency = (side: Side): Milliseconds | null =>
  side.kind === "attempt" && side.record.result.outcome === "ok" ? side.record.result.latencyMs : null;

const notSent = (side: Side) => side.kind === "unsent" || side.record.result.outcome === "cancelled";

function categorize(cloudflare: Side, vercel: Side): PairCategory {
  const cf = okLatency(cloudflare) !== null;
  const v = okLatency(vercel) !== null;
  if (cf && v) return "both_ok";
  if (cf) return "cloudflare_only";
  if (v) return "vercel_only";
  return notSent(cloudflare) || notSent(vercel) ? "not_fully_sent" : "neither_valid";
}

export function buildPairs(
  records: Iterable<MeasurementRecord>,
  runs: ReadonlyMap<string, RunInfo>,
  window: Window,
): { pairs: Pair[]; incomplete: number } {
  const sides = new Map<string, { runId: string; pairSeq: number; intendedAt: number; cloudflare?: Side; vercel?: Side }>();
  const slot = (runId: string, pairSeq: number, intendedAt: number) => {
    const key = `${runId}:${pairSeq}`;
    let entry = sides.get(key);
    if (entry === undefined) {
      entry = { runId, pairSeq, intendedAt };
      sides.set(key, entry);
    }
    return entry;
  };

  for (const record of records) {
    if (runs.get(record.runId)?.mode !== "compare") continue;
    if (record.kind === "attempt") {
      if (record.pairSeq === null || !inWindow(record.intendedAt, window)) continue;
      slot(record.runId, record.pairSeq, record.intendedAt)[record.provider] = { kind: "attempt", record };
      continue;
    }
    const interval = record.count === 1 ? 0 : (record.toIntendedAt - record.fromIntendedAt) / (record.count - 1);
    for (let i = 0; i < record.count; i++) {
      const at = record.fromIntendedAt + i * interval;
      if (!inWindow(at, window)) continue;
      slot(record.runId, record.fromSlot + i, at)[record.provider] = { kind: "unsent" };
    }
  }

  const pairs: Pair[] = [];
  let incomplete = 0;
  for (const entry of sides.values()) {
    const { cloudflare, vercel } = entry;
    if (cloudflare === undefined || vercel === undefined) {
      incomplete++;
      continue;
    }
    const category = categorize(cloudflare, vercel);
    const skewMs =
      cloudflare.kind === "attempt" && vercel.kind === "attempt"
        ? Math.abs(cloudflare.record.result.dispatchedAt - vercel.record.result.dispatchedAt)
        : null;
    const cloudflareMs = okLatency(cloudflare);
    const vercelMs = okLatency(vercel);
    const differenceMs = cloudflareMs !== null && vercelMs !== null ? vercelMs - cloudflareMs : null;
    const run = runs.get(entry.runId);
    pairs.push({
      runId: entry.runId,
      pairSeq: entry.pairSeq,
      intendedAt: entry.intendedAt,
      category,
      skewMs,
      skewFlagged: skewMs !== null && skewMs > SKEW_TOLERANCE_MS,
      differenceMs,
      warmup: run !== undefined && entry.intendedAt < run.startedAt + run.warmupMs,
    });
  }
  pairs.sort((a, b) => a.intendedAt - b.intendedAt || a.pairSeq - b.pairSeq);
  return { pairs, incomplete };
}

export function summarizePairs(
  pairs: readonly Pair[],
  incomplete: number,
  options: { excludeWarmup: boolean },
): PairSummary {
  const counts = Object.fromEntries(PAIR_CATEGORIES.map((c) => [c, 0])) as Record<PairCategory, number>;
  const differences: number[] = [];
  let skewFlagged = 0;
  let warmupExcluded = 0;
  let total = 0;
  for (const pair of pairs) {
    if (options.excludeWarmup && pair.warmup) {
      warmupExcluded++;
      continue;
    }
    total++;
    counts[pair.category]++;
    if (pair.skewFlagged) skewFlagged++;
    if (pair.differenceMs !== null && !pair.skewFlagged) differences.push(pair.differenceMs);
  }
  return {
    counts,
    pairs: total,
    incomplete,
    skewFlagged,
    warmupExcluded,
    differenceCount: differences.length,
    medianDifferenceMs: median(ascending(differences)),
  };
}
