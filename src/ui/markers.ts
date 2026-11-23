import {
  MARKER_LABEL_MAX,
  PRESET_MARKER_LABELS,
  type Experiment,
  type Interval,
  type IntervalComparison,
  type Marker,
} from "../measure/intervals.ts";
import { element } from "./controls.ts";
import { PROVIDER_STYLE } from "./graph.ts";

export type MarkerHandlers = {
  mark(label: string): void;
  relabel(id: string, label: string): void;
  toggle(id: string): void;
  setBaseline(id: string): void;
  clearBaseline(): void;
};

export type MarkerListModel = {
  markers: readonly Marker[];
  intervals: readonly Interval[];
  experiment: Experiment;
  selected: ReadonlySet<string>;
  nowAt: number;
};

const ms = (value: number | null) => (value === null ? "–" : `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`);
const signed = (value: number | null) =>
  value === null ? "–" : `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value) < 10 ? Math.abs(value).toFixed(1) : Math.round(Math.abs(value))} ms`;
const seconds = (value: number) => `${(value / 1_000).toFixed(1)} s`;

const durationText = (interval: Interval, nowAt: number) =>
  ` ${seconds(interval.toAt - interval.fromAt)}${interval.toAt >= nowAt - 1 ? " so far" : ""} `;

export function buildMarkerPanel(
  root: HTMLElement,
  handlers: MarkerHandlers,
): { updateList(model: MarkerListModel): void; updateComparison(comparison: IntervalComparison): void } {
  const presets = element(
    "datalist",
    { id: "marker-presets" },
    PRESET_MARKER_LABELS.map((label) => element("option", { value: label })),
  );
  const input = element("input", {
    id: "marker-label",
    type: "text",
    value: PRESET_MARKER_LABELS[0],
    maxLength: MARKER_LABEL_MAX,
    autocomplete: "off",
  });
  input.setAttribute("list", "marker-presets");
  const mark = element("button", { type: "button", id: "mark", textContent: "Mark now" });
  const submit = () => {
    if (input.value.trim() === "") return;
    handlers.mark(input.value);
  };
  mark.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submit();
  });
  const experimentLine = element("p", { className: "note", id: "experiment" });
  const clear = element("button", { type: "button", id: "clear-baseline", textContent: "Clear baseline and start a new experiment" });
  clear.addEventListener("click", () => handlers.clearBaseline());
  const list = element("ol", { className: "markers", id: "marker-list" });
  const comparison = element("div", { id: "interval-compare" });
  type Row = {
    item: HTMLLIElement;
    label: HTMLInputElement;
    select: HTMLInputElement;
    baseline: HTMLButtonElement;
    duration: HTMLElement;
  };
  const rows = new Map<string, Row>();
  const createRow = (markerId: string): Row => {
    const label = element("input", { type: "text", maxLength: MARKER_LABEL_MAX, className: "label-edit", ariaLabel: "Marker label" });
    label.setAttribute("list", "marker-presets");
    label.addEventListener("change", () => {
      if (label.value.trim() !== "") handlers.relabel(markerId, label.value);
    });
    const select = element("input", { type: "checkbox", dataset: { selectInterval: markerId } });
    select.addEventListener("change", () => handlers.toggle(markerId));
    const baseline = element("button", { type: "button", dataset: { baseline: markerId } });
    baseline.addEventListener("click", () => handlers.setBaseline(markerId));
    const duration = element("span", { className: "note duration" });
    const item = element("li", { dataset: { markerId } }, [label, duration, element("label", {}, [select, " compare"]), " ", baseline]);
    const row = { item, label, select, baseline, duration };
    rows.set(markerId, row);
    return row;
  };

  root.append(
    element("h2", { textContent: "Markers and intervals" }),
    element("p", {
      className: "note",
      textContent:
        "Mark when you change conditions. Each marker starts an interval that runs to the next marker. Select two intervals to compare them; set one as the experiment's baseline to see changes against it.",
    }),
    element("div", { className: "buttons" }, [
      element("label", { htmlFor: "marker-label", textContent: "Label" }),
      input,
      presets,
      mark,
    ]),
    list,
    experimentLine,
    clear,
    comparison,
  );

  return {
    updateList(model) {
      const baselineId = model.experiment.baseline?.markerId ?? null;
      experimentLine.textContent =
        model.experiment.baseline === null
          ? `Experiment ${model.experiment.id.slice(0, 8)}: no baseline set.`
          : `Experiment ${model.experiment.id.slice(0, 8)}: baseline locked to “${model.experiment.baseline.label}” (${seconds(model.experiment.baseline.toAt - model.experiment.baseline.fromAt)}).`;
      experimentLine.dataset.experimentId = model.experiment.id;
      clear.disabled = model.experiment.baseline === null;

      const wanted = new Set(model.intervals.map((interval) => interval.markerId));
      for (const [id, row] of rows) {
        if (!wanted.has(id)) {
          row.item.remove();
          rows.delete(id);
        }
      }
      let previous: HTMLElement | null = null;
      for (const interval of model.intervals) {
        const row = rows.get(interval.markerId) ?? createRow(interval.markerId);
        const marker = model.markers.find((candidate) => candidate.id === interval.markerId);
        const label = marker?.label ?? interval.label;
        if (document.activeElement !== row.label && row.label.value !== label) row.label.value = label;
        row.select.checked = model.selected.has(interval.markerId);
        row.baseline.textContent = baselineId === interval.markerId ? "Baseline (locked)" : "Set as baseline";
        row.baseline.disabled = model.experiment.baseline !== null;
        row.duration.textContent = durationText(interval, model.nowAt);
        const expectedNext: Element | null = previous === null ? list.firstElementChild : previous.nextElementSibling;
        if (expectedNext !== row.item) {
          if (previous === null) list.prepend(row.item);
          else previous.after(row.item);
        }
        previous = row.item;
      }
    },

    updateComparison(result) {
      if (result.rows.length === 0) {
        comparison.replaceChildren(element("p", { className: "note", textContent: "Select intervals to compare them here." }));
        comparison.dataset.comparison = JSON.stringify(result);
        return;
      }
      const head = element("tr", {}, [
        ...[
          "Interval",
          "Duration",
          "Destination",
          "Successful / attempted",
          "Median",
          "Median vs baseline",
          "95th percentile",
          "p95 vs baseline",
          "Maximum",
          "Failed",
          "Not sent",
          "Coverage",
        ].map((text) => element("th", { scope: "col", textContent: text })),
      ]);
      const body = result.rows.flatMap((row) =>
        row.sides.map((side) =>
          element("tr", { dataset: { interval: row.interval.markerId, provider: side.provider, role: row.role } }, [
            element("td", {
              textContent: `${row.interval.label}${row.role === "baseline" ? " (baseline)" : ""}${row.spansSegments ? ` · segment ${side.segmentIndex + 1}` : ""}`,
            }),
            element("td", { textContent: seconds(row.durationMs) }),
            element("td", { textContent: PROVIDER_STYLE[side.provider].name }),
            element("td", { textContent: `${side.summary.ok} of ${side.summary.attempted}` }),
            element("td", { textContent: ms(side.summary.medianMs) }),
            element("td", { dataset: { metric: "median-delta" }, textContent: signed(side.medianDeltaMs) }),
            element("td", { textContent: ms(side.summary.p95Ms) }),
            element("td", { dataset: { metric: "p95-delta" }, textContent: signed(side.p95DeltaMs) }),
            element("td", { textContent: ms(side.summary.maxMs) }),
            element("td", { textContent: String(side.summary.failed) }),
            element("td", { textContent: String(side.summary.unsent) }),
            element("td", {
              textContent: side.summary.coverage === null ? "–" : `${(side.summary.coverage * 100).toFixed(1)}%`,
            }),
          ]),
        ),
      );
      const notes: HTMLElement[] = [];
      if (result.rows.some((row) => row.spansSegments)) {
        notes.push(
          element("p", {
            className: "warning",
            textContent: "An interval spans segments (a pause, location, or revision change), so it is shown per segment and not pooled.",
          }),
        );
      }
      if (result.rows.some((row) => row.role === "baseline") && !result.baselineUsable) {
        notes.push(
          element("p", {
            className: "warning",
            textContent: "The baseline spans segments, so no baseline deltas are shown.",
          }),
        );
      }
      comparison.replaceChildren(
        ...notes,
        element("div", { className: "table-wrap" }, [
          element("table", {}, [element("thead", {}, [head]), element("tbody", {}, body)]),
        ]),
        element("p", {
          className: "note",
          textContent:
            "Deltas are interval median minus baseline median and interval p95 minus baseline p95, per destination. Warm-up samples are excluded. Failures and unsent slots are counted, never given a latency.",
        }),
      );
      comparison.dataset.comparison = JSON.stringify(result);
    },
  };
}
