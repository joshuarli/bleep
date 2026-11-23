import type { Endpoint } from "../config/endpoints.ts";
import type { BuildTarget, Provider } from "../config/targets.ts";
import type { Experiment, Marker } from "../measure/intervals.ts";
import { buildPairs, SKEW_TOLERANCE_MS, type Pair } from "../measure/pairs.ts";
import { PROBE_TIMEOUT_MS } from "../measure/probe-client.ts";
import type { Report } from "../measure/report.ts";
import { RING_CAPACITY } from "../measure/ring.ts";
import { BURST_COOLDOWN_MS, BURST_MS, RATE_HZ, SCHEDULER_GAP_MS } from "../measure/scheduler.ts";
import { buildSegments, type Segment } from "../measure/segments.ts";
import {
  IDLE_MS,
  INFLIGHT_CAP,
  SESSION_EXTENSION_MS,
  SESSION_LIMIT_MS,
  SESSION_MS,
  WARMUP_MS,
} from "../measure/session.ts";
import { runIndex } from "../measure/stats.ts";
import type { MeasurementRecord, RunInfo, SessionEvent } from "../measure/types.ts";
import { phaseBoundaries } from "../measure/intervals.ts";

export const EXPORT_SCHEMA_VERSION = 1;

export const SAMPLING = {
  ratesHz: RATE_HZ,
  burstMs: BURST_MS,
  burstCooldownMs: BURST_COOLDOWN_MS,
  lateThreshold: "min(interval / 2, 100 ms)",
  schedulerGapMs: SCHEDULER_GAP_MS,
  timeoutMs: PROBE_TIMEOUT_MS,
  inflightCap: INFLIGHT_CAP,
  sessionMs: SESSION_MS,
  sessionExtensionMs: SESSION_EXTENSION_MS,
  sessionLimitMs: SESSION_LIMIT_MS,
  compareWarmupMs: WARMUP_MS,
  idleMs: IDLE_MS,
  skewToleranceMs: SKEW_TOLERANCE_MS,
  ringCapacity: RING_CAPACITY,
} as const;

export type Retention = {
  records: number;
  discarded: number;
  earlierSamplesLost: boolean;
  fromAt: number | null;
  toAt: number | null;
  eventsDiscarded: number;
};

export type ExportApp = {
  name: "blip-monitor";
  version: string;
  frontendRevision: string;
  buildTarget: BuildTarget;
  uiOrigin: string;
};

export type ExportDocument = {
  schemaVersion: typeof EXPORT_SCHEMA_VERSION;
  app: ExportApp;
  exportedAtWallMs: number;
  timeOriginWallMs: number;
  timeBase: "milliseconds since timeOriginWallMs, from the page's monotonic clock";
  endpoints: Record<Provider, Pick<Endpoint, "origin" | "configuredLocation">>;
  sampling: typeof SAMPLING;
  retention: Retention;
  runs: RunInfo[];
  records: MeasurementRecord[];
  events: SessionEvent[];
  markers: Marker[];
  experiment: Experiment;
  segments: Segment[];
  pairs: Pair[];
  displayed: Report | null;
};

export type ExportSnapshot = {
  app: ExportApp;
  exportedAtWallMs: number;
  timeOriginWallMs: number;
  endpoints: Record<Provider, Endpoint>;
  retention: Retention;
  runs: readonly RunInfo[];
  records: readonly MeasurementRecord[];
  events: readonly SessionEvent[];
  markers: readonly Marker[];
  experiment: Experiment;
  displayed: Report | null;
};

export function buildExport(snapshot: ExportSnapshot): ExportDocument {
  const runs = runIndex(snapshot.runs);
  const { segments } = buildSegments(snapshot.records, runs, phaseBoundaries(snapshot.markers));
  const { pairs } = buildPairs(snapshot.records, runs, { fromAt: Number.NEGATIVE_INFINITY, toAt: Number.POSITIVE_INFINITY });
  const endpoint = (provider: Provider) => ({
    origin: snapshot.endpoints[provider].origin,
    configuredLocation: snapshot.endpoints[provider].configuredLocation,
  });
  return structuredClone({
    schemaVersion: EXPORT_SCHEMA_VERSION,
    app: snapshot.app,
    exportedAtWallMs: snapshot.exportedAtWallMs,
    timeOriginWallMs: snapshot.timeOriginWallMs,
    timeBase: "milliseconds since timeOriginWallMs, from the page's monotonic clock",
    endpoints: { cloudflare: endpoint("cloudflare"), vercel: endpoint("vercel") },
    sampling: SAMPLING,
    retention: snapshot.retention,
    runs: [...snapshot.runs],
    records: [...snapshot.records],
    events: [...snapshot.events],
    markers: [...snapshot.markers],
    experiment: snapshot.experiment,
    segments,
    pairs,
    displayed: snapshot.displayed,
  });
}

export const exportJson = (document: ExportDocument): string => `${JSON.stringify(document, null, 1)}\n`;

export function parseExportJson(text: string): ExportDocument {
  const parsed = JSON.parse(text) as Partial<ExportDocument>;
  if (parsed.schemaVersion !== EXPORT_SCHEMA_VERSION) {
    throw new Error(`unsupported export schemaVersion ${String(parsed.schemaVersion)}`);
  }
  for (const key of ["app", "runs", "records", "markers", "experiment", "retention"] as const) {
    if (parsed[key] === undefined) throw new Error(`export is missing ${key}`);
  }
  return parsed as ExportDocument;
}
