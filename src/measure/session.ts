import type { Provider } from "../config/targets.ts";
import { PROBE_TIMEOUT_MS } from "./probe-client.ts";
import { Ring, RING_CAPACITY } from "./ring.ts";
import { SlotSchedule, type BurstState, type DueSlot, type MissedSlots } from "./scheduler.ts";
import {
  recordEnd,
  recordStart,
  type AttemptRecord,
  type Clock,
  type MeasurementRecord,
  type Milliseconds,
  type Mode,
  type ProbeResult,
  type ProbeTarget,
  type RunId,
  type RunInfo,
  type SelectedRate,
  type SessionEvent,
  type Timers,
  type TimerHandle,
  type UnsentRangeRecord,
} from "./types.ts";

export const INFLIGHT_CAP = 4;
export const SESSION_MS = 10 * 60_000;
export const SESSION_EXTENSION_MS = 10 * 60_000;
export const SESSION_LIMIT_MS = 60 * 60_000;
export const WARMUP_MS = 10_000;
export const IDLE_MS = 5_000;
export const EVENT_CAPACITY = 5_000;

export type SessionProbe = (target: ProbeTarget, id: string, cancel: AbortSignal) => Promise<ProbeResult>;

export type SessionDeps = {
  clock: Clock;
  timers: Timers;
  probe: SessionProbe;
  newProbeId: () => string;
  newRunId: () => RunId;
  wallClock: () => number;
};

export type SessionConfig = {
  endpoints: Record<Provider, string>;
  uiOrigin: string;
  uiRevision: string;
  capacity?: number;
};

export type SessionState =
  | { state: "idle" }
  | { state: "running"; run: RunInfo }
  | { state: "paused"; run: RunInfo; reason: "hidden" | "user" };

type InFlight = {
  controller: AbortController;
  dispatchedAt: Milliseconds;
  record: Omit<AttemptRecord, "result">;
};

const MODE_PROVIDERS: Record<Mode, readonly Provider[]> = {
  cloudflare: ["cloudflare"],
  vercel: ["vercel"],
  compare: ["cloudflare", "vercel"],
};

export class Session {
  readonly records: Ring<MeasurementRecord>;
  readonly events: Ring<SessionEvent>;
  readonly runs: RunInfo[] = [];
  private current: SessionState = { state: "idle" };
  private schedule: SlotSchedule | null = null;
  private selectedRate: SelectedRate = "normal";
  private segment = 0;
  private tickTimer: TimerHandle | null = null;
  private endTimer: TimerHandle | null = null;
  private hidden = false;
  private nextRequest = 0;
  private readonly inflight = new Map<number, InFlight>();
  private readonly lastDispatch = new Map<Provider, Milliseconds>();
  private readonly dispatchedInRun = new Set<Provider>();
  private readonly openUnsent = new Map<Provider, UnsentRangeRecord>();
  private revision = 0;

  private readonly deps: SessionDeps;
  private readonly config: SessionConfig;

  constructor(deps: SessionDeps, config: SessionConfig) {
    this.deps = deps;
    this.config = config;
    this.records = new Ring(config.capacity ?? RING_CAPACITY);
    this.events = new Ring(EVENT_CAPACITY);
  }

  get state(): SessionState {
    return this.current;
  }

  get version(): number {
    return this.revision;
  }

  get rate(): SelectedRate {
    return this.selectedRate;
  }

  get inflightCount(): number {
    return this.inflight.size;
  }

  get timerCount(): number {
    return (this.tickTimer === null ? 0 : 1) + (this.endTimer === null ? 0 : 1);
  }

  inflightFor(provider: Provider): number {
    let count = 0;
    for (const entry of this.inflight.values()) if (entry.record.provider === provider) count++;
    return count;
  }

  targetHz(): number | null {
    if (this.current.state !== "running" || this.schedule === null) return null;
    return this.schedule.hzAt(this.deps.clock.now());
  }

  burst(): BurstState {
    return this.schedule?.burst(this.deps.clock.now()) ?? { state: "available" };
  }

  start(mode: Mode): RunInfo {
    this.stop();
    const now = this.deps.clock.now();
    const run: RunInfo = {
      runId: this.deps.newRunId(),
      mode,
      providers: MODE_PROVIDERS[mode],
      endpoints: { ...this.config.endpoints },
      uiOrigin: this.config.uiOrigin,
      uiRevision: this.config.uiRevision,
      startedAt: now,
      startedAtWallMs: this.deps.wallClock(),
      endsAt: now + SESSION_MS,
      endedAt: null,
      endReason: null,
      timeoutMs: PROBE_TIMEOUT_MS,
      inflightCap: INFLIGHT_CAP,
      warmupMs: mode === "compare" ? WARMUP_MS : 0,
    };
    this.runs.push(run);
    this.segment++;
    this.dispatchedInRun.clear();
    this.openUnsent.clear();
    this.schedule = new SlotSchedule(now, this.selectedRate);
    this.pushEvent({ type: "rate", runId: run.runId, at: now, targetHz: this.schedule.hzAt(now), burst: false });
    if (this.hidden) {
      this.current = { state: "paused", run, reason: "hidden" };
      this.pushEvent({ type: "pause", runId: run.runId, at: now, reason: "hidden" });
    } else {
      this.current = { state: "running", run };
      this.armEndTimer(run);
      this.tick();
    }
    this.changed();
    return run;
  }

  stop(): void {
    if (this.current.state === "idle") return;
    this.finish("stopped");
  }

  clear(): void {
    this.stop();
    this.records.clear();
    this.events.clear();
    this.runs.length = 0;
    this.lastDispatch.clear();
    this.changed();
  }

  extend(): boolean {
    if (this.current.state === "idle") return false;
    const run = this.current.run;
    const endsAt = run.endsAt + SESSION_EXTENSION_MS;
    if (endsAt - run.startedAt > SESSION_LIMIT_MS) return false;
    run.endsAt = endsAt;
    if (this.current.state === "running") this.armEndTimer(run);
    this.changed();
    return true;
  }

  selectRate(rate: SelectedRate): void {
    this.selectedRate = rate;
    if (this.schedule === null || this.current.state === "idle") return;
    const now = this.deps.clock.now();
    this.schedule.select(rate, now);
    this.rateChanged(now);
  }

  startBurst(): boolean {
    if (this.current.state === "idle" || this.schedule === null) return false;
    const now = this.deps.clock.now();
    if (!this.schedule.startBurst(now)) return false;
    this.rateChanged(now);
    return true;
  }

  pause(): void {
    if (this.current.state !== "running") return;
    this.suspend("user");
  }

  resume(): void {
    if (this.current.state !== "paused" || this.current.reason !== "user" || this.hidden) return;
    this.resumeRun(this.current.run);
  }

  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    if (hidden && this.current.state === "running") this.suspend("hidden");
    if (!hidden && this.current.state === "paused" && this.current.reason === "hidden") {
      this.resumeRun(this.current.run);
    }
  }

  retention(): { size: number; discarded: number; fromAt: Milliseconds | null; toAt: Milliseconds | null } {
    let fromAt: Milliseconds | null = null;
    let toAt: Milliseconds | null = null;
    for (const record of this.records) {
      const start = recordStart(record);
      const end = recordEnd(record);
      if (fromAt === null || start < fromAt) fromAt = start;
      if (toAt === null || end > toAt) toAt = end;
    }
    return { size: this.records.size, discarded: this.records.discarded, fromAt, toAt };
  }

  annotateLongTask(at: Milliseconds, durationMs: Milliseconds): void {
    this.pushEvent({ type: "longtask", at, durationMs });
    this.changed();
  }

  private rateChanged(now: Milliseconds): void {
    if (this.current.state === "idle" || this.schedule === null) return;
    const burst = this.schedule.burst(now).state === "active";
    this.pushEvent({ type: "rate", runId: this.current.run.runId, at: now, targetHz: this.schedule.hzAt(now), burst });
    if (this.current.state === "running") this.armTick();
    this.changed();
  }

  private suspend(reason: "hidden" | "user"): void {
    if (this.current.state !== "running") return;
    const run = this.current.run;
    const now = this.deps.clock.now();
    this.cancelInflight(now);
    this.clearTick();
    this.clearEndTimer();
    this.current = { state: "paused", run, reason };
    this.pushEvent({ type: "pause", runId: run.runId, at: now, reason });
    this.changed();
  }

  private resumeRun(run: RunInfo): void {
    const now = this.deps.clock.now();
    this.segment++;
    this.openUnsent.clear();
    this.schedule?.restart(now);
    this.current = { state: "running", run };
    this.pushEvent({ type: "resume", runId: run.runId, at: now, segment: this.segment });
    this.armEndTimer(run);
    this.tick();
    this.changed();
  }

  private finish(reason: "stopped" | "session_limit"): void {
    if (this.current.state === "idle") return;
    const run = this.current.run;
    const now = this.deps.clock.now();
    this.cancelInflight(now);
    this.clearTick();
    this.clearEndTimer();
    run.endedAt = now;
    run.endReason = reason;
    this.pushEvent({ type: "end", runId: run.runId, at: now, reason });
    this.current = { state: "idle" };
    this.schedule = null;
    this.changed();
  }

  private clearEndTimer(): void {
    if (this.endTimer !== null) this.deps.timers.clearTimeout(this.endTimer);
    this.endTimer = null;
  }

  private armEndTimer(run: RunInfo): void {
    this.clearEndTimer();
    this.endTimer = this.deps.timers.setTimeout(() => {
      this.endTimer = null;
      if (this.current.state !== "idle" && this.current.run === run) this.finish("session_limit");
    }, run.endsAt - this.deps.clock.now());
  }

  private clearTick(): void {
    if (this.tickTimer !== null) this.deps.timers.clearTimeout(this.tickTimer);
    this.tickTimer = null;
  }

  private armTick(): void {
    this.clearTick();
    if (this.schedule === null) return;
    const delay = Math.max(0, this.schedule.nextDeadline - this.deps.clock.now());
    this.tickTimer = this.deps.timers.setTimeout(() => {
      this.tickTimer = null;
      this.tick();
    }, delay);
  }

  private tick(): void {
    if (this.current.state !== "running" || this.schedule === null) return;
    const run = this.current.run;
    const now = this.deps.clock.now();
    if (now >= run.endsAt) {
      this.finish("session_limit");
      return;
    }
    const plan = this.schedule.advance(now);
    if (plan.missed !== null) {
      for (const provider of run.providers) this.recordMissed(run, provider, plan.missed);
    }
    if (plan.due !== null) this.dispatch(run, plan.due);
    this.armTick();
    if (plan.missed !== null || plan.due !== null) this.changed();
  }

  private recordMissed(run: RunInfo, provider: Provider, missed: MissedSlots): void {
    this.pushUnsent(run, provider, missed.schedulerGap ? "scheduler_gap" : "deadline_missed", {
      fromSlot: missed.fromSlot,
      toSlot: missed.toSlot,
      count: missed.count,
      fromIntendedAt: missed.fromIntendedAt,
      toIntendedAt: missed.toIntendedAt,
      targetHz: missed.targetHz,
      suspectedSuspension: missed.schedulerGap,
    });
  }

  private pushUnsent(
    run: RunInfo,
    provider: Provider,
    reason: UnsentRangeRecord["reason"],
    range: Pick<
      UnsentRangeRecord,
      "fromSlot" | "toSlot" | "count" | "fromIntendedAt" | "toIntendedAt" | "targetHz" | "suspectedSuspension"
    >,
  ): void {
    const open = this.openUnsent.get(provider);
    if (
      open !== undefined &&
      reason !== "scheduler_gap" &&
      open.reason === reason &&
      open.toSlot + 1 === range.fromSlot &&
      open.targetHz === range.targetHz
    ) {
      open.toSlot = range.toSlot;
      open.toIntendedAt = range.toIntendedAt;
      open.count += range.count;
      return;
    }
    const record: UnsentRangeRecord = {
      kind: "unsent",
      runId: run.runId,
      segment: this.segment,
      provider,
      reason,
      ...range,
    };
    this.records.push(record);
    this.openUnsent.set(provider, record);
  }

  private dispatch(run: RunInfo, due: DueSlot): void {
    const compare = run.mode === "compare";
    const order = compare && due.slot % 2 === 1 ? [...run.providers].reverse() : run.providers;
    for (const provider of order) {
      if (this.inflightFor(provider) >= INFLIGHT_CAP) {
        this.pushUnsent(run, provider, "concurrency_cap", {
          fromSlot: due.slot,
          toSlot: due.slot,
          count: 1,
          fromIntendedAt: due.intendedAt,
          toIntendedAt: due.intendedAt,
          targetHz: due.targetHz,
          suspectedSuspension: false,
        });
        continue;
      }
      this.launch(run, provider, due, compare);
    }
  }

  private launch(run: RunInfo, provider: Provider, due: DueSlot, compare: boolean): void {
    const now = this.deps.clock.now();
    const last = this.lastDispatch.get(provider);
    const origin = run.endpoints[provider];
    const record: Omit<AttemptRecord, "result"> = {
      kind: "attempt",
      runId: run.runId,
      segment: this.segment,
      provider,
      targetHz: due.targetHz,
      slot: due.slot,
      pairSeq: compare ? due.slot : null,
      probeId: this.deps.newProbeId(),
      intendedAt: due.intendedAt,
      sameOrigin: origin === run.uiOrigin,
      firstInRun: !this.dispatchedInRun.has(provider),
      firstAfterIdle: last === undefined || now - last >= IDLE_MS,
      warmup: due.intendedAt < run.startedAt + run.warmupMs,
    };
    this.dispatchedInRun.add(provider);
    this.lastDispatch.set(provider, now);
    this.openUnsent.delete(provider);
    const request = this.nextRequest++;
    const controller = new AbortController();
    this.inflight.set(request, { controller, dispatchedAt: now, record });
    this.deps
      .probe({ provider, origin }, record.probeId, controller.signal)
      .then((result) => this.complete(request, result));
  }

  private complete(request: number, result: ProbeResult): void {
    const entry = this.inflight.get(request);
    if (entry === undefined) return;
    this.inflight.delete(request);
    this.records.push({ ...entry.record, result });
    this.changed();
  }

  private cancelInflight(now: Milliseconds): void {
    for (const { controller, dispatchedAt, record } of this.inflight.values()) {
      controller.abort();
      this.records.push({
        ...record,
        result: { outcome: "cancelled", latencyMs: null, dispatchedAt, completedAt: now, response: null },
      });
    }
    this.inflight.clear();
  }

  private pushEvent(event: SessionEvent): void {
    this.events.push(event);
  }

  private changed(): void {
    this.revision++;
  }
}
