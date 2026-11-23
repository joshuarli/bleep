import type { Provider } from "../config/targets.ts";
import { phaseBoundaries, type Marker } from "./intervals.ts";
import { buildPairs, summarizePairs, type PairSummary } from "./pairs.ts";
import { buildSegments, type Segment } from "./segments.ts";
import { runIndex, summarizeEndpoint, type EndpointSummary, type Window } from "./stats.ts";
import { recordStart, type MeasurementRecord, type RunInfo } from "./types.ts";

export type ReportWindow = Window & { label: string };

export type ReportRow = {
  segmentIndex: number;
  runId: string;
  fromAt: number;
  toAt: number;
  phase: string | null;
  startReasons: Segment["startReasons"];
  locations: Segment["locations"];
  revisions: Segment["revisions"];
  revisionMismatch: boolean;
  endpoints: Partial<Record<Provider, EndpointSummary>>;
  pairs: PairSummary | null;
};

export type Report = {
  window: ReportWindow;
  excludeWarmup: boolean;
  spansSegments: boolean;
  rows: ReportRow[];
};

export type ReportInput = {
  records: readonly MeasurementRecord[];
  runs: readonly RunInfo[];
  markers: readonly Marker[];
  window: ReportWindow;
  excludeWarmup: boolean;
};

export function buildReport(input: ReportInput): Report {
  const runs = runIndex(input.runs);
  const { segments, segmentOf } = buildSegments(input.records, runs, phaseBoundaries(input.markers));
  const bySegment = new Map<number, MeasurementRecord[]>();
  for (const record of input.records) {
    const index = segmentOf.get(record);
    if (index === undefined) continue;
    let list = bySegment.get(index);
    if (list === undefined) bySegment.set(index, (list = []));
    list.push(record);
  }

  const rows: ReportRow[] = [];
  for (const segment of segments) {
    const records = bySegment.get(segment.index) ?? [];
    const touches = records.some((record) =>
      record.kind === "attempt"
        ? record.intendedAt >= input.window.fromAt && record.intendedAt < input.window.toAt
        : record.toIntendedAt >= input.window.fromAt && recordStart(record) < input.window.toAt,
    );
    if (!touches) continue;
    const run = runs.get(segment.runId);
    const endpoints: Partial<Record<Provider, EndpointSummary>> = {};
    for (const provider of run?.providers ?? []) {
      endpoints[provider] = summarizeEndpoint(provider, records, input.window, runs, {
        excludeWarmup: input.excludeWarmup,
      });
    }
    let pairs: PairSummary | null = null;
    if (run?.mode === "compare") {
      const built = buildPairs(records, runs, input.window);
      pairs = summarizePairs(built.pairs, built.incomplete, { excludeWarmup: input.excludeWarmup });
    }
    rows.push({
      segmentIndex: segment.index,
      runId: segment.runId,
      fromAt: Math.max(segment.fromAt, input.window.fromAt),
      toAt: Math.min(segment.toAt, input.window.toAt),
      phase: segment.phase,
      startReasons: segment.startReasons,
      locations: segment.locations,
      revisions: segment.revisions,
      revisionMismatch: segment.revisionMismatch,
      endpoints,
      pairs,
    });
  }
  return { window: input.window, excludeWarmup: input.excludeWarmup, spansSegments: rows.length > 1, rows };
}
