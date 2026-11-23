import { ENDPOINTS } from "../config/endpoints.ts";
import { PROVIDERS } from "../config/targets.ts";
import { APP_VERSION, BUILD_REVISION, BUILD_TARGET } from "../generated/build-info.ts";
import { browserProbeDeps } from "../measure/browser-deps.ts";
import { newProbeId, sendProbe } from "../measure/probe-client.ts";
import { buildSegments, type Segment } from "../measure/segments.ts";
import { Session, SESSION_EXTENSION_MS, SESSION_LIMIT_MS } from "../measure/session.ts";
import { runIndex } from "../measure/stats.ts";
import {
  cleanMarkerLabel,
  compareIntervals,
  intervalsFromMarkers,
  lockBaseline,
  phaseBoundaries,
  type Experiment,
  type Interval,
  type Marker,
} from "../measure/intervals.ts";
import { buildReport, type Report } from "../measure/report.ts";
import { buildControls, element } from "./controls.ts";
import { drawGraph, pauseBands, PROVIDER_STYLE, TIME_SCALES, type DrawStats, type TimeScale } from "./graph.ts";
import { buildExportPanel } from "./export.ts";
import { buildMarkerPanel } from "./markers.ts";
import { activeMs, latestResponseMeta, renderSummary } from "./summary.ts";

const ACHIEVED_WINDOW_MS = 10_000;
const SUMMARY_INTERVAL_MS = 500;

const probeDeps = browserProbeDeps();
const session = new Session(
  {
    clock: performance,
    timers: probeDeps.timers,
    probe: (target, id, cancel) => sendProbe(probeDeps, target, id, cancel),
    newProbeId: () => newProbeId((bytes) => crypto.getRandomValues(bytes)),
    newRunId: () => crypto.randomUUID(),
    wallClock: () => Date.now(),
  },
  {
    endpoints: { cloudflare: ENDPOINTS.cloudflare.origin, vercel: ENDPOINTS.vercel.origin },
    uiOrigin: location.origin,
    uiRevision: BUILD_REVISION,
  },
);

const app = document.querySelector<HTMLElement>("#app");
if (app === null) throw new Error("missing #app");

let scale: TimeScale = TIME_SCALES[1];
const controlsRoot = element("section", { className: "panel", ariaLabel: "Controls" });
const controls = buildControls(controlsRoot, {
  start: (mode) => session.start(mode),
  stop: () => session.stop(),
  clear: () => {
    session.clear();
    markers = [];
    selected = [];
    experiment = { id: crypto.randomUUID(), baseline: null };
    markersChanged();
  },
  extend: () => session.extend(),
  rate: (rate) => session.selectRate(rate),
  burst: () => session.startBurst(),
  scale: (chosen) => {
    scale = chosen;
    lastDrawAt = Number.NEGATIVE_INFINITY;
    lastSummaryAt = Number.NEGATIVE_INFINITY;
  },
});

const canvas = element("canvas", { id: "graph", tabIndex: 0 });
canvas.setAttribute("role", "button");
canvas.setAttribute("aria-label", "Latency graph. Activate to pause or resume measuring.");
const caption = element("figcaption", { id: "graph-caption" });
const legend = element(
  "ul",
  { className: "legend" },
  PROVIDERS.map((provider) => {
    const style = PROVIDER_STYLE[provider];
    return element("li", {}, [
      element("span", { className: `swatch ${style.shape}`, ariaHidden: "true" }),
      ` ${style.name} (${style.shape === "circle" ? "circles" : "squares"}), `,
      element("span", { className: "cross", ariaHidden: "true", textContent: "×" }),
      " failed request",
    ]);
  }),
);
legend.append(
  element("li", {}, ["Bars under the axis: scheduled requests that were not sent. Hatched: paused. Dashed line: location or revision change."]),
);
const figure = element("figure", { className: "graph" }, [canvas, caption, legend]);
const toggle = () => {
  const state = session.state;
  if (state.state === "running") session.pause();
  else if (state.state === "paused" && state.reason === "user") session.resume();
};
canvas.addEventListener("click", toggle);
canvas.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    toggle();
  }
});

const endpointList = element(
  "p",
  { className: "endpoints" },
  [
    `Destinations: `,
    ...PROVIDERS.flatMap((provider, i) => [
      i === 0 ? "" : "; ",
      element("code", { textContent: ENDPOINTS[provider].origin }),
      ` (${ENDPOINTS[provider].label}, configured ${ENDPOINTS[provider].configuredLocation})`,
    ]),
    `. This page: ${location.origin}, revision ${BUILD_REVISION.slice(0, 12)}${BUILD_TARGET === "production" ? "" : ` (${BUILD_TARGET} build, simulated or local endpoints)`}, v${APP_VERSION}.`,
  ],
);

const summaryRoot = element("div", { id: "summary" });
const summarySection = element("section", { className: "panel", ariaLabel: "Summary" }, [
  element("h2", { textContent: "Summary" }),
  summaryRoot,
]);

let markers: Marker[] = [];
let selected: string[] = [];
let experiment: Experiment = { id: crypto.randomUUID(), baseline: null };
let uiChanges = 0;
const changeKey = () => `${session.version}:${uiChanges}`;

const markerSection = element("section", { className: "panel", ariaLabel: "Markers and intervals" });
const markerPanel = buildMarkerPanel(markerSection, {
  mark: (label) => {
    markers = [...markers, { id: crypto.randomUUID(), at: performance.now(), label: cleanMarkerLabel(label) }];
    markersChanged();
  },
  relabel: (id, label) => {
    markers = markers.map((marker) => (marker.id === id ? { ...marker, label: cleanMarkerLabel(label) } : marker));
    markersChanged();
  },
  toggle: (id) => {
    selected = selected.includes(id) ? selected.filter((other) => other !== id) : [...selected, id].slice(-2);
    markersChanged();
  },
  setBaseline: (id) => {
    const interval = currentIntervals(performance.now()).find((candidate) => candidate.markerId === id);
    if (interval === undefined) return;
    experiment = lockBaseline(experiment, interval);
    markersChanged();
  },
  clearBaseline: () => {
    experiment = { id: crypto.randomUUID(), baseline: null };
    markersChanged();
  },
});

function currentIntervals(nowAt: number): Interval[] {
  return intervalsFromMarkers(markers, viewEnd(nowAt));
}

function selectedIntervals(nowAt: number): Interval[] {
  const intervals = currentIntervals(nowAt);
  return selected
    .map((id) => intervals.find((interval) => interval.markerId === id))
    .filter((interval): interval is Interval => interval !== undefined);
}

function markersChanged(): void {
  uiChanges++;
  const nowAt = performance.now();
  markerPanel.updateList({ markers, intervals: currentIntervals(nowAt), experiment, selected: new Set(selected), nowAt });
  lastSummaryAt = Number.NEGATIVE_INFINITY;
}

const exportSection = element("section", { className: "panel", ariaLabel: "Export" });
buildExportPanel(exportSection, () => {
  const nowAt = performance.now();
  refreshSummary(nowAt);
  const retention = session.retention();
  return {
    app: { name: "blip-monitor", version: APP_VERSION, frontendRevision: BUILD_REVISION, buildTarget: BUILD_TARGET, uiOrigin: location.origin },
    exportedAtWallMs: Date.now(),
    timeOriginWallMs: performance.timeOrigin,
    endpoints: ENDPOINTS,
    retention: {
      records: retention.size,
      discarded: retention.discarded,
      earlierSamplesLost: retention.discarded > 0,
      fromAt: retention.fromAt,
      toAt: retention.toAt,
      eventsDiscarded: session.events.discarded + session.longTasks.discarded,
    },
    runs: session.runs,
    records: session.records.toArray(),
    events: [...session.events, ...session.longTasks].sort((a, b) => a.at - b.at),
    markers,
    experiment,
    displayed: displayedReport,
  };
});

app.append(controlsRoot, figure, markerSection, summarySection, exportSection, endpointList);

const longTaskObserver =
  typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("longtask")
    ? new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) session.annotateLongTask(entry.startTime, entry.duration);
      })
    : null;
longTaskObserver?.observe({ type: "longtask", buffered: false });

session.setHidden(document.hidden);
document.addEventListener("visibilitychange", () => session.setHidden(document.hidden));

let segmentsVersion = "";
let segments: Segment[] = [];
function currentSegments(): Segment[] {
  if (segmentsVersion !== changeKey()) {
    segments = buildSegments(session.records, runIndex(session.runs), phaseBoundaries(markers)).segments;
    segmentsVersion = changeKey();
  }
  return segments;
}

function achievedHz(nowAt: number): number | null {
  if (session.state.state === "idle") return null;
  const run = session.state.run;
  const since = Math.max(nowAt - ACHIEVED_WINDOW_MS, run.startedAt);
  const span = nowAt - since;
  if (span < 1_000) return null;
  let sent = 0;
  for (const record of session.records) {
    if (record.kind === "attempt" && record.runId === run.runId && record.intendedAt >= since) sent++;
  }
  return (sent + session.inflightCount) / (span / 1_000);
}

const moving = () => session.state.state !== "idle";

function viewEnd(nowAt: number): number {
  const state = session.state;
  if (state.state !== "idle") return nowAt;
  const last = session.runs.at(-1);
  return last?.endedAt ?? nowAt;
}

let lastSummaryAt = Number.NEGATIVE_INFINITY;
let summaryVersion = "";
let displayedReport: Report | null = null;
let summaryRefreshes = 0;

function refreshSummary(nowAt: number): void {
  const endAt = viewEnd(nowAt);
  const window = { fromAt: endAt - scale.ms, toAt: endAt, label: `last ${scale.label}` };
  const report = buildReport({
    records: session.records.toArray(),
    runs: session.runs,
    markers,
    window,
    excludeWarmup: true,
  });
  const state = session.state;
  const run = state.state === "idle" ? null : state.run;
  const warmupLeft = run === null ? 0 : run.startedAt + run.warmupMs - nowAt;
  renderSummary(summaryRoot, {
    report,
    nowAt,
    activeMsIn: (fromAt, toAt) => {
      const excluded = [
        ...pauseBands(session.events, session.runs, nowAt),
        ...session.runs.map((run) => ({ fromAt: run.startedAt, toAt: run.startedAt + run.warmupMs })),
      ];
      return activeMs({ fromAt, toAt: Math.min(toAt, nowAt) }, session.runs, excluded, nowAt);
    },
    targetHz: session.targetHz(),
    endpoints: ENDPOINTS,
    latestMeta: latestResponseMeta(session.records),
    uiRevision: BUILD_REVISION,
    warmup: warmupLeft > 0 ? { remainingMs: warmupLeft } : null,
  });
  displayedReport = report;
  summaryRefreshes++;
  markerPanel.updateComparison(
    compareIntervals(session.records.toArray(), session.runs, markers, selectedIntervals(nowAt), experiment.baseline),
  );
  if (moving()) {
    markerPanel.updateList({ markers, intervals: currentIntervals(nowAt), experiment, selected: new Set(selected), nowAt });
  }
  lastSummaryAt = nowAt;
  summaryVersion = changeKey();
}

let lastDrawAt = Number.NEGATIVE_INFINITY;
let lastVersion = "";
let maxFrameMs = 0;
let stats: DrawStats | null = null;
let size = { width: 0, height: 0, ratio: 0 };

function frame(): void {
  const started = performance.now();
  const nowAt = started;
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const resized = rect.width !== size.width || rect.height !== size.height || ratio !== size.ratio;
  if (resized) {
    size = { width: rect.width, height: rect.height, ratio };
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
  }
  const msPerPixel = scale.ms / Math.max(1, rect.width);
  const moving = session.state.state !== "idle";
  const due = moving && nowAt - lastDrawAt >= Math.max(33, msPerPixel);
  if (resized || due || changeKey() !== lastVersion) {
    const ctx = canvas.getContext("2d");
    if (ctx !== null) {
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      stats = drawGraph(ctx, rect.width, rect.height, {
        records: session.records,
        events: session.events,
        runs: session.runs,
        segments: currentSegments(),
        markers,
        nowAt: viewEnd(nowAt),
        scaleMs: scale.ms,
        selections: [...selectedIntervals(nowAt), ...(experiment.baseline === null ? [] : [experiment.baseline])],
      });
    }
    lastDrawAt = nowAt;
    lastVersion = changeKey();
    publish(nowAt);
  }
  if (
    (moving && nowAt - lastSummaryAt >= SUMMARY_INTERVAL_MS) ||
    (!moving && summaryVersion !== changeKey()) ||
    lastSummaryAt === Number.NEGATIVE_INFINITY
  ) {
    refreshSummary(nowAt);
  }
  maxFrameMs = Math.max(maxFrameMs, performance.now() - started);
  requestAnimationFrame(frame);
}

function publish(nowAt: number): void {
  const state = session.state;
  const run = state.state === "idle" ? null : state.run;
  const achieved = achievedHz(nowAt);
  controls.update({
    state: state.state,
    pauseReason: state.state === "paused" ? state.reason : null,
    remainingMs: run === null ? null : run.endsAt - nowAt,
    canExtend: run !== null && run.endsAt + SESSION_EXTENSION_MS - run.startedAt <= SESSION_LIMIT_MS,
    burst: session.burst(),
    nowAt,
    targetHz: session.targetHz(),
    destinations: run?.providers.length ?? 0,
    achievedHz: achieved,
  });
  if (stats === null) return;
  const parts = [`Last ${scale.label}.`];
  for (const provider of PROVIDERS) {
    const name = PROVIDER_STYLE[provider].name;
    if (stats.okPoints[provider] + stats.failures[provider] + stats.unsentSlots[provider] === 0) continue;
    parts.push(
      `${name}: ${stats.okPoints[provider]} successful, ${stats.failures[provider]} failed, ${stats.unsentSlots[provider]} not sent.`,
    );
  }
  if (stats.pauseBands > 0) parts.push(`${stats.pauseBands} paused period${stats.pauseBands === 1 ? "" : "s"}.`);
  const kept = session.retention();
  if (kept.fromAt !== null) {
    const span = Math.round((viewEnd(nowAt) - kept.fromAt) / 1_000);
    parts.push(
      `Keeping ${kept.size} records covering the last ${span} s${kept.discarded > 0 ? `; ${kept.discarded} older records were discarded` : ""}.`,
    );
  }
  const text = parts.join(" ");
  if (caption.textContent !== text) caption.textContent = text;
  const retention = kept;
  figure.dataset.summary = JSON.stringify({
    state: state.state,
    pauseReason: state.state === "paused" ? state.reason : null,
    mode: run?.mode ?? null,
    scaleMs: scale.ms,
    targetHz: session.targetHz(),
    achievedHz: achieved,
    inflight: session.inflightCount,
    records: retention.size,
    discarded: retention.discarded,
    maxFrameMs,
    summaryRefreshes,
    ...stats,
  });
}

markersChanged();
requestAnimationFrame(frame);
