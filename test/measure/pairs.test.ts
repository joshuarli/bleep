import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPairs, summarizePairs } from "../../src/measure/pairs.ts";
import { buildReport } from "../../src/measure/report.ts";
import { runIndex } from "../../src/measure/stats.ts";
import type { MeasurementRecord } from "../../src/measure/types.ts";
import { attempt, run, unsent } from "./records.ts";

const ALL = { fromAt: 0, toAt: Number.POSITIVE_INFINITY };
const runs = runIndex([run()]);

function summary(records: MeasurementRecord[], excludeWarmup = false) {
  const { pairs, incomplete } = buildPairs(records, runIndex([run({ warmupMs: 1_000 })]), ALL);
  return { pairs, summary: summarizePairs(pairs, incomplete, { excludeWarmup }) };
}

test("a known delay on Vercel produces a positive signed paired difference", () => {
  const records = [0, 1, 2, 3, 4].flatMap((slot) => [
    attempt({ provider: "cloudflare", slot, latencyMs: 20 + slot }),
    attempt({ provider: "vercel", slot, latencyMs: 20 + slot + 15 }),
  ]);
  const { pairs, incomplete } = buildPairs(records, runs, ALL);
  const result = summarizePairs(pairs, incomplete, { excludeWarmup: false });
  assert.equal(result.medianDifferenceMs, 15);
  assert.equal(result.counts.both_ok, 5);
  assert.equal(result.differenceCount, 5);
});

test("reversed completion order cannot swap or mismatch pairs", () => {
  const cf = [0, 1, 2].map((slot) => attempt({ provider: "cloudflare", slot, latencyMs: [5, 50, 500][slot] }));
  const v = [0, 1, 2].map((slot) => attempt({ provider: "vercel", slot, latencyMs: [6, 52, 503][slot] }));
  const arrival = [v[2]!, cf[1]!, v[0]!, cf[2]!, v[1]!, cf[0]!];
  const { pairs } = buildPairs(arrival, runs, ALL);
  assert.deepEqual(
    pairs.map((p) => [p.pairSeq, p.differenceMs]),
    [
      [0, 1],
      [1, 2],
      [2, 3],
    ],
  );
});

test("one side failing or unsent yields categories and no difference", () => {
  const records = [
    attempt({ provider: "cloudflare", slot: 0, latencyMs: 10 }),
    attempt({ provider: "vercel", slot: 0, outcome: "timeout" }),
    attempt({ provider: "cloudflare", slot: 1, outcome: "network_error" }),
    attempt({ provider: "vercel", slot: 1, latencyMs: 30 }),
    attempt({ provider: "cloudflare", slot: 2, outcome: "http_error" }),
    attempt({ provider: "vercel", slot: 2, outcome: "invalid_response" }),
    unsent("cloudflare", 3, 2),
    attempt({ provider: "vercel", slot: 3, outcome: "timeout" }),
    attempt({ provider: "vercel", slot: 4, latencyMs: 9 }),
    attempt({ provider: "cloudflare", slot: 5, latencyMs: 9 }),
  ];
  const { pairs, incomplete } = buildPairs(records, runs, ALL);
  assert.deepEqual(
    pairs.map((p) => [p.category, p.differenceMs]),
    [
      ["cloudflare_only", null],
      ["vercel_only", null],
      ["neither_valid", null],
      ["not_fully_sent", null],
      ["vercel_only", null],
    ],
  );
  assert.equal(incomplete, 1);
  const result = summarizePairs(pairs, incomplete, { excludeWarmup: false });
  assert.equal(result.medianDifferenceMs, null);
  assert.equal(result.differenceCount, 0);
});

test("excess dispatch skew is flagged, counted, and excluded from the median difference", () => {
  const records = [
    attempt({ provider: "cloudflare", slot: 0, latencyMs: 10 }),
    attempt({ provider: "vercel", slot: 0, latencyMs: 12 }),
    attempt({ provider: "cloudflare", slot: 1, latencyMs: 10, dispatchedAt: 200 }),
    attempt({ provider: "vercel", slot: 1, latencyMs: 110, dispatchedAt: 206 }),
    attempt({ provider: "cloudflare", slot: 2, latencyMs: 10, dispatchedAt: 400 }),
    attempt({ provider: "vercel", slot: 2, latencyMs: 14, dispatchedAt: 405 }),
  ];
  const { pairs, summary: result } = summary(records);
  assert.deepEqual(
    pairs.map((p) => [p.skewMs, p.skewFlagged]),
    [
      [0, false],
      [6, true],
      [5, false],
    ],
  );
  assert.equal(result.skewFlagged, 1);
  assert.equal(result.counts.both_ok, 3);
  assert.equal(result.differenceCount, 2);
  assert.equal(result.medianDifferenceMs, 2);
});

test("warm-up pairs are excluded from sustained comparison and kept in raw pairs", () => {
  const records = [0, 5, 6].flatMap((slot) => [
    attempt({ provider: "cloudflare", slot, latencyMs: 10 }),
    attempt({ provider: "vercel", slot, latencyMs: slot === 0 ? 500 : 13 }),
  ]);
  const sustained = summary(records, true);
  assert.equal(sustained.pairs.length, 3);
  assert.equal(sustained.summary.warmupExcluded, 1);
  assert.equal(sustained.summary.medianDifferenceMs, 3);
  assert.equal(summary(records, false).summary.pairs, 3);
});

test("single-endpoint runs never form pairs", () => {
  const single = runIndex([run({ mode: "cloudflare", providers: ["cloudflare"] })]);
  const { pairs, incomplete } = buildPairs([attempt({ provider: "cloudflare", slot: 0 })], single, ALL);
  assert.deepEqual([pairs.length, incomplete], [0, 0]);
});

test("pairs cancelled on both sides are not counted as both sent and failed", () => {
  const records = [
    attempt({ provider: "cloudflare", slot: 0, outcome: "cancelled" }),
    attempt({ provider: "vercel", slot: 0, outcome: "cancelled" }),
    attempt({ provider: "cloudflare", slot: 1, outcome: "timeout" }),
    attempt({ provider: "vercel", slot: 1, outcome: "cancelled" }),
  ];
  const { pairs } = buildPairs(records, runs, ALL);
  assert.deepEqual(pairs.map((p) => p.category), ["not_fully_sent", "not_fully_sent"]);
});

test("a location change on one side never splits a completed pair across report rows", () => {
  const records = [
    attempt({ provider: "cloudflare", slot: 0, latencyMs: 10, response: { location: "SJC" } }),
    attempt({ provider: "vercel", slot: 0, latencyMs: 20, response: { location: "sfo1" } }),
    attempt({ provider: "vercel", slot: 1, latencyMs: 21, response: { location: "sfo1" } }),
    attempt({ provider: "cloudflare", slot: 1, latencyMs: 11, response: { location: "LAX" } }),
    attempt({ provider: "vercel", slot: 2, latencyMs: 22, response: { location: "sfo1" } }),
    attempt({ provider: "cloudflare", slot: 2, latencyMs: 12, response: { location: "LAX" } }),
  ];
  const report = buildReport({ records, runs: [run()], markers: [], window: { ...ALL, label: "all" }, excludeWarmup: false });
  assert.equal(report.rows.length, 2);
  for (const row of report.rows) assert.equal(row.pairs?.incomplete, 0);
  assert.deepEqual(report.rows.map((row) => row.pairs?.counts.both_ok), [1, 2]);
});
