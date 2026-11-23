import type { Provider } from "../config/targets.ts";
import { phaseBoundaries, type Marker } from "./intervals.ts";
import { buildPairs, summarizePairs, type PairSummary } from "./pairs.ts";
import { buildSegments, type Segment } from "./segments.ts";
import { runIndex, summarizeEndpoint, type EndpointSummary, type Window } from "./stats.ts";
import type { MeasurementRecord, RunInfo } from "./types.ts";

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
  const { segments } = buildSegments(input.records, runs, phaseBoundaries(input.markers));

  const rows: ReportRow[] = [];
  segments.forEach((segment, index) => {
    const spanEnd = segments[index + 1]?.fromAt ?? Number.POSITIVE_INFINITY;
    const window = {
      fromAt: Math.max(input.window.fromAt, segment.fromAt),
      toAt: Math.min(input.window.toAt, spanEnd),
    };
    if (window.toAt <= window.fromAt) return;
    const run = runs.get(segment.runId);
    const endpoints: Partial<Record<Provider, EndpointSummary>> = {};
    let scheduled = 0;
    for (const provider of run?.providers ?? []) {
      const raw = summarizeEndpoint(provider, input.records, window, runs, { excludeWarmup: false });
      scheduled += raw.sent + raw.unsent;
      endpoints[provider] = input.excludeWarmup
        ? summarizeEndpoint(provider, input.records, window, runs, { excludeWarmup: true })
        : raw;
    }
    if (scheduled === 0) return;
    let pairs: PairSummary | null = null;
    if (run?.mode === "compare") {
      const built = buildPairs(input.records, runs, window);
      pairs = summarizePairs(built.pairs, built.incomplete, { excludeWarmup: input.excludeWarmup });
    }
    rows.push({
      segmentIndex: segment.index,
      runId: segment.runId,
      fromAt: window.fromAt,
      toAt: Math.max(window.fromAt, Math.min(window.toAt, segment.toAt)),
      phase: segment.phase,
      startReasons: segment.startReasons,
      locations: segment.locations,
      revisions: segment.revisions,
      revisionMismatch: segment.revisionMismatch,
      endpoints,
      pairs,
    });
  });
  return { window: input.window, excludeWarmup: input.excludeWarmup, spansSegments: rows.length > 1, rows };
}
