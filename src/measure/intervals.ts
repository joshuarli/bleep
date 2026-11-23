import { PROVIDERS, type Provider } from "../config/targets.ts";
import { buildReport } from "./report.ts";
import type { PhaseBoundary } from "./segments.ts";
import type { EndpointSummary } from "./stats.ts";
import type { MeasurementRecord, Milliseconds, RunInfo } from "./types.ts";

export const PRESET_MARKER_LABELS = [
  "Baseline",
  "Upload started",
  "Download started",
  "Recovery",
  "SQM enabled",
  "SQM disabled",
  "Changed Wi-Fi",
  "Moved to another room",
] as const;

export const MARKER_LABEL_MAX = 80;

export type Marker = { id: string; at: Milliseconds; label: string };

export type Interval = { markerId: string; label: string; fromAt: Milliseconds; toAt: Milliseconds };

export type Experiment = { id: string; baseline: Interval | null };

export function cleanMarkerLabel(label: string): string {
  const cleaned = label.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MARKER_LABEL_MAX);
  if (cleaned === "") throw new Error("a marker needs a label");
  return cleaned;
}

export const sortedMarkers = (markers: readonly Marker[]): Marker[] => [...markers].sort((a, b) => a.at - b.at);

export function intervalsFromMarkers(markers: readonly Marker[], endAt: Milliseconds): Interval[] {
  const sorted = sortedMarkers(markers);
  return sorted.map((marker, i) => ({
    markerId: marker.id,
    label: marker.label,
    fromAt: marker.at,
    toAt: Math.max(marker.at, sorted[i + 1]?.at ?? endAt),
  }));
}

export const phaseBoundaries = (markers: readonly Marker[]): PhaseBoundary[] =>
  sortedMarkers(markers).map((marker) => ({ at: marker.at, label: marker.label }));

export type IntervalSide = {
  provider: Provider;
  segmentIndex: number;
  summary: EndpointSummary;
  medianDeltaMs: number | null;
  p95DeltaMs: number | null;
};

export type IntervalComparisonRow = {
  interval: Interval;
  role: "baseline" | "selected";
  durationMs: Milliseconds;
  spansSegments: boolean;
  sides: IntervalSide[];
};

export type IntervalComparison = {
  rows: IntervalComparisonRow[];
  baselineUsable: boolean;
};

export function lockBaseline(experiment: Experiment, interval: Interval): Experiment {
  if (experiment.baseline !== null) throw new Error("the baseline is locked; clear it to start a new experiment");
  return { id: experiment.id, baseline: { ...interval } };
}

export function compareIntervals(
  records: readonly MeasurementRecord[],
  runs: readonly RunInfo[],
  markers: readonly Marker[],
  selected: readonly Interval[],
  baseline: Interval | null,
): IntervalComparison {
  const reportFor = (interval: Interval) =>
    buildReport({
      records,
      runs,
      markers,
      window: { fromAt: interval.fromAt, toAt: interval.toAt, label: interval.label },
      excludeWarmup: true,
    });
  const baselineReport = baseline === null ? null : reportFor(baseline);
  const baselineRow = baselineReport !== null && baselineReport.rows.length === 1 ? baselineReport.rows[0] : undefined;

  const rowFor = (interval: Interval, role: IntervalComparisonRow["role"]): IntervalComparisonRow => {
    const report = role === "baseline" && baselineReport !== null ? baselineReport : reportFor(interval);
    const sides: IntervalSide[] = [];
    for (const row of report.rows) {
      for (const provider of PROVIDERS) {
        const summary = row.endpoints[provider];
        if (summary === undefined) continue;
        const base = report.rows.length === 1 ? baselineRow?.endpoints[provider] : undefined;
        const delta = (value: number | null, reference: number | null | undefined) =>
          value === null || reference === null || reference === undefined ? null : value - reference;
        sides.push({
          provider,
          segmentIndex: row.segmentIndex,
          summary,
          medianDeltaMs: role === "baseline" ? null : delta(summary.medianMs, base?.medianMs),
          p95DeltaMs: role === "baseline" ? null : delta(summary.p95Ms, base?.p95Ms),
        });
      }
    }
    return { interval, role, durationMs: interval.toAt - interval.fromAt, spansSegments: report.spansSegments, sides };
  };

  const rows: IntervalComparisonRow[] = [];
  if (baseline !== null) rows.push(rowFor(baseline, "baseline"));
  for (const interval of selected) rows.push(rowFor(interval, "selected"));
  return { rows, baselineUsable: baselineRow !== undefined };
}
