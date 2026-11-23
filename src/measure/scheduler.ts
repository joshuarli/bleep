import type { Milliseconds, SelectedRate } from "./types.ts";

export const RATE_HZ = { normal: 5, low: 1, burst: 20 } as const satisfies Record<SelectedRate | "burst", number>;
export const BURST_MS = 30_000;
export const BURST_COOLDOWN_MS = 60_000;
export const SCHEDULER_GAP_MS = 1_000;

export const lateThresholdMs = (intervalMs: Milliseconds): Milliseconds => Math.min(intervalMs / 2, 100);

export type MissedSlots = {
  fromSlot: number;
  toSlot: number;
  count: number;
  fromIntendedAt: Milliseconds;
  toIntendedAt: Milliseconds;
  targetHz: number;
  schedulerGap: boolean;
};

export type DueSlot = { slot: number; intendedAt: Milliseconds; targetHz: number };

export type SlotPlan = { missed: MissedSlots | null; due: DueSlot | null };

export type BurstState =
  | { state: "available" }
  | { state: "active"; endsAt: Milliseconds }
  | { state: "cooldown"; availableAt: Milliseconds };

export class SlotSchedule {
  private slot = 0;
  private deadline: Milliseconds;
  private previousDeadline: Milliseconds | null = null;
  private selectedRate: SelectedRate;
  private burstUntil: Milliseconds | null = null;

  constructor(start: Milliseconds, selected: SelectedRate, burstUntil: Milliseconds | null) {
    this.deadline = start;
    this.selectedRate = selected;
    this.burstUntil = burstUntil;
  }

  get burstEndsAt(): Milliseconds | null {
    return this.burstUntil;
  }

  get nextDeadline(): Milliseconds {
    return this.deadline;
  }

  get selected(): SelectedRate {
    return this.selectedRate;
  }

  hzAt(at: Milliseconds): number {
    return this.burstUntil !== null && at < this.burstUntil ? RATE_HZ.burst : RATE_HZ[this.selectedRate];
  }

  burst(now: Milliseconds): BurstState {
    if (this.burstUntil === null) return { state: "available" };
    if (now < this.burstUntil) return { state: "active", endsAt: this.burstUntil };
    const availableAt = this.burstUntil + BURST_COOLDOWN_MS;
    return now < availableAt ? { state: "cooldown", availableAt } : { state: "available" };
  }

  startBurst(now: Milliseconds): boolean {
    if (this.burst(now).state !== "available") return false;
    this.burstUntil = now + BURST_MS;
    this.retime(now);
    return true;
  }

  select(rate: SelectedRate, now: Milliseconds): void {
    this.selectedRate = rate;
    this.retime(now);
  }

  restart(now: Milliseconds): void {
    this.previousDeadline = null;
    this.deadline = now;
  }

  advance(now: Milliseconds): SlotPlan {
    let missed: MissedSlots | null = null;
    const miss = () => {
      if (missed === null) {
        missed = {
          fromSlot: this.slot,
          toSlot: this.slot,
          count: 0,
          fromIntendedAt: this.deadline,
          toIntendedAt: this.deadline,
          targetHz: this.hzAt(this.deadline),
          schedulerGap: false,
        };
      }
      missed.toSlot = this.slot;
      missed.toIntendedAt = this.deadline;
      missed.count++;
      this.step();
    };

    while (this.deadline + this.intervalAt(this.deadline) <= now) miss();

    let due: DueSlot | null = null;
    if (this.deadline <= now) {
      if (now - this.deadline <= lateThresholdMs(this.intervalAt(this.deadline))) {
        due = { slot: this.slot, intendedAt: this.deadline, targetHz: this.hzAt(this.deadline) };
        this.step();
      } else {
        miss();
      }
    }
    const found = missed as MissedSlots | null;
    if (found !== null) found.schedulerGap = now - found.fromIntendedAt > SCHEDULER_GAP_MS;
    return { missed: found, due };
  }

  private intervalAt(at: Milliseconds): Milliseconds {
    return 1_000 / this.hzAt(at);
  }

  private step(): void {
    this.previousDeadline = this.deadline;
    this.deadline += this.intervalAt(this.deadline);
    this.slot++;
  }

  private retime(now: Milliseconds): void {
    if (this.previousDeadline === null) return;
    this.deadline = Math.max(now, this.previousDeadline + this.intervalAt(now));
  }
}
