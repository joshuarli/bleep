import type { PhaseBoundary } from "./segments.ts";
import type { Milliseconds } from "./types.ts";

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
