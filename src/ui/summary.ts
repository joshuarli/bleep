import type { EndpointMap } from "../config/endpoints.ts";
import { PROVIDERS, type Provider } from "../config/targets.ts";
import type { Report, ReportRow } from "../measure/report.ts";
import type { EndpointSummary } from "../measure/stats.ts";
import type { MeasurementRecord, ResponseMeta } from "../measure/types.ts";
import { renderComparison } from "./compare.ts";
import { element } from "./controls.ts";
import { PROVIDER_STYLE } from "./graph.ts";

export type SummaryModel = {
  report: Report;
  nowAt: number;
  activeMsIn: (fromAt: number, toAt: number) => number;
  targetHz: number | null;
  endpoints: EndpointMap;
  latestMeta: Partial<Record<Provider, ResponseMeta>>;
  uiRevision: string;
  warmup: { remainingMs: number } | null;
};

const ms = (value: number | null) => (value === null ? "–" : `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`);
const pct = (value: number | null) => (value === null ? "–" : `${(value * 100).toFixed(1)}%`);
const ratio = (count: number, of: number) => `${count} of ${of}`;
const short = (revision: string | null) => (revision === null ? "unknown" : revision.slice(0, 12));
const seconds = (value: number) => `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;

export function activeMs(
  window: { fromAt: number; toAt: number },
  runs: readonly { startedAt: number; endedAt: number | null }[],
  excluded: readonly { fromAt: number; toAt: number }[],
  nowAt: number,
): number {
  const clip = (fromAt: number, toAt: number) => ({
    fromAt: Math.max(fromAt, window.fromAt),
    toAt: Math.min(toAt, window.toAt),
  });
  let total = 0;
  for (const run of runs) {
    const span = clip(run.startedAt, run.endedAt ?? nowAt);
    if (span.toAt <= span.fromAt) continue;
    const holes = excluded
      .map((hole) => ({ fromAt: Math.max(hole.fromAt, span.fromAt), toAt: Math.min(hole.toAt, span.toAt) }))
      .filter((hole) => hole.toAt > hole.fromAt)
      .sort((a, b) => a.fromAt - b.fromAt);
    let covered = 0;
    let reach = span.fromAt;
    for (const hole of holes) {
      const from = Math.max(hole.fromAt, reach);
      if (hole.toAt > from) covered += hole.toAt - from;
      reach = Math.max(reach, hole.toAt);
    }
    total += span.toAt - span.fromAt - covered;
  }
  return total;
}

export function latestResponseMeta(records: Iterable<MeasurementRecord>): Partial<Record<Provider, ResponseMeta>> {
  const latest: Partial<Record<Provider, { at: number; meta: ResponseMeta }>> = {};
  for (const record of records) {
    if (record.kind !== "attempt" || record.result.response === null) continue;
    const current = latest[record.provider];
    if (current === undefined || record.intendedAt > current.at) {
      latest[record.provider] = { at: record.intendedAt, meta: record.result.response };
    }
  }
  const out: Partial<Record<Provider, ResponseMeta>> = {};
  for (const provider of PROVIDERS) {
    const entry = latest[provider];
    if (entry !== undefined) out[provider] = entry.meta;
  }
  return out;
}

type Line = [label: string, metric: string, cell: (summary: EndpointSummary, provider: Provider) => string];

function endpointTable(row: ReportRow, spanEnd: number, model: SummaryModel): HTMLElement {
  const providers = PROVIDERS.filter((provider) => row.endpoints[provider] !== undefined);
  const activeSeconds = model.activeMsIn(row.fromAt, spanEnd) / 1_000;
  const lines: Line[] = [
    ["Latest successful", "latest", (s) => ms(s.latestMs)],
    ["Successful / attempted", "ok", (s) => ratio(s.ok, s.attempted)],
    ["Median", "median", (s) => ms(s.medianMs)],
    ["95th percentile", "p95", (s) => ms(s.p95Ms)],
    ["Maximum", "max", (s) => ms(s.maxMs)],
    ["Timeouts / attempted", "timeouts", (s) => ratio(s.failures.timeout, s.attempted)],
    [
      "Other failures / attempted",
      "errors",
      (s) =>
        `${ratio(s.failures.network_error + s.failures.http_error + s.failures.invalid_response, s.attempted)} (network ${s.failures.network_error}, HTTP ${s.failures.http_error}, invalid ${s.failures.invalid_response})`,
    ],
    ["Cancelled", "cancelled", (s) => String(s.cancelled)],
    ["Scheduled but not sent", "unsent", (s) => String(s.unsent)],
    ["Coverage (successful / scheduled)", "coverage", (s) => pct(s.coverage)],
    ["Requests sent", "sent", (s) => String(s.sent)],
    ["Target rate", "target", () => (model.targetHz === null ? "stopped" : `${model.targetHz}/s`)],
    ["Achieved rate", "achieved", (s) => (activeSeconds < 1 ? "–" : `${(s.sent / activeSeconds).toFixed(2)}/s`)],
    ["Since last valid response", "since", (s) => (s.lastOkAt === null ? "none in window" : seconds(model.nowAt - s.lastOkAt))],
    ["Endpoint", "endpoint", (_s, p) => model.endpoints[p].origin],
    ["Observed location", "location", (_s, p) => row.locations[p] ?? "unknown"],
    ["Configured location", "configured", (_s, p) => model.endpoints[p].configuredLocation],
    ["Runtime", "runtime", (_s, p) => model.latestMeta[p]?.runtime ?? "unknown"],
    ["Backend revision", "revision", (_s, p) => short(row.revisions[p])],
  ];

  const head = element("tr", {}, [
    element("th", { scope: "col", textContent: "" }),
    ...providers.map((provider) => element("th", { scope: "col", textContent: PROVIDER_STYLE[provider].name })),
  ]);
  if (providers.length > 1) head.append(element("th", { scope: "col", textContent: "All" }));
  const body = lines.map(([label, metric, cell]) => {
    const tr = element("tr", { dataset: { metric } }, [element("th", { scope: "row", textContent: label })]);
    for (const provider of providers) {
      const summary = row.endpoints[provider];
      tr.append(element("td", { dataset: { provider }, textContent: summary === undefined ? "–" : cell(summary, provider) }));
    }
    if (providers.length > 1) {
      const all = providers.map((p) => row.endpoints[p]).filter((s): s is EndpointSummary => s !== undefined);
      const sent = all.reduce((total, s) => total + s.sent, 0);
      const text =
        metric === "sent"
          ? String(sent)
          : metric === "achieved"
            ? activeSeconds < 1
              ? "–"
              : `${(sent / activeSeconds).toFixed(2)}/s`
            : metric === "target" && model.targetHz !== null
              ? `${model.targetHz * providers.length}/s`
              : "";
      tr.append(element("td", { dataset: { provider: "all" }, textContent: text }));
    }
    return tr;
  });
  return element("div", { className: "table-wrap" }, [
    element("table", { className: "summary" }, [element("thead", {}, [head]), element("tbody", {}, body)]),
  ]);
}

const REASON_TEXT: Record<string, string> = {
  run: "new run",
  resume: "resumed after a pause",
  location: "location changed",
  revision: "backend revision changed",
  phase: "experiment phase changed",
};

export function renderSummary(root: HTMLElement, model: SummaryModel): void {
  const { report } = model;
  const children: Node[] = [];
  const warmupNote = report.excludeWarmup ? " The 10 s compare warm-up is excluded." : "";
  children.push(
    element("p", {
      className: "window",
      textContent: `Window: ${report.window.label} (${seconds(report.window.toAt - report.window.fromAt)}).${warmupNote}`,
    }),
  );
  if (model.warmup !== null) {
    children.push(
      element("p", {
        className: "note",
        dataset: { warmup: "active" },
        textContent: `Compare warm-up in progress: ${seconds(model.warmup.remainingMs)} left. Warm-up samples are kept and drawn but excluded from these figures.`,
      }),
    );
  }
  if (report.rows.length === 0) children.push(element("p", { className: "note", textContent: "No measurements in this window." }));
  if (report.spansSegments) {
    children.push(
      element("p", {
        className: "warning",
        dataset: { spansSegments: "true" },
        textContent: `This window spans ${report.rows.length} segments, so figures are shown per segment and not pooled.`,
      }),
    );
  }
  for (const [index, row] of report.rows.entries()) {
    const spanEnd = report.rows[index + 1]?.fromAt ?? report.window.toAt;
    const section = element("section", { className: "segment", dataset: { segment: String(row.segmentIndex) } });
    if (report.spansSegments || row.phase !== null) {
      const reasons = row.startReasons.map((reason) => REASON_TEXT[reason] ?? reason).join(", ");
      section.append(
        element("h3", {
          textContent: `Segment ${row.segmentIndex + 1}${row.phase === null ? "" : `: ${row.phase}`} (${reasons}, ${seconds(row.toAt - row.fromAt)})`,
        }),
      );
    }
    const mismatched = PROVIDERS.filter((p) => row.revisions[p] !== null && row.revisions[p] !== model.uiRevision);
    if (mismatched.length > 0) {
      section.append(
        element("p", {
          className: "warning",
          dataset: { revisionMismatch: "true" },
          textContent: `Revision mismatch: this page is ${short(model.uiRevision)} but ${mismatched
            .map((p) => `${PROVIDER_STYLE[p].name} reports ${short(row.revisions[p])}`)
            .join(" and ")}. Results may not compare like with like.`,
        }),
      );
    }
    section.append(endpointTable(row, spanEnd, model));
    if (row.pairs !== null) section.append(renderComparison(row.pairs));
    children.push(section);
  }
  root.replaceChildren(...children);
  root.dataset.report = JSON.stringify(report);
}
