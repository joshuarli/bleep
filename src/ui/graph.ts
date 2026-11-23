import { PROVIDERS, type Provider } from "../config/targets.ts";
import type { Marker } from "../measure/intervals.ts";
import type { Segment } from "../measure/segments.ts";
import type { MeasurementRecord, Milliseconds, RunInfo, SessionEvent } from "../measure/types.ts";

export const TIME_SCALES = [
  { id: "10s", label: "10 s detail", ms: 10_000 },
  { id: "90s", label: "90 s", ms: 90_000 },
  { id: "15m", label: "15 min", ms: 15 * 60_000 },
] as const;
export type TimeScale = (typeof TIME_SCALES)[number];

export const PROVIDER_STYLE: Record<Provider, { color: string; shape: "circle" | "square"; name: string }> = {
  cloudflare: { color: "#c2410c", shape: "circle", name: "Cloudflare" },
  vercel: { color: "#1d4ed8", shape: "square", name: "Vercel" },
};

const MIN_MS = 1;
const MAX_MS = 3_000;
const MARGIN = { left: 46, right: 10, top: 30, bottom: 34 };
const GAP_FACTOR = 3;

export type GraphView = {
  records: Iterable<MeasurementRecord>;
  events: Iterable<SessionEvent>;
  runs: readonly RunInfo[];
  segments: readonly Segment[];
  markers: readonly Marker[];
  nowAt: Milliseconds;
  scaleMs: Milliseconds;
  selection: { fromAt: Milliseconds; toAt: Milliseconds } | null;
};

export type DrawStats = {
  windowFromAt: Milliseconds;
  windowToAt: Milliseconds;
  okPoints: Record<Provider, number>;
  failures: Record<Provider, number>;
  unsentSlots: Record<Provider, number>;
  pauseBands: number;
  gaps: Record<Provider, number>;
  locationChanges: number;
  markers: number;
};

type Point = { at: number; ms: number | null; segment: string; hz: number };

const zero = (): Record<Provider, number> => ({ cloudflare: 0, vercel: 0 });

export function drawGraph(ctx: CanvasRenderingContext2D, width: number, height: number, view: GraphView): DrawStats {
  const plot = {
    left: MARGIN.left,
    top: MARGIN.top,
    width: Math.max(10, width - MARGIN.left - MARGIN.right),
    height: Math.max(10, height - MARGIN.top - MARGIN.bottom),
  };
  const toAt = view.nowAt;
  const fromAt = toAt - view.scaleMs;
  const x = (at: number) => plot.left + ((at - fromAt) / view.scaleMs) * plot.width;
  const logSpan = Math.log(MAX_MS / MIN_MS);
  const y = (ms: number) => {
    const clamped = Math.min(MAX_MS, Math.max(MIN_MS, ms));
    return plot.top + plot.height * (1 - Math.log(clamped / MIN_MS) / logSpan);
  };
  const failureY: Record<Provider, number> = { cloudflare: 9, vercel: 21 };
  const unsentY: Record<Provider, number> = { cloudflare: plot.top + plot.height + 4, vercel: plot.top + plot.height + 10 };
  const stats: DrawStats = {
    windowFromAt: fromAt,
    windowToAt: toAt,
    okPoints: zero(),
    failures: zero(),
    unsentSlots: zero(),
    pauseBands: 0,
    gaps: zero(),
    locationChanges: 0,
    markers: 0,
  };

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.font = "11px system-ui, sans-serif";
  ctx.textBaseline = "middle";

  ctx.strokeStyle = "#e5e7eb";
  ctx.fillStyle = "#4b5563";
  ctx.lineWidth = 1;
  ctx.textAlign = "right";
  for (const ms of [1, 3, 10, 30, 100, 300, 1_000, 3_000]) {
    const gy = Math.round(y(ms)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(plot.left, gy);
    ctx.lineTo(plot.left + plot.width, gy);
    ctx.stroke();
    ctx.fillText(ms >= 1_000 ? `${ms / 1_000}s` : `${ms}`, plot.left - 4, gy);
  }
  ctx.textAlign = "left";
  ctx.fillText("failed", 2, failureY.cloudflare + 6);
  ctx.save();
  ctx.translate(10, plot.top + plot.height / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillText("ms (log)", 0, 0);
  ctx.restore();

  const tickStep = view.scaleMs <= 10_000 ? 1_000 : view.scaleMs <= 90_000 ? 10_000 : 60_000;
  ctx.textAlign = "center";
  ctx.fillStyle = "#6b7280";
  for (let t = toAt; t >= fromAt; t -= tickStep) {
    const gx = Math.round(x(t)) + 0.5;
    ctx.strokeStyle = "#f3f4f6";
    ctx.beginPath();
    ctx.moveTo(gx, plot.top);
    ctx.lineTo(gx, plot.top + plot.height);
    ctx.stroke();
    const ago = Math.round((toAt - t) / 1_000);
    ctx.textAlign = ago === 0 ? "right" : "center";
    ctx.fillText(ago === 0 ? "now" : ago % 60 === 0 && ago >= 60 ? `-${ago / 60}m` : `-${ago}s`, gx, height - 8);
  }

  if (view.selection !== null) {
    const sx = x(Math.max(fromAt, view.selection.fromAt));
    const ex = x(Math.min(toAt, view.selection.toAt));
    if (ex > sx) {
      ctx.fillStyle = "rgba(250, 204, 21, 0.18)";
      ctx.fillRect(sx, plot.top, ex - sx, plot.height);
    }
  }

  for (const run of view.runs) {
    if (run.warmupMs === 0) continue;
    const end = Math.min(run.startedAt + run.warmupMs, run.endedAt ?? Number.POSITIVE_INFINITY);
    if (end < fromAt || run.startedAt > toAt) continue;
    ctx.fillStyle = "rgba(107, 114, 128, 0.07)";
    const sx = x(Math.max(fromAt, run.startedAt));
    ctx.fillRect(sx, plot.top, x(Math.min(toAt, end)) - sx, plot.height);
    ctx.fillStyle = "#6b7280";
    ctx.textAlign = "left";
    ctx.fillText("warm-up", sx + 3, plot.top + 8);
  }

  const pauses = pauseBands(view.events, view.runs, toAt);
  for (const band of pauses) {
    if (band.toAt < fromAt || band.fromAt > toAt) continue;
    stats.pauseBands++;
    const sx = x(Math.max(fromAt, band.fromAt));
    const ex = x(Math.min(toAt, band.toAt));
    ctx.fillStyle = "rgba(156, 163, 175, 0.25)";
    ctx.fillRect(sx, plot.top, Math.max(1, ex - sx), plot.height);
    ctx.strokeStyle = "rgba(107, 114, 128, 0.5)";
    ctx.beginPath();
    for (let hx = sx - plot.height; hx < ex; hx += 8) {
      ctx.moveTo(Math.max(sx, hx), plot.top + plot.height - Math.max(0, sx - hx));
      ctx.lineTo(Math.min(ex, hx + plot.height), plot.top + Math.max(0, hx + plot.height - ex));
    }
    ctx.stroke();
    if (ex - sx > 40) {
      ctx.fillStyle = "#374151";
      ctx.textAlign = "center";
      ctx.fillText(band.reason === "hidden" ? "paused (tab hidden)" : "paused", (sx + ex) / 2, plot.top + plot.height / 2);
    }
  }

  const points: Record<Provider, Point[]> = { cloudflare: [], vercel: [] };
  for (const record of view.records) {
    if (record.kind === "unsent") {
      if (record.toIntendedAt < fromAt || record.fromIntendedAt > toAt) continue;
      const sx = x(Math.max(fromAt, record.fromIntendedAt));
      const ex = x(Math.min(toAt, record.toIntendedAt + 1_000 / record.targetHz));
      ctx.fillStyle = record.reason === "scheduler_gap" ? "#9ca3af" : PROVIDER_STYLE[record.provider].color;
      ctx.fillRect(sx, unsentY[record.provider], Math.max(2, ex - sx), 4);
      stats.unsentSlots[record.provider] += record.count;
      points[record.provider].push({ at: record.fromIntendedAt, ms: null, segment: "", hz: record.targetHz });
      continue;
    }
    if (record.intendedAt < fromAt || record.intendedAt > toAt) continue;
    const result = record.result;
    if (result.outcome === "ok") {
      points[record.provider].push({
        at: record.intendedAt,
        ms: result.latencyMs,
        segment: `${record.runId}:${record.segment}`,
        hz: record.targetHz,
      });
    } else {
      points[record.provider].push({ at: record.intendedAt, ms: null, segment: "", hz: record.targetHz });
      if (result.outcome !== "cancelled") {
        stats.failures[record.provider]++;
        drawCross(ctx, x(record.intendedAt), failureY[record.provider], PROVIDER_STYLE[record.provider].color);
      }
    }
  }

  for (const provider of PROVIDERS) {
    const style = PROVIDER_STYLE[provider];
    const series = points[provider].sort((a, b) => a.at - b.at);
    ctx.strokeStyle = style.color;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1;
    ctx.beginPath();
    let previous: Point | null = null;
    for (const point of series) {
      const joined =
        previous !== null &&
        previous.ms !== null &&
        point.ms !== null &&
        previous.segment === point.segment &&
        point.at - previous.at <= (GAP_FACTOR * 1_000) / Math.min(point.hz, previous.hz);
      if (point.ms !== null) {
        if (joined) ctx.lineTo(x(point.at), y(point.ms));
        else {
          if (previous !== null) stats.gaps[provider]++;
          ctx.moveTo(x(point.at), y(point.ms));
        }
      }
      previous = point;
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = style.color;
    for (const point of series) {
      if (point.ms === null) continue;
      stats.okPoints[provider]++;
      const px = x(point.at);
      const py = y(point.ms);
      if (style.shape === "circle") {
        ctx.beginPath();
        ctx.arc(px, py, 2.2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(px - 2, py - 2, 4, 4);
      }
    }
  }

  ctx.setLineDash([4, 3]);
  ctx.textAlign = "left";
  for (const segment of view.segments) {
    const changed = segment.startReasons.filter((reason) => reason === "location" || reason === "revision");
    if (changed.length === 0 || segment.fromAt < fromAt || segment.fromAt > toAt) continue;
    stats.locationChanges++;
    const gx = Math.round(x(segment.fromAt)) + 0.5;
    ctx.strokeStyle = "#111827";
    ctx.beginPath();
    ctx.moveTo(gx, plot.top);
    ctx.lineTo(gx, plot.top + plot.height);
    ctx.stroke();
    ctx.fillStyle = "#111827";
    const where = PROVIDERS.map((p) => segment.locations[p]).filter((l) => l !== null).join("/");
    ctx.fillText(`${changed.join("+")} change ${where}`, gx + 3, plot.top + plot.height - 8);
  }
  for (const marker of view.markers) {
    if (marker.at < fromAt || marker.at > toAt) continue;
    stats.markers++;
    const gx = Math.round(x(marker.at)) + 0.5;
    ctx.strokeStyle = "#7c3aed";
    ctx.beginPath();
    ctx.moveTo(gx, plot.top);
    ctx.lineTo(gx, plot.top + plot.height);
    ctx.stroke();
    ctx.fillStyle = "#5b21b6";
    ctx.fillText(marker.label, gx + 3, plot.top + 20, Math.max(40, plot.left + plot.width - gx - 6));
  }
  ctx.setLineDash([]);
  return stats;
}

function drawCross(ctx: CanvasRenderingContext2D, cx: number, cy: number, color: string): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - 3, cy - 3);
  ctx.lineTo(cx + 3, cy + 3);
  ctx.moveTo(cx + 3, cy - 3);
  ctx.lineTo(cx - 3, cy + 3);
  ctx.stroke();
  ctx.lineWidth = 1;
}

export type PauseBand = { fromAt: Milliseconds; toAt: Milliseconds; reason: "hidden" | "user" };

export function pauseBands(events: Iterable<SessionEvent>, runs: readonly RunInfo[], nowAt: Milliseconds): PauseBand[] {
  const bands: PauseBand[] = [];
  const open = new Map<string, { at: number; reason: "hidden" | "user" }>();
  for (const event of events) {
    if (event.type === "pause") open.set(event.runId, { at: event.at, reason: event.reason });
    else if ((event.type === "resume" || event.type === "end") && open.has(event.runId)) {
      const start = open.get(event.runId);
      open.delete(event.runId);
      if (start !== undefined) bands.push({ fromAt: start.at, toAt: event.at, reason: start.reason });
    }
  }
  for (const [runId, start] of open) {
    const run = runs.find((candidate) => candidate.runId === runId);
    bands.push({ fromAt: start.at, toAt: run?.endedAt ?? nowAt, reason: start.reason });
  }
  return bands;
}
