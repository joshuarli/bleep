import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSegments } from "../../src/measure/segments.ts";
import { nearestRank, runIndex, summarizeEndpoint, unsentSlotsIn } from "../../src/measure/stats.ts";
import { attempt, run, unsent } from "./records.ts";

const ALL = { fromAt: 0, toAt: Number.POSITIVE_INFINITY };

test("nearest-rank percentiles pick the value at rank ceil(q * n)", () => {
  const values = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(nearestRank(values, 0.5), 10);
  assert.equal(nearestRank(values, 0.95), 19);
  assert.equal(nearestRank([7], 0.95), 7);
  assert.equal(nearestRank([], 0.5), null);
  assert.equal(nearestRank([1, 2, 3], 0.5), 2);
});

test("known timings produce the expected count, median, p95, and maximum", () => {
  const latencies = [12, 40, 8, 15, 9, 30, 11, 10, 14, 13];
  const records = latencies.map((latencyMs, slot) => attempt({ provider: "cloudflare", slot, latencyMs }));
  const summary = summarizeEndpoint("cloudflare", records, ALL, runIndex([run()]), { excludeWarmup: false });
  assert.equal(summary.ok, 10);
  assert.equal(summary.medianMs, 12);
  assert.equal(summary.p95Ms, 40);
  assert.equal(summary.maxMs, 40);
  assert.equal(summary.latestMs, 13);
  assert.equal(summary.coverage, 1);
});

test("timeouts, errors, cancellations, and unsent slots never enter latency values", () => {
  const records = [
    attempt({ provider: "vercel", slot: 0, latencyMs: 20 }),
    attempt({ provider: "vercel", slot: 1, latencyMs: 3_000, outcome: "timeout" }),
    attempt({ provider: "vercel", slot: 2, latencyMs: 1, outcome: "network_error" }),
    attempt({ provider: "vercel", slot: 3, latencyMs: 2, outcome: "http_error" }),
    attempt({ provider: "vercel", slot: 4, latencyMs: 3, outcome: "invalid_response" }),
    attempt({ provider: "vercel", slot: 5, latencyMs: 4, outcome: "cancelled" }),
    unsent("vercel", 6, 4),
    attempt({ provider: "cloudflare", slot: 0, latencyMs: 1 }),
  ];
  const summary = summarizeEndpoint("vercel", records, ALL, runIndex([run()]), { excludeWarmup: false });
  assert.equal(summary.ok, 1);
  assert.deepEqual([summary.medianMs, summary.p95Ms, summary.maxMs], [20, 20, 20]);
  assert.deepEqual(summary.failures, { timeout: 1, network_error: 1, http_error: 1, invalid_response: 1 });
  assert.equal(summary.attempted, 5);
  assert.equal(summary.cancelled, 1);
  assert.equal(summary.sent, 6);
  assert.equal(summary.unsent, 4);
  assert.equal(summary.coverage, 1 / 9);
});

test("unsent ranges count only the slots inside the window", () => {
  const range = unsent("cloudflare", 10, 10);
  assert.equal(unsentSlotsIn(range, { fromAt: 0, toAt: 10_000 }), 10);
  assert.equal(unsentSlotsIn(range, { fromAt: 2_400, toAt: 3_000 }), 3);
  assert.equal(unsentSlotsIn(range, { fromAt: 0, toAt: 2_000 }), 0);
  assert.equal(unsentSlotsIn(unsent("cloudflare", 5, 1), { fromAt: 1_000, toAt: 1_001 }), 1);
});

test("warm-up is excluded from sustained summaries and retained in raw data", () => {
  const runs = runIndex([run({ warmupMs: 1_000 })]);
  const records = [
    attempt({ provider: "cloudflare", slot: 0, latencyMs: 500, warmup: true }),
    attempt({ provider: "cloudflare", slot: 4, latencyMs: 400, warmup: true }),
    unsent("cloudflare", 1, 3),
    attempt({ provider: "cloudflare", slot: 5, latencyMs: 10 }),
    attempt({ provider: "cloudflare", slot: 6, latencyMs: 20 }),
  ];
  const sustained = summarizeEndpoint("cloudflare", records, ALL, runs, { excludeWarmup: true });
  assert.deepEqual([sustained.ok, sustained.maxMs, sustained.unsent], [2, 20, 0]);
  const raw = summarizeEndpoint("cloudflare", records, ALL, runs, { excludeWarmup: false });
  assert.deepEqual([raw.ok, raw.maxMs, raw.unsent], [4, 500, 3]);
});

test("pauses, location changes, revision mismatches, and phases split segments", () => {
  const runs = runIndex([run(), run({ runId: "run-2", startedAt: 10_000 })]);
  const records = [
    attempt({ provider: "cloudflare", slot: 0, response: { location: "SJC" } }),
    attempt({ provider: "vercel", slot: 0, response: { location: "sfo1" } }),
    attempt({ provider: "cloudflare", slot: 1, response: { location: "SJC" } }),
    attempt({ provider: "cloudflare", slot: 2, response: { location: "LAX" } }),
    attempt({ provider: "cloudflare", slot: 3, segment: 2, response: { location: "LAX" } }),
    attempt({ provider: "vercel", slot: 4, segment: 2, response: { revision: "rev-b" } }),
    attempt({ provider: "cloudflare", slot: 6, segment: 2 }),
    attempt({ provider: "cloudflare", slot: 50, runId: "run-2", segment: 3 }),
  ];
  const { segments, segmentOf } = buildSegments(records, runs, [{ at: 1_100, label: "Upload started" }]);
  assert.deepEqual(
    segments.map((s) => s.startReasons),
    [["run"], ["location"], ["resume"], ["revision"], ["phase"], ["run"]],
  );
  assert.equal(segments[1]?.locations.cloudflare, "LAX");
  assert.equal(segments[1]?.locations.vercel, "sfo1");
  assert.equal(segments[2]?.revisionMismatch, false);
  assert.equal(segments[3]?.revisionMismatch, true);
  assert.equal(segments[4]?.phase, "Upload started");
  assert.equal(segmentOf.get(records[1]!), 0);
  assert.equal(segmentOf.get(records[3]!), 1);
});

test("a first observation of an unknown location does not split a segment", () => {
  const records = [
    attempt({ provider: "cloudflare", slot: 0, outcome: "timeout" }),
    attempt({ provider: "cloudflare", slot: 1, response: { location: "SJC" } }),
  ];
  const { segments } = buildSegments(records, runIndex([run()]), []);
  assert.equal(segments.length, 1);
});
