import { isDeepStrictEqual } from "node:util";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { PROVIDERS } from "../src/config/targets.ts";
import { parseExportCsv } from "../src/export/csv.ts";
import { parseExportJson } from "../src/export/document.ts";
import type { Marker } from "../src/measure/intervals.ts";
import { buildReport, type Report, type ReportWindow } from "../src/measure/report.ts";
import type { MeasurementRecord, RunInfo } from "../src/measure/types.ts";

type Loaded = {
  file: string;
  runs: RunInfo[];
  records: MeasurementRecord[];
  markers: Marker[];
  displayed: Report | null;
  uiOrigin: string;
};

function load(file: string): Loaded {
  const text = readFileSync(file, "utf8");
  if (extname(file) === ".json") {
    const document = parseExportJson(text);
    return { file, ...document, uiOrigin: document.app.uiOrigin, displayed: document.displayed };
  }
  if (extname(file) === ".csv") {
    const parsed = parseExportCsv(text);
    return { file, ...parsed, displayed: null, uiOrigin: parsed.runs[0]?.uiOrigin ?? "unknown" };
  }
  throw new Error(`${file}: expected a .json or .csv export`);
}

const recompute = (loaded: Loaded, window: ReportWindow, excludeWarmup: boolean) =>
  buildReport({ records: loaded.records, runs: loaded.runs, markers: loaded.markers, window, excludeWarmup });

function wholeRun(run: RunInfo): ReportWindow {
  return { fromAt: run.startedAt, toAt: (run.endedAt ?? run.endsAt) + 1, label: `run ${run.runId.slice(0, 8)}` };
}

const fmt = (value: number | null) => (value === null ? "–" : value.toFixed(1));

function printReport(report: Report): void {
  console.log(`  window: ${report.window.label}${report.excludeWarmup ? " (warm-up excluded)" : ""}`);
  for (const row of report.rows) {
    const phase = row.phase === null ? "" : ` phase "${row.phase}"`;
    console.log(`  segment ${row.segmentIndex + 1}${phase} [${row.startReasons.join(", ")}]`);
    for (const provider of PROVIDERS) {
      const s = row.endpoints[provider];
      if (s === undefined) continue;
      console.log(
        `    ${provider.padEnd(10)} ok ${s.ok}/${s.attempted} median ${fmt(s.medianMs)} p95 ${fmt(s.p95Ms)} max ${fmt(s.maxMs)} ms; timeouts ${s.failures.timeout}, other failures ${s.failed - s.failures.timeout}, cancelled ${s.cancelled}, unsent ${s.unsent}, coverage ${s.coverage === null ? "–" : (s.coverage * 100).toFixed(1)}%; location ${row.locations[provider] ?? "unknown"}`,
      );
    }
    if (row.pairs !== null) {
      console.log(
        `    pairs: median difference (Vercel − Cloudflare) ${fmt(row.pairs.medianDifferenceMs)} ms over ${row.pairs.differenceCount} pairs; categories ${JSON.stringify(row.pairs.counts)}; skew flagged ${row.pairs.skewFlagged}`,
      );
    }
  }
}

function summarize(files: string[]): void {
  for (const file of files) {
    const loaded = load(file);
    console.log(`${basename(file)} (UI ${loaded.uiOrigin}, ${loaded.records.length} records)`);
    for (const run of loaded.runs) printReport(recompute(loaded, wholeRun(run), true));
  }
}

function exportFiles(paths: string[]): string[] {
  return paths.flatMap((path) =>
    statSync(path).isDirectory()
      ? readdirSync(path)
          .filter((name) => name.endsWith(".json") || name.endsWith(".csv"))
          .sort()
          .map((name) => join(path, name))
      : [path],
  );
}

function check(paths: string[]): void {
  const files = exportFiles(paths);
  const jsonFiles = files.filter((file) => file.endsWith(".json"));
  if (jsonFiles.length === 0) throw new Error("no JSON exports to check");
  let failures = 0;
  for (const file of jsonFiles) {
    const loaded = load(file);
    if (loaded.displayed === null) {
      console.error(`${file}: no displayed summary recorded`);
      failures++;
      continue;
    }
    const sources = [loaded];
    const csv = file.replace(/\.json$/, ".csv");
    if (existsSync(csv)) sources.push(load(csv));
    for (const source of sources) {
      const again = recompute(source, loaded.displayed.window, loaded.displayed.excludeWarmup);
      if (isDeepStrictEqual(again, loaded.displayed)) {
        console.log(`${basename(source.file)}: reproduces the displayed summary (${loaded.displayed.rows.length} rows)`);
      } else {
        console.error(`${basename(source.file)}: recomputed summary differs from the displayed summary`);
        failures++;
      }
    }
  }
  if (failures > 0) {
    console.error(`${failures} export${failures === 1 ? "" : "s"} did not reproduce`);
    process.exit(1);
  }
}

const args = process.argv.slice(2);
if (args.length === 0 || (args[0] === "--check" && args.length === 1)) {
  console.error("usage: node scripts/summarize-export.ts [--check] <export.json|export.csv|directory>...");
  process.exit(2);
}
if (args[0] === "--check") check(args.slice(1));
else summarize(exportFiles(args));
