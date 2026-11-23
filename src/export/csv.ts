import { PROVIDERS, type Provider } from "../config/targets.ts";
import type { Experiment, Marker } from "../measure/intervals.ts";
import type { Segment } from "../measure/segments.ts";
import {
  ATTEMPT_OUTCOMES,
  END_REASONS,
  INVALID_REASONS,
  MODES,
  UNSENT_REASONS,
  type AttemptRecord,
  type InvalidReason,
  type MeasurementRecord,
  type ProbeResult,
  type ResponseMeta,
  type RunInfo,
  type UnsentRangeRecord,
} from "../measure/types.ts";
import type { ExportDocument, Retention } from "./document.ts";

export const CSV_RECORD_TYPES = ["run", "attempt", "unsent_range", "marker", "segment"] as const;
export type CsvRecordType = (typeof CSV_RECORD_TYPES)[number];

type Cell = string | number | boolean | null;

const TEXT_COLUMNS = new Set([
  "app_version",
  "frontend_revision",
  "ui_origin",
  "ui_revision",
  "cloudflare_origin",
  "vercel_origin",
  "cloudflare_configured_location",
  "vercel_configured_location",
  "run_id",
  "probe_id",
  "backend_revision",
  "runtime",
  "location",
  "location_kind",
  "x_vercel_id",
  "cf_ray",
  "next_hop_protocol",
  "label",
  "phase",
  "cloudflare_location",
  "vercel_location",
  "cloudflare_revision",
  "vercel_revision",
  "marker_id",
  "experiment_id",
]);

export const CSV_COLUMNS = [
  "record_type",
  "run_id",
  "segment",
  "provider",
  "app_version",
  "frontend_revision",
  "build_target",
  "ui_origin",
  "ui_revision",
  "mode",
  "cloudflare_origin",
  "vercel_origin",
  "cloudflare_configured_location",
  "vercel_configured_location",
  "started_at_ms",
  "started_at_wall_ms",
  "time_origin_wall_ms",
  "ends_at_ms",
  "ended_at_ms",
  "end_reason",
  "timeout_ms",
  "inflight_cap",
  "warmup_ms",
  "rate_normal_hz",
  "rate_low_hz",
  "rate_burst_hz",
  "late_threshold",
  "retained_records",
  "discarded_records",
  "earlier_samples_lost",
  "retained_from_ms",
  "retained_to_ms",
  "slot",
  "pair_seq",
  "probe_id",
  "intended_at_ms",
  "dispatched_at_ms",
  "completed_at_ms",
  "dispatch_skew_ms",
  "latency_ms",
  "outcome",
  "invalid_reason",
  "http_status",
  "same_origin",
  "first_in_run",
  "first_after_idle",
  "warmup",
  "target_hz",
  "backend_revision",
  "runtime",
  "location",
  "location_kind",
  "x_vercel_id",
  "cf_ray",
  "next_hop_protocol",
  "unsent_reason",
  "from_slot",
  "to_slot",
  "unsent_count",
  "from_intended_at_ms",
  "to_intended_at_ms",
  "suspected_suspension",
  "marker_id",
  "at_ms",
  "label",
  "experiment_id",
  "baseline_from_ms",
  "baseline_to_ms",
  "segment_index",
  "from_at_ms",
  "to_at_ms",
  "start_reasons",
  "phase",
  "cloudflare_location",
  "vercel_location",
  "cloudflare_revision",
  "vercel_revision",
  "revision_mismatch",
] as const;
export type CsvColumn = (typeof CSV_COLUMNS)[number];
type Row = Partial<Record<CsvColumn, Cell>>;

const FORMULA_START = /^[=+\-@\t\r']/;

export const neutralizeFormula = (text: string): string => (FORMULA_START.test(text) ? `'${text}` : text);
const restoreFormula = (text: string): string => (text.startsWith("'") ? text.slice(1) : text);

function quote(field: string): string {
  return /[",\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
}

function encodeCell(column: CsvColumn, value: Cell | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return quote(TEXT_COLUMNS.has(column) ? neutralizeFormula(value) : value);
  return String(value);
}

function runRow(document: ExportDocument, run: RunInfo): Row {
  const retention: Retention = document.retention;
  return {
    record_type: "run",
    run_id: run.runId,
    app_version: document.app.version,
    frontend_revision: document.app.frontendRevision,
    build_target: document.app.buildTarget,
    ui_origin: run.uiOrigin,
    ui_revision: run.uiRevision,
    mode: run.mode,
    cloudflare_origin: run.endpoints.cloudflare,
    vercel_origin: run.endpoints.vercel,
    cloudflare_configured_location: document.endpoints.cloudflare.configuredLocation,
    vercel_configured_location: document.endpoints.vercel.configuredLocation,
    started_at_ms: run.startedAt,
    started_at_wall_ms: run.startedAtWallMs,
    time_origin_wall_ms: document.timeOriginWallMs,
    ends_at_ms: run.endsAt,
    ended_at_ms: run.endedAt,
    end_reason: run.endReason,
    timeout_ms: run.timeoutMs,
    inflight_cap: run.inflightCap,
    warmup_ms: run.warmupMs,
    rate_normal_hz: document.sampling.ratesHz.normal,
    rate_low_hz: document.sampling.ratesHz.low,
    rate_burst_hz: document.sampling.ratesHz.burst,
    late_threshold: document.sampling.lateThreshold,
    retained_records: retention.records,
    discarded_records: retention.discarded,
    earlier_samples_lost: retention.earlierSamplesLost,
    retained_from_ms: retention.fromAt,
    retained_to_ms: retention.toAt,
    experiment_id: document.experiment.id,
  };
}

function attemptRow(record: AttemptRecord, skew: Map<string, number | null>): Row {
  const result = record.result;
  const response = result.response;
  return {
    record_type: "attempt",
    run_id: record.runId,
    segment: record.segment,
    provider: record.provider,
    slot: record.slot,
    pair_seq: record.pairSeq,
    probe_id: record.probeId,
    intended_at_ms: record.intendedAt,
    dispatched_at_ms: result.dispatchedAt,
    completed_at_ms: result.completedAt,
    dispatch_skew_ms: record.pairSeq === null ? null : (skew.get(`${record.runId}:${record.pairSeq}`) ?? null),
    latency_ms: result.latencyMs,
    outcome: result.outcome,
    invalid_reason: result.outcome === "invalid_response" ? result.invalidReason : null,
    http_status: response?.status ?? null,
    same_origin: record.sameOrigin,
    first_in_run: record.firstInRun,
    first_after_idle: record.firstAfterIdle,
    warmup: record.warmup,
    target_hz: record.targetHz,
    backend_revision: response?.revision ?? null,
    runtime: response?.runtime ?? null,
    location: response?.location ?? null,
    location_kind: response?.locationKind ?? null,
    x_vercel_id: response?.vercelId ?? null,
    cf_ray: response?.cfRay ?? null,
    next_hop_protocol: response?.nextHopProtocol ?? null,
  };
}

function unsentRow(record: UnsentRangeRecord): Row {
  return {
    record_type: "unsent_range",
    run_id: record.runId,
    segment: record.segment,
    provider: record.provider,
    target_hz: record.targetHz,
    unsent_reason: record.reason,
    from_slot: record.fromSlot,
    to_slot: record.toSlot,
    unsent_count: record.count,
    from_intended_at_ms: record.fromIntendedAt,
    to_intended_at_ms: record.toIntendedAt,
    suspected_suspension: record.suspectedSuspension,
  };
}

function markerRow(marker: Marker, experiment: Experiment): Row {
  const baseline = experiment.baseline?.markerId === marker.id ? experiment.baseline : null;
  return {
    record_type: "marker",
    marker_id: marker.id,
    at_ms: marker.at,
    label: marker.label,
    experiment_id: experiment.id,
    baseline_from_ms: baseline?.fromAt ?? null,
    baseline_to_ms: baseline?.toAt ?? null,
  };
}

function segmentRow(segment: Segment): Row {
  return {
    record_type: "segment",
    run_id: segment.runId,
    segment: segment.sessionSegment,
    segment_index: segment.index,
    from_at_ms: segment.fromAt,
    to_at_ms: segment.toAt,
    start_reasons: segment.startReasons.join(" "),
    phase: segment.phase,
    ui_revision: segment.uiRevision,
    cloudflare_location: segment.locations.cloudflare,
    vercel_location: segment.locations.vercel,
    cloudflare_revision: segment.revisions.cloudflare,
    vercel_revision: segment.revisions.vercel,
    revision_mismatch: segment.revisionMismatch,
  };
}

export function exportCsv(document: ExportDocument): string {
  const skew = new Map(document.pairs.map((pair) => [`${pair.runId}:${pair.pairSeq}`, pair.skewMs]));
  const rows: Row[] = [
    ...document.runs.map((run) => runRow(document, run)),
    ...document.records.map((record) => (record.kind === "attempt" ? attemptRow(record, skew) : unsentRow(record))),
    ...document.markers.map((marker) => markerRow(marker, document.experiment)),
    ...document.segments.map(segmentRow),
  ];
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) lines.push(CSV_COLUMNS.map((column) => encodeCell(column, row[column])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (char === '"') quoted = false;
      else field += char;
      i++;
      continue;
    }
    if (char === '"' && field === "") quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\r" && text[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
    i++;
  }
  if (quoted) throw new Error("unterminated quoted CSV field");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export type CsvExport = {
  runs: RunInfo[];
  records: MeasurementRecord[];
  markers: Marker[];
  experiment: Experiment;
  retention: Retention;
};

class CsvRecord {
  private readonly cells: Map<string, string>;
  private readonly line: number;

  constructor(header: readonly string[], values: readonly string[], line: number) {
    if (values.length !== header.length) throw new Error(`CSV line ${line}: ${values.length} fields, expected ${header.length}`);
    this.cells = new Map(header.map((name, i) => [name, values[i] ?? ""]));
    this.line = line;
  }

  text(column: CsvColumn): string | null {
    const raw = this.cells.get(column);
    if (raw === undefined) throw new Error(`CSV is missing column ${column}`);
    if (raw === "") return null;
    return TEXT_COLUMNS.has(column) ? restoreFormula(raw) : raw;
  }

  required(column: CsvColumn): string {
    const value = this.text(column);
    if (value === null) throw new Error(`CSV line ${this.line}: ${column} is empty`);
    return value;
  }

  number(column: CsvColumn): number | null {
    const value = this.text(column);
    if (value === null) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`CSV line ${this.line}: ${column} is not a number`);
    return parsed;
  }

  requiredNumber(column: CsvColumn): number {
    const value = this.number(column);
    if (value === null) throw new Error(`CSV line ${this.line}: ${column} is empty`);
    return value;
  }

  boolean(column: CsvColumn): boolean {
    const value = this.required(column);
    if (value !== "true" && value !== "false") throw new Error(`CSV line ${this.line}: ${column} is not a boolean`);
    return value === "true";
  }

  optionalOneOf<T extends string>(column: CsvColumn, allowed: readonly T[]): T | null {
    return this.text(column) === null ? null : this.oneOf(column, allowed);
  }

  oneOf<T extends string>(column: CsvColumn, allowed: readonly T[]): T {
    const value = this.required(column);
    if (!(allowed as readonly string[]).includes(value)) throw new Error(`CSV line ${this.line}: ${column} ${value}`);
    return value as T;
  }
}

function parseResult(row: CsvRecord): ProbeResult {
  const outcome = row.oneOf("outcome", ATTEMPT_OUTCOMES);
  const status = row.number("http_status");
  const response: ResponseMeta | null =
    status === null
      ? null
      : {
          status,
          revision: row.text("backend_revision"),
          runtime: row.text("runtime"),
          location: row.text("location"),
          locationKind: row.text("location_kind"),
          vercelId: row.text("x_vercel_id"),
          cfRay: row.text("cf_ray"),
          nextHopProtocol: row.text("next_hop_protocol"),
        };
  const timing = { dispatchedAt: row.requiredNumber("dispatched_at_ms"), completedAt: row.requiredNumber("completed_at_ms") };
  if (outcome === "ok") {
    if (response === null) throw new Error("an ok attempt needs a response");
    return { outcome, latencyMs: row.requiredNumber("latency_ms"), response, ...timing };
  }
  if (row.number("latency_ms") !== null) throw new Error(`a ${outcome} attempt must not carry a latency`);
  if (outcome === "invalid_response") {
    const invalidReason: InvalidReason = row.oneOf("invalid_reason", INVALID_REASONS);
    return { outcome, latencyMs: null, invalidReason, response, ...timing };
  }
  if (outcome === "http_error") {
    if (response === null) throw new Error("an http_error attempt needs a response");
    return { outcome, latencyMs: null, response, ...timing };
  }
  return { outcome, latencyMs: null, response, ...timing };
}

export function parseExportCsv(text: string): CsvExport {
  const [header, ...body] = parseCsvRows(text);
  if (header === undefined) throw new Error("empty CSV export");
  for (const column of CSV_COLUMNS) {
    if (!header.includes(column)) throw new Error(`CSV is missing column ${column}`);
  }
  const runs: RunInfo[] = [];
  const records: MeasurementRecord[] = [];
  const markers: Marker[] = [];
  let experimentId: string | null = null;
  let baseline: Experiment["baseline"] = null;
  let retention: Retention | null = null;

  body.forEach((values, index) => {
    const row = new CsvRecord(header, values, index + 2);
    const type = row.oneOf("record_type", CSV_RECORD_TYPES);
    const provider = (): Provider => row.oneOf("provider", PROVIDERS);
    if (type === "run") {
      const mode = row.oneOf("mode", MODES);
      runs.push({
        runId: row.required("run_id"),
        mode,
        providers: mode === "compare" ? PROVIDERS : [mode],
        endpoints: { cloudflare: row.required("cloudflare_origin"), vercel: row.required("vercel_origin") },
        uiOrigin: row.required("ui_origin"),
        uiRevision: row.required("ui_revision"),
        startedAt: row.requiredNumber("started_at_ms"),
        startedAtWallMs: row.requiredNumber("started_at_wall_ms"),
        endsAt: row.requiredNumber("ends_at_ms"),
        endedAt: row.number("ended_at_ms"),
        endReason: row.optionalOneOf("end_reason", END_REASONS),
        timeoutMs: row.requiredNumber("timeout_ms"),
        inflightCap: row.requiredNumber("inflight_cap"),
        warmupMs: row.requiredNumber("warmup_ms"),
      });
      retention = {
        records: row.requiredNumber("retained_records"),
        discarded: row.requiredNumber("discarded_records"),
        earlierSamplesLost: row.boolean("earlier_samples_lost"),
        fromAt: row.number("retained_from_ms"),
        toAt: row.number("retained_to_ms"),
        eventsDiscarded: 0,
      };
      experimentId = row.required("experiment_id");
    } else if (type === "attempt") {
      records.push({
        kind: "attempt",
        runId: row.required("run_id"),
        segment: row.requiredNumber("segment"),
        provider: provider(),
        targetHz: row.requiredNumber("target_hz"),
        slot: row.requiredNumber("slot"),
        pairSeq: row.number("pair_seq"),
        probeId: row.required("probe_id"),
        intendedAt: row.requiredNumber("intended_at_ms"),
        sameOrigin: row.boolean("same_origin"),
        firstInRun: row.boolean("first_in_run"),
        firstAfterIdle: row.boolean("first_after_idle"),
        warmup: row.boolean("warmup"),
        result: parseResult(row),
      });
    } else if (type === "unsent_range") {
      records.push({
        kind: "unsent",
        runId: row.required("run_id"),
        segment: row.requiredNumber("segment"),
        provider: provider(),
        targetHz: row.requiredNumber("target_hz"),
        reason: row.oneOf("unsent_reason", UNSENT_REASONS),
        fromSlot: row.requiredNumber("from_slot"),
        toSlot: row.requiredNumber("to_slot"),
        count: row.requiredNumber("unsent_count"),
        fromIntendedAt: row.requiredNumber("from_intended_at_ms"),
        toIntendedAt: row.requiredNumber("to_intended_at_ms"),
        suspectedSuspension: row.boolean("suspected_suspension"),
      });
    } else if (type === "marker") {
      const marker = { id: row.required("marker_id"), at: row.requiredNumber("at_ms"), label: row.required("label") };
      markers.push(marker);
      const fromAt = row.number("baseline_from_ms");
      const toAt = row.number("baseline_to_ms");
      if (fromAt !== null && toAt !== null) baseline = { markerId: marker.id, label: marker.label, fromAt, toAt };
    }
  });

  if (retention === null || experimentId === null) throw new Error("CSV export has no run rows");
  return { runs, records, markers, experiment: { id: experimentId, baseline }, retention };
}
