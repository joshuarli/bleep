import type { BurstState } from "../measure/scheduler.ts";
import type { Mode, SelectedRate } from "../measure/types.ts";
import { TIME_SCALES, type TimeScale } from "./graph.ts";

export type ControlHandlers = {
  start(mode: Mode): void;
  stop(): void;
  clear(): void;
  extend(): void;
  rate(rate: SelectedRate): void;
  burst(): void;
  scale(scale: TimeScale): void;
};

export type ControlModel = {
  state: "idle" | "running" | "paused";
  pauseReason: "hidden" | "user" | null;
  remainingMs: number | null;
  canExtend: boolean;
  burst: BurstState;
  nowAt: number;
  targetHz: number | null;
  destinations: number;
  achievedHz: number | null;
};

const MODE_LABELS: Record<Mode, string> = {
  cloudflare: "Cloudflare only",
  vercel: "Vercel only",
  compare: "Compare both",
};

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { dataset, ...rest } = props;
  Object.assign(node, rest);
  if (dataset !== undefined) Object.assign(node.dataset, dataset);
  for (const child of children) node.append(child);
  return node;
}

function radioGroup<T extends string>(
  legend: string,
  name: string,
  options: readonly { value: T; label: string }[],
  initial: T,
  onChange: (value: T) => void,
): { fieldset: HTMLFieldSetElement; inputs: HTMLInputElement[]; value(): T } {
  const inputs: HTMLInputElement[] = [];
  const fieldset = element("fieldset", { className: "group" }, [element("legend", { textContent: legend })]);
  for (const option of options) {
    const input = element("input", { type: "radio", name, value: option.value, checked: option.value === initial });
    input.addEventListener("change", () => {
      if (input.checked) onChange(option.value);
    });
    inputs.push(input);
    fieldset.append(element("label", {}, [input, ` ${option.label}`]));
  }
  return {
    fieldset,
    inputs,
    value: () => (inputs.find((input) => input.checked)?.value ?? initial) as T,
  };
}

const minutes = (ms: number) => {
  const total = Math.max(0, Math.ceil(ms / 1_000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

export function buildControls(root: HTMLElement, handlers: ControlHandlers): { update(model: ControlModel): void } {
  const mode = radioGroup(
    "Destination",
    "mode",
    (Object.keys(MODE_LABELS) as Mode[]).map((value) => ({ value, label: MODE_LABELS[value] })),
    "compare",
    () => undefined,
  );
  const rate = radioGroup(
    "Rate per destination",
    "rate",
    [
      { value: "normal", label: "Normal 5/s" },
      { value: "low", label: "Low 1/s" },
    ] as const,
    "normal",
    (value) => handlers.rate(value),
  );
  const scale = radioGroup(
    "Time scale",
    "scale",
    TIME_SCALES.map((option) => ({ value: option.id, label: option.label })),
    "90s",
    (value) => {
      const chosen = TIME_SCALES.find((option) => option.id === value);
      if (chosen !== undefined) handlers.scale(chosen);
    },
  );

  const start = element("button", { type: "button", id: "start", textContent: "Start" });
  const stop = element("button", { type: "button", id: "stop", textContent: "Stop" });
  const clear = element("button", { type: "button", id: "clear", textContent: "Clear" });
  const extend = element("button", { type: "button", id: "extend", textContent: "Extend +10 min" });
  const burst = element("button", { type: "button", id: "burst", textContent: "Burst 20/s for 30 s" });
  start.addEventListener("click", () => handlers.start(mode.value()));
  stop.addEventListener("click", () => handlers.stop());
  clear.addEventListener("click", () => handlers.clear());
  extend.addEventListener("click", () => handlers.extend());
  burst.addEventListener("click", () => handlers.burst());

  const status = element("p", { id: "status", className: "status" });
  status.setAttribute("aria-live", "polite");
  const run = element("fieldset", { className: "group" }, [
    element("legend", { textContent: "Run" }),
    element("div", { className: "buttons" }, [start, stop, clear, extend]),
  ]);
  rate.fieldset.append(burst);
  root.append(element("div", { className: "controls" }, [mode.fieldset, run, rate.fieldset, scale.fieldset]), status);

  let lastStatus = "";
  return {
    update(model) {
      const active = model.state !== "idle";
      start.disabled = active;
      stop.disabled = !active;
      extend.disabled = !model.canExtend;
      for (const input of mode.inputs) input.disabled = active;
      const burstState = model.burst;
      burst.disabled = !active || burstState.state !== "available";
      burst.textContent =
        burstState.state === "active"
          ? `Burst: ${minutes(burstState.endsAt - model.nowAt)} left`
          : burstState.state === "cooldown"
            ? `Burst cooldown ${minutes(burstState.availableAt - model.nowAt)}`
            : "Burst 20/s for 30 s";

      const parts: string[] = [];
      if (model.state === "idle") parts.push("Stopped.");
      else if (model.state === "paused") {
        parts.push(model.pauseReason === "hidden" ? "Paused while this tab is hidden." : "Paused. Click the graph to resume.");
      } else parts.push("Measuring.");
      if (model.remainingMs !== null) parts.push(`Ends in ${minutes(model.remainingMs)}.`);
      if (model.targetHz !== null) {
        parts.push(`Target ${model.targetHz}/s per destination, ${model.targetHz * model.destinations}/s total.`);
      }
      if (model.achievedHz !== null) parts.push(`Sent ${model.achievedHz.toFixed(1)}/s total over the last 10 s.`);
      const text = parts.join(" ");
      if (text !== lastStatus) status.textContent = lastStatus = text;
    },
  };
}
