import assert from "node:assert/strict";
import { test } from "node:test";
import type { Provider } from "../../src/config/targets.ts";
import { sendProbe } from "../../src/measure/probe-client.ts";
import { Session, type SessionConfig } from "../../src/measure/session.ts";
import type { AttemptRecord, Mode, ProbeFetch, UnsentRangeRecord } from "../../src/measure/types.ts";
import { FakeTime, flush, hangingFetch, probeOkResponse } from "./fakes.ts";

const ENDPOINTS = { cloudflare: "https://cf.test", vercel: "https://v.test" };
type Behavior = ProbeFetch;

const instant =
  (provider: Provider): Behavior =>
  async (url) =>
    probeOkResponse(new URL(url).searchParams.get("id") ?? "", provider);

function harness(behavior: Partial<Record<Provider, Behavior>> = {}, config: Partial<SessionConfig> = {}) {
  const time = new FakeTime();
  let ids = 0;
  let runs = 0;
  const fetchFor = (provider: Provider) => behavior[provider] ?? instant(provider);
  const session = new Session(
    {
      clock: time,
      timers: time,
      probe: (target, id, cancel) =>
        sendProbe(
          { clock: time, timers: time, fetch: fetchFor(target.provider), resourceTiming: () => null },
          target,
          id,
          cancel,
        ),
      newProbeId: () => `probe-${ids++}`,
      newRunId: () => `run-${++runs}`,
      wallClock: () => 1_800_000_000_000 + time.now(),
    },
    { endpoints: ENDPOINTS, uiOrigin: "https://cf.test", uiRevision: "rev", ...config },
  );
  const runFor = async (ms: number, step = 10) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      time.advance(Math.min(step, ms - elapsed));
      await flush();
    }
  };
  const attempts = (provider?: Provider) =>
    session.records
      .toArray()
      .filter((r): r is AttemptRecord => r.kind === "attempt" && (provider === undefined || r.provider === provider));
  const unsent = (provider?: Provider) =>
    session.records
      .toArray()
      .filter((r): r is UnsentRangeRecord => r.kind === "unsent" && (provider === undefined || r.provider === provider));
  return { time, session, runFor, attempts, unsent };
}

const stateOf = (session: Session): string => session.state.state;
const intendedTimes = (records: AttemptRecord[]) => records.map((r) => r.intendedAt).sort((a, b) => a - b);
const spacing = (times: number[]) => times.slice(1).map((t, i) => t - (times[i] ?? 0));

async function assertQuiescent(h: ReturnType<typeof harness>): Promise<void> {
  await flush();
  assert.equal(h.session.inflightCount, 0, "in-flight requests remain");
  assert.equal(h.session.timerCount, 0, "session timers remain");
  assert.equal(h.time.timerCount, 0, "probe or session timers remain");
}

for (const [rate, hz] of [
  ["normal", 5],
  ["low", 1],
] as const) {
  test(`${rate} rate dispatches exactly on ${hz} Hz deadlines`, async () => {
    const h = harness();
    h.session.selectRate(rate);
    h.session.start("cloudflare");
    await h.runFor(10_000 - 1);
    const times = intendedTimes(h.attempts());
    assert.equal(times.length, hz * 10);
    assert.deepEqual(new Set(spacing(times)), new Set([1_000 / hz]));
    for (const attempt of h.attempts()) {
      assert.equal(attempt.result.dispatchedAt, attempt.intendedAt);
      assert.equal(attempt.result.outcome, "ok");
    }
    assert.equal(h.unsent().length, 0);
  });
}

test("a burst runs at 20 Hz for 30 seconds, returns to the selected rate, and honors the cooldown", async () => {
  const h = harness();
  h.session.start("cloudflare");
  await h.runFor(1_000);
  assert.equal(h.session.startBurst(), true);
  assert.equal(h.session.startBurst(), false);
  await h.runFor(30_000);
  const during = intendedTimes(h.attempts()).filter((t) => t >= 1_000 && t < 31_000);
  assert.equal(during.length, 600);
  assert.deepEqual(new Set(spacing(during)), new Set([50]));
  await h.runFor(10_000);
  const after = intendedTimes(h.attempts()).filter((t) => t >= 31_000);
  assert.deepEqual(new Set(spacing(after)), new Set([200]));
  assert.equal(h.session.burst().state, "cooldown");
  await h.runFor(49_990);
  assert.equal(h.session.startBurst(), false);
  await h.runFor(20);
  assert.equal(h.session.startBurst(), true);
});

test("a blocked timer produces unsent slots and no catch-up burst", async () => {
  const h = harness();
  h.session.start("cloudflare");
  await h.runFor(1_000);
  const before = h.attempts().length;
  h.time.stall(750);
  await h.runFor(1_000);
  const [missed, ...others] = h.unsent();
  assert.equal(others.length, 0);
  assert.equal(missed?.reason, "deadline_missed");
  assert.equal(missed?.suspectedSuspension, false);
  assert.equal(missed?.count, 3);
  assert.deepEqual([missed?.fromIntendedAt, missed?.toIntendedAt], [1_200, 1_600]);
  const resumed = intendedTimes(h.attempts()).filter((t) => t > 1_000);
  assert.deepEqual(resumed, [1_800, 2_000, 2_200, 2_400, 2_600]);
  assert.equal(h.attempts().length, before + 5);
});

test("a slot dispatched within the lateness threshold is sent late rather than skipped", async () => {
  const h = harness();
  h.session.start("cloudflare");
  await h.runFor(1_000);
  h.time.stall(650);
  await h.runFor(10);
  assert.equal(h.unsent()[0]?.count, 2);
  const late = h.attempts().find((a) => a.intendedAt === 1_600);
  assert.equal(late?.result.dispatchedAt, 1_650);
});

test("a long gap stays on the time axis as one bounded scheduler-gap record per endpoint", async () => {
  const h = harness();
  h.session.start("compare");
  await h.runFor(1_000);
  h.time.stall(60_000);
  await h.runFor(1_000);
  for (const provider of ["cloudflare", "vercel"] as const) {
    const gaps = h.unsent(provider);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]?.reason, "scheduler_gap");
    assert.equal(gaps[0]?.suspectedSuspension, true);
    assert.equal(gaps[0]?.count, 299);
    assert.equal(gaps[0]?.fromIntendedAt, 1_200);
    assert.equal(gaps[0]?.toIntendedAt, 60_800);
  }
  assert.equal(h.session.records.size, h.attempts().length + 2);
});

test("a stalled endpoint is capped at four in flight while the other keeps sampling", async () => {
  const h = harness({ cloudflare: hangingFetch() });
  h.session.start("compare");
  await h.runFor(2_000 - 1);
  assert.equal(h.session.inflightFor("cloudflare"), 4);
  assert.equal(h.attempts("cloudflare").length, 0);
  const capped = h.unsent("cloudflare");
  assert.equal(capped.length, 1);
  assert.equal(capped[0]?.reason, "concurrency_cap");
  assert.equal(capped[0]?.count, 6);
  assert.equal(h.attempts("vercel").length, 10);
  assert.ok(h.attempts("vercel").every((a) => a.result.outcome === "ok" && a.result.dispatchedAt === a.intendedAt));
  await h.runFor(1_700);
  const timedOut = h.attempts("cloudflare");
  assert.ok(timedOut.length >= 4);
  assert.ok(timedOut.every((a) => a.result.outcome === "timeout" && a.result.latencyMs === null));
});

for (const mode of ["cloudflare", "compare"] as Mode[]) {
  test(`stop, hidden, and start transitions in ${mode} mode abort work and leave nothing running`, async () => {
    const h = harness({ cloudflare: hangingFetch(), vercel: hangingFetch() });
    h.session.start(mode);
    await h.runFor(500);
    assert.ok(h.session.inflightCount > 0);
    h.session.setHidden(true);
    assert.equal(stateOf(h.session), "paused");
    await assertQuiescent(h);
    const cancelled = h.attempts().filter((a) => a.result.outcome === "cancelled");
    assert.equal(cancelled.length, mode === "compare" ? 6 : 3);
    assert.ok(cancelled.every((a) => a.result.latencyMs === null));

    h.session.setHidden(false);
    assert.equal(stateOf(h.session), "running");
    await h.runFor(300);
    h.session.start(mode);
    await h.runFor(300);
    h.session.stop();
    await assertQuiescent(h);
    assert.equal(stateOf(h.session), "idle");
  });
}

test("paused time is not counted as missed slots and resumes without catch-up in a new segment", async () => {
  const h = harness();
  h.session.start("cloudflare");
  await h.runFor(1_000);
  h.session.setHidden(true);
  await h.runFor(20_000);
  h.session.setHidden(false);
  await h.runFor(1_000);
  assert.equal(h.unsent().length, 0);
  const segments = new Set(h.attempts().map((a) => a.segment));
  assert.equal(segments.size, 2);
  const resumed = intendedTimes(h.attempts()).filter((t) => t > 1_000);
  assert.deepEqual(resumed.slice(0, 3), [21_000, 21_200, 21_400]);
  const events = h.session.events.toArray().map((e) => e.type);
  assert.deepEqual(events, ["rate", "pause", "resume"]);
  assert.equal(h.attempts().find((a) => a.intendedAt === 21_000)?.firstAfterIdle, true);
});

test("a user pause and resume behave like a hidden pause", async () => {
  const h = harness({ cloudflare: hangingFetch() });
  h.session.start("cloudflare");
  await h.runFor(500);
  h.session.pause();
  await assertQuiescent(h);
  h.session.resume();
  assert.equal(stateOf(h.session), "running");
});

test("a late response from an earlier run cannot modify a newer run", async () => {
  const resolvers: (() => void)[] = [];
  const ignoresAbort: ProbeFetch = (url) =>
    new Promise((resolve) => {
      resolvers.push(() => resolve(probeOkResponse(new URL(url).searchParams.get("id") ?? "", "cloudflare")));
    });
  const h = harness({ cloudflare: ignoresAbort });
  const first = h.session.start("cloudflare");
  await h.runFor(100);
  const second = h.session.start("cloudflare");
  const recordsBefore = h.session.records.size;
  const lateResolve = resolvers.shift();
  lateResolve?.();
  await flush();
  assert.equal(h.session.records.size, recordsBefore);
  assert.ok(h.attempts().every((a) => a.runId === second.runId || a.result.outcome === "cancelled"));
  assert.equal(h.attempts().filter((a) => a.runId === first.runId).length, 1);
});

test("the ring never exceeds capacity and reports discarded records and retained range", async () => {
  const h = harness({}, { capacity: 100 });
  h.session.start("compare");
  await h.runFor(20_000 - 1);
  const retention = h.session.retention();
  assert.equal(retention.size, 100);
  assert.equal(retention.discarded, 100);
  assert.equal(retention.fromAt, 10_000);
  assert.equal(retention.toAt, 19_800);
});

test("a session ends after 10 minutes and extends in 10-minute steps up to 60 minutes", async () => {
  const h = harness();
  const run = h.session.start("cloudflare");
  h.session.selectRate("low");
  await h.runFor(10 * 60_000 - 1, 1_000);
  assert.equal(stateOf(h.session), "running");
  await h.runFor(1, 1);
  assert.equal(stateOf(h.session), "idle");
  assert.equal(run.endReason, "session_limit");
  await assertQuiescent(h);

  const long = h.session.start("cloudflare");
  const extended = Array.from({ length: 6 }, () => h.session.extend());
  assert.deepEqual(extended, [true, true, true, true, true, false]);
  assert.equal(long.endsAt - long.startedAt, 60 * 60_000);
  h.session.setHidden(true);
  h.session.setHidden(false);
  await h.runFor(60 * 60_000, 5_000);
  assert.equal(long.endReason, "session_limit");
  assert.equal(long.endedAt, long.startedAt + 60 * 60_000);
});

test("compare mode pairs slots, alternates dispatch order, and flags warm-up and first probes", async () => {
  const order: Provider[] = [];
  const record =
    (provider: Provider): ProbeFetch =>
    async (url, init) => {
      order.push(provider);
      return instant(provider)(url, init);
    };
  const h = harness({ cloudflare: record("cloudflare"), vercel: record("vercel") });
  h.session.start("compare");
  await h.runFor(12_000 - 1);
  assert.deepEqual(order.slice(0, 4), ["cloudflare", "vercel", "vercel", "cloudflare"]);
  for (const provider of ["cloudflare", "vercel"] as const) {
    const attempts = h.attempts(provider).sort((a, b) => a.intendedAt - b.intendedAt);
    assert.deepEqual(attempts.map((a) => a.pairSeq), attempts.map((_, i) => i));
    assert.equal(attempts.filter((a) => a.warmup).length, 50);
    assert.deepEqual(attempts.map((a) => a.firstInRun).filter(Boolean).length, 1);
    assert.equal(attempts[0]?.sameOrigin, provider === "cloudflare");
  }
});

test("stopping and starting again does not skip the burst cooldown", async () => {
  const h = harness();
  h.session.start("cloudflare");
  assert.equal(h.session.startBurst(), true);
  await h.runFor(1_000);
  h.session.stop();
  h.session.start("cloudflare");
  assert.equal(h.session.startBurst(), false);
  assert.equal(h.session.targetHz(), 5);
  await h.runFor(60_000 - 10);
  assert.equal(h.session.startBurst(), false);
  await h.runFor(20);
  assert.equal(h.session.startBurst(), true);
});

test("long-task annotations cannot evict pause events", async () => {
  const h = harness();
  h.session.start("cloudflare");
  h.session.pause();
  for (let i = 0; i < 10_000; i++) h.session.annotateLongTask(i, 60);
  h.session.resume();
  const types = h.session.events.toArray().map((event) => event.type);
  assert.ok(types.includes("pause") && types.includes("resume"));
  assert.ok(h.session.longTasks.size <= 1_000);
  assert.ok(h.session.longTasks.discarded > 0);
});
