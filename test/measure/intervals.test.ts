import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanMarkerLabel, compareIntervals, intervalsFromMarkers, lockBaseline } from "../../src/measure/intervals.ts";
import { attempt, run } from "./records.ts";

const markers = [
  { id: "a", at: 0, label: "Baseline" },
  { id: "b", at: 2_000, label: "Upload started" },
];
const records = Array.from({ length: 20 }, (_, slot) => slot).flatMap((slot) => [
  attempt({ provider: "cloudflare", slot, latencyMs: 10 }),
  attempt({ provider: "vercel", slot, latencyMs: slot < 10 ? 20 : 80, outcome: slot === 15 ? "timeout" : "ok" }),
]);

test("interval comparison reports both destinations and baseline deltas per endpoint", () => {
  const [baseline, upload] = intervalsFromMarkers(markers, 4_000);
  assert.deepEqual([upload?.fromAt, upload?.toAt], [2_000, 4_000]);
  const result = compareIntervals(records, [run()], markers, [upload!], baseline!);
  assert.equal(result.baselineUsable, true);
  const selected = result.rows.find((row) => row.role === "selected");
  const vercel = selected?.sides.find((side) => side.provider === "vercel");
  const cloudflare = selected?.sides.find((side) => side.provider === "cloudflare");
  assert.equal(vercel?.medianDeltaMs, 60);
  assert.equal(vercel?.summary.failures.timeout, 1);
  assert.equal(vercel?.summary.attempted, 10);
  assert.equal(cloudflare?.medianDeltaMs, 0);
  assert.equal(result.rows[0]?.role, "baseline");
  assert.equal(result.rows[0]?.sides[0]?.medianDeltaMs, null);
});

test("a baseline is locked once set and labels are cleaned, not interpreted", () => {
  const [baseline] = intervalsFromMarkers(markers, 4_000);
  const experiment = lockBaseline({ id: "e1", baseline: null }, baseline!);
  assert.throws(() => lockBaseline(experiment, baseline!), /locked/);
  assert.equal(cleanMarkerLabel("  <b>x</b>\n"), "<b>x</b>");
  assert.throws(() => cleanMarkerLabel("   "), /needs a label/);
});
