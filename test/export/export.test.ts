import assert from "node:assert/strict";
import { test } from "node:test";
import { ENDPOINTS_BY_TARGET } from "../../src/config/endpoints.ts";
import { exportCsv, parseCsvRows, parseExportCsv } from "../../src/export/csv.ts";
import { buildExport, exportJson, parseExportJson, type ExportSnapshot } from "../../src/export/document.ts";
import { intervalsFromMarkers, type Marker } from "../../src/measure/intervals.ts";
import { buildReport } from "../../src/measure/report.ts";
import type { MeasurementRecord } from "../../src/measure/types.ts";
import { attempt, run, unsent } from "../measure/records.ts";

const MARKERS: Marker[] = [
  { id: "m1", at: 0, label: "Baseline" },
  { id: "m2", at: 1_000, label: '=HYPERLINK("http://x","click"), then "quoted"\nnext line' },
  { id: "m3", at: 1_600, label: "-5 dB after SQM, @home" },
];

function snapshot(): ExportSnapshot {
  const records: MeasurementRecord[] = [
    attempt({ provider: "cloudflare", slot: 0, latencyMs: 12.25, warmup: true, response: { location: "SJC", cfRay: "abc-SJC", nextHopProtocol: "h2" } }),
    attempt({ provider: "vercel", slot: 0, latencyMs: 30.5, dispatchedAt: 1, warmup: true, response: { location: "sfo1", vercelId: "sfo1::x" } }),
    attempt({ provider: "cloudflare", slot: 1, outcome: "timeout" }),
    attempt({ provider: "vercel", slot: 1, outcome: "network_error" }),
    attempt({ provider: "cloudflare", slot: 2, outcome: "http_error" }),
    attempt({ provider: "vercel", slot: 2, outcome: "invalid_response" }),
    attempt({ provider: "cloudflare", slot: 3, outcome: "cancelled" }),
    unsent("vercel", 3, 2, "concurrency_cap"),
    unsent("cloudflare", 4, 1, "deadline_missed"),
    unsent("cloudflare", 5, 4, "scheduler_gap"),
    attempt({ provider: "cloudflare", slot: 9, latencyMs: 15, segment: 2, response: { location: "LAX" } }),
    attempt({ provider: "vercel", slot: 9, latencyMs: 22, segment: 2, response: { location: "sfo1" } }),
  ];
  const runs = [run({ warmupMs: 200 })];
  const window = { fromAt: 0, toAt: 2_000, label: "whole run" };
  const intervals = intervalsFromMarkers(MARKERS, 2_000);
  return {
    app: { name: "blip-monitor", version: "0.1.0", frontendRevision: "rev-a", buildTarget: "production", uiOrigin: "https://cf.test" },
    exportedAtWallMs: 1_800_000_100_000,
    timeOriginWallMs: 1_800_000_000_000,
    endpoints: ENDPOINTS_BY_TARGET.production,
    retention: { records: records.length, discarded: 7, earlierSamplesLost: true, fromAt: 0, toAt: 1_800, eventsDiscarded: 0 },
    runs,
    records,
    events: [{ type: "pause", runId: "run-1", at: 900, reason: "hidden" }],
    markers: MARKERS,
    experiment: { id: "exp-1", baseline: intervals[0] ?? null },
    displayed: buildReport({ records, runs, markers: MARKERS, window, excludeWarmup: true }),
  };
}

test("JSON export carries schema version, provenance, configuration, retention, and every record", () => {
  const source = snapshot();
  const document = parseExportJson(exportJson(buildExport(source)));
  assert.equal(document.schemaVersion, 1);
  assert.deepEqual(document.app, source.app);
  assert.equal(document.endpoints.vercel.configuredLocation, "sfo1");
  assert.equal(document.endpoints.cloudflare.origin, ENDPOINTS_BY_TARGET.production.cloudflare.origin);
  assert.equal(document.sampling.timeoutMs, 3_000);
  assert.equal(document.sampling.inflightCap, 4);
  assert.deepEqual(document.sampling.ratesHz, { normal: 5, low: 1, burst: 20 });
  assert.deepEqual(document.retention, source.retention);
  assert.deepEqual(document.records, source.records);
  assert.deepEqual(document.markers, MARKERS);
  assert.deepEqual(document.experiment, source.experiment);
  assert.deepEqual(document.displayed, source.displayed);
  assert.ok(document.segments.length >= 2);
  const pair0 = document.pairs.find((pair) => pair.pairSeq === 0);
  assert.equal(pair0?.skewMs, 1);
  assert.throws(() => parseExportJson(JSON.stringify({ ...document, schemaVersion: 2 })), /schemaVersion/);
});

test("CSV export is RFC 4180 with one typed row per record and neutralized label text", () => {
  const csv = exportCsv(buildExport(snapshot()));
  assert.ok(csv.endsWith("\r\n"));
  const rows = parseCsvRows(csv);
  const header = rows[0] ?? [];
  const width = header.length;
  assert.ok(rows.every((row) => row.length === width));
  const types = rows.slice(1).map((row) => row[0]);
  assert.deepEqual(new Set(types), new Set(["run", "attempt", "unsent_range", "marker", "segment"]));
  assert.equal(types.filter((t) => t === "attempt").length, 9);
  assert.equal(types.filter((t) => t === "unsent_range").length, 3);
  assert.ok(csv.includes(`"'=HYPERLINK(""http://x"",""click""), then ""quoted""\nnext line"`));
  assert.ok(csv.includes(`"'-5 dB after SQM, @home"`));
  const latency = header.indexOf("latency_ms");
  const outcome = header.indexOf("outcome");
  for (const row of rows.slice(1)) {
    if (row[0] === "attempt" && row[outcome] !== "ok") assert.equal(row[latency], "", `${row[outcome]} has a latency`);
  }
});

test("CSV export round-trips runs, outcome distinctions, unsent ranges, markers, baseline, and retention", () => {
  const source = snapshot();
  const parsed = parseExportCsv(exportCsv(buildExport(source)));
  assert.deepEqual(parsed.runs, source.runs);
  assert.deepEqual(parsed.records, source.records);
  assert.deepEqual(parsed.markers, MARKERS);
  assert.deepEqual(parsed.experiment, source.experiment);
  assert.deepEqual({ ...parsed.retention, eventsDiscarded: 0 }, source.retention);
  const recomputed = buildReport({
    records: parsed.records,
    runs: parsed.runs,
    markers: parsed.markers,
    window: source.displayed?.window ?? { fromAt: 0, toAt: 0, label: "" },
    excludeWarmup: true,
  });
  assert.deepEqual(recomputed, source.displayed);
});

test("CSV import rejects a failure that carries a latency", () => {
  const csv = exportCsv(buildExport(snapshot()));
  const rows = parseCsvRows(csv);
  const header = rows[0] ?? [];
  const timeoutRow = rows.find((row) => row[header.indexOf("outcome")] === "timeout");
  assert.ok(timeoutRow);
  timeoutRow[header.indexOf("latency_ms")] = "3000";
  const tampered = rows.map((row) => row.map((cell) => (/[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell)).join(",")).join("\r\n");
  assert.throws(() => parseExportCsv(tampered), /must not carry a latency/);
});
