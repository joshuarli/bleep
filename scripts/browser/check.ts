import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "vite";
import { ENDPOINTS_BY_TARGET } from "../../src/config/endpoints.ts";
import { PROVIDERS, type Provider } from "../../src/config/targets.ts";
import { PROBE_REQUEST } from "../../src/measure/probe-client.ts";
import { parseExportJson } from "../../src/export/document.ts";
import type { Report } from "../../src/measure/report.ts";
import type { ProbeResult } from "../../src/measure/types.ts";
import { FixtureOrigin, SIMULATED_LOCATION, type Fault } from "../../test/fixtures/fixture-origin.ts";
import { BrowserSession } from "./agent.ts";

const FIXTURE_ROOT = resolve("dist/fixture");

export type Stack = {
  browser: BrowserSession;
  origins: Record<Provider, FixtureOrigin>;
};

type Scenario = (stack: Stack) => Promise<void>;

const q = (value: unknown) => JSON.stringify(value);
const portOf = (origin: string) => Number(new URL(origin).port);

function stamp(target: "fixture" | "local"): void {
  execFileSync("node", ["scripts/stamp.ts"], { env: { ...process.env, BLIP_TARGET: target }, stdio: "inherit" });
}

async function buildFixtureUi(): Promise<void> {
  stamp("fixture");
  await build({
    configFile: false,
    logLevel: "warn",
    build: {
      outDir: FIXTURE_ROOT,
      emptyOutDir: true,
      rollupOptions: { input: { main: resolve("index.html"), harness: resolve("scripts/browser/harness.html") } },
    },
  });
}

async function withStack(name: string, scenario: Scenario): Promise<void> {
  const endpoints = ENDPOINTS_BY_TARGET.fixture;
  const origins = {
    cloudflare: new FixtureOrigin("cloudflare", portOf(endpoints.cloudflare.origin), FIXTURE_ROOT),
    vercel: new FixtureOrigin("vercel", portOf(endpoints.vercel.origin), FIXTURE_ROOT),
  };
  const downloads = resolve(`.work/tmp/downloads/${name}`);
  rmSync(downloads, { recursive: true, force: true });
  mkdirSync(downloads, { recursive: true });
  const browser = new BrowserSession(`blip-${name}`, downloads);
  try {
    for (const origin of Object.values(origins)) await origin.start();
    await scenario({ browser, origins });
    console.log(`scenario ${name} passed (simulated fixture endpoints)`);
  } catch (error) {
    const state = await browser
      .eval<unknown>(
        `({ graph: document.querySelector("figure.graph")?.dataset.summary ?? null, report: document.querySelector("#summary")?.dataset.report ?? null, comparison: document.querySelector("#interval-compare")?.dataset.comparison ?? null, text: document.querySelector("main")?.innerText ?? null })`,
      )
      .catch((dumpError: unknown) => ({ dumpError: String(dumpError) }));
    mkdirSync(resolve(".work/tmp"), { recursive: true });
    const dump = resolve(`.work/tmp/check-${name}-failure.json`);
    writeFileSync(dump, JSON.stringify(state, null, 1));
    console.error(`scenario ${name} failed; page state saved to ${dump}`);
    throw error;
  } finally {
    await browser.close();
    for (const origin of Object.values(origins)) await origin.stop();
  }
}

const harnessUrl = (origin: FixtureOrigin) => `${origin.origin}/scripts/browser/harness.html`;

function probeInPage(browser: BrowserSession, target: FixtureOrigin, timeoutMs = 3_000): Promise<ProbeResult> {
  return browser.eval<ProbeResult>(`blipHarness.probe(${q(target.provider)}, ${q(target.origin)}, ${timeoutMs})`);
}

const FAULT_EXPECTATIONS: { fault: Fault; outcome: ProbeResult["outcome"]; invalidReason?: string }[] = [
  { fault: { kind: "delay", ms: 300 }, outcome: "ok" },
  { fault: { kind: "hang" }, outcome: "timeout" },
  { fault: { kind: "status", status: 500 }, outcome: "http_error" },
  { fault: { kind: "status", status: 404 }, outcome: "http_error" },
  { fault: { kind: "wrong_id" }, outcome: "invalid_response", invalidReason: "body_mismatch" },
  { fault: { kind: "html" }, outcome: "invalid_response", invalidReason: "body_mismatch" },
  { fault: { kind: "redirect" }, outcome: "invalid_response", invalidReason: "opaque_redirect" },
  { fault: { kind: "close" }, outcome: "network_error" },
];

async function stackScenario({ browser, origins }: Stack): Promise<void> {
  const all = PROVIDERS.map((provider) => origins[provider]);
  for (const origin of all) origin.resetCounts();

  for (const ui of all) {
    await browser.open(harnessUrl(ui));
    for (const target of all) {
      const result = await probeInPage(browser, target);
      const arrangement = `${ui.provider} UI -> ${target.provider} probe (${ui === target ? "same" : "cross"}-origin)`;
      assert.equal(result.outcome, "ok", `${arrangement}: ${q(result)}`);
      assert.equal(result.response?.location, SIMULATED_LOCATION, arrangement);
      console.log(`${arrangement}: ok in ${result.latencyMs?.toFixed(1)} ms`);
    }
  }
  for (const origin of all) {
    assert.equal(origin.probeCounts.OPTIONS, 0, `${origin.provider} saw a preflight`);
    assert.equal(origin.probeCounts.GET, 2, `${origin.provider} GET count`);
  }

  const ui = origins.cloudflare;
  await browser.open(harnessUrl(ui));
  for (const target of all) {
    for (const { fault, outcome, invalidReason } of FAULT_EXPECTATIONS) {
      target.fault = fault;
      const result = await probeInPage(browser, target, 1_000);
      target.fault = { kind: "ok" };
      const where = `${target.provider} fault ${q(fault)}`;
      assert.equal(result.outcome, outcome, `${where}: ${q(result)}`);
      if (invalidReason !== undefined) {
        assert.equal(result.outcome === "invalid_response" && result.invalidReason, invalidReason, where);
      }
      if (outcome === "ok") assert.ok((result.latencyMs ?? 0) >= 300, where);
      else assert.equal(result.latencyMs, null, where);
    }
  }
  console.log(`fault classification matched in the browser for ${FAULT_EXPECTATIONS.length} faults per endpoint`);
  for (const origin of all) assert.equal(origin.probeCounts.OPTIONS, 0, `${origin.provider} saw a preflight`);

  const control = origins.vercel;
  control.resetCounts();
  const controlInit = { ...PROBE_REQUEST, headers: { "x-blip-control": "1" } };
  await browser.eval(
    `fetch(${q(`${control.origin}/probe?id=abcdefghijklmnopqrstuv`)}, ${q(controlInit)}).then(() => "ok", () => "rejected")`,
  );
  assert.ok(control.probeCounts.OPTIONS > 0, "custom-header control did not trigger a preflight");
  console.log("custom-header control triggered a preflight, so the zero-preflight check can fail");
}

export type GraphSummary = {
  state: "idle" | "running" | "paused";
  pauseReason: "hidden" | "user" | null;
  mode: string | null;
  targetHz: number | null;
  achievedHz: number | null;
  inflight: number;
  records: number;
  maxFrameMs: number;
  okPoints: Record<Provider, number>;
  failures: Record<Provider, number>;
  unsentSlots: Record<Provider, number>;
  gaps: Record<Provider, number>;
  pauseBands: number;
  markers: number;
};

const SCREENSHOTS = resolve(".work/tmp/screens");

export const graphSummary = (browser: BrowserSession) =>
  browser.eval<GraphSummary>(`JSON.parse(document.querySelector("figure.graph").dataset.summary)`);

const canvasFingerprint = (browser: BrowserSession) =>
  browser.eval<number>(`(() => {
    const canvas = document.querySelector("#graph");
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 0;
    for (let i = 0; i < data.length; i += 4) hash = (hash * 31 + data[i] + data[i + 1] * 7 + data[i + 2] * 13) % 2147483647;
    return hash;
  })()`);

export async function waitFor<T>(
  what: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 8_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${q(value)}`);
    await delay(200);
    value = await read();
  }
  return value;
}

export async function startCompare(browser: BrowserSession, ui: FixtureOrigin): Promise<void> {
  await browser.viewport(1280, 860);
  await browser.open(`${ui.origin}/`);
  await browser.command("click", "input[name=mode][value=compare]");
  await browser.command("click", "#start");
}

export async function assertNoHorizontalOverflow(browser: BrowserSession, label: string): Promise<void> {
  await browser.viewport(390, 844);
  await delay(300);
  const overflow = await browser.eval<{ scroll: number; client: number; graph: number }>(
    `({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, graph: document.querySelector("#graph").getBoundingClientRect().width })`,
  );
  assert.ok(overflow.scroll <= overflow.client, `${label}: horizontal overflow ${q(overflow)}`);
  assert.ok(overflow.graph <= 390 && overflow.graph > 300, `${label}: graph width ${overflow.graph}`);
  mkdirSync(SCREENSHOTS, { recursive: true });
  await browser.screenshot(resolve(SCREENSHOTS, `${label}-390.png`));
  await browser.viewport(1280, 860);
}

async function liveScenario({ browser, origins }: Stack): Promise<void> {
  await startCompare(browser, origins.cloudflare);
  const running = await waitFor(
    "samples from both destinations",
    () => graphSummary(browser),
    (s) => s.okPoints.cloudflare >= 5 && s.okPoints.vercel >= 5,
  );
  assert.equal(running.state, "running");
  assert.equal(running.mode, "compare");
  assert.equal(running.targetHz, 5);

  const before = await canvasFingerprint(browser);
  await delay(700);
  assert.notEqual(await canvasFingerprint(browser), before, "canvas did not change while measuring");

  await browser.command("click", "#graph");
  const paused = await waitFor("user pause", () => graphSummary(browser), (s) => s.state === "paused");
  assert.equal(paused.pauseReason, "user");
  assert.equal(paused.inflight, 0);
  await delay(1_500);
  const pausedLater = await graphSummary(browser);
  assert.equal(pausedLater.okPoints.cloudflare, paused.okPoints.cloudflare, "samples arrived while paused");
  await browser.command("click", "#graph");
  const resumed = await waitFor("resume", () => graphSummary(browser), (s) => s.state === "running" && s.pauseBands >= 1);
  console.log(`pause band visible after resume (${resumed.pauseBands})`);

  origins.vercel.fault = { kind: "hang" };
  const hung = await waitFor(
    "Vercel timeouts and capped slots",
    () => graphSummary(browser),
    (s) => s.failures.vercel >= 2 && s.unsentSlots.vercel >= 1,
    10_000,
  );
  origins.vercel.fault = { kind: "ok" };
  assert.ok(hung.gaps.vercel >= 1, `no visible Vercel gap: ${q(hung)}`);
  assert.ok(hung.okPoints.cloudflare > resumed.okPoints.cloudflare, "Cloudflare stopped sampling during the Vercel hang");
  assert.equal(hung.failures.cloudflare, 0);
  console.log(`hang: Vercel ${hung.failures.vercel} failed, ${hung.unsentSlots.vercel} not sent; Cloudflare kept sampling`);

  mkdirSync(SCREENSHOTS, { recursive: true });
  await browser.screenshot(resolve(SCREENSHOTS, "live-desktop.png"));
  await assertNoHorizontalOverflow(browser, "live");

  await browser.command("click", "#stop");
  const stopped = await waitFor("stop", () => graphSummary(browser), (s) => s.state === "idle");
  assert.equal(stopped.inflight, 0);
  assert.ok(stopped.maxFrameMs < 250, `frame task ${stopped.maxFrameMs} ms`);
  console.log(`max frame task ${stopped.maxFrameMs.toFixed(1)} ms`);
}

export const displayedReport = (browser: BrowserSession) =>
  browser.eval<Report>(`JSON.parse(document.querySelector("#summary").dataset.report)`);

const summaryText = (browser: BrowserSession, selector: string) =>
  browser.eval<string | null>(`document.querySelector(${q(selector)})?.textContent ?? null`);

async function compareScenario({ browser, origins }: Stack): Promise<void> {
  origins.vercel.fault = { kind: "delay", ms: 40 };
  await startCompare(browser, origins.vercel);
  await waitFor("warm-up notice", () => summaryText(browser, "[data-warmup=active]"), (text) => text !== null);

  const report = await waitFor(
    "paired comparison after warm-up",
    () => displayedReport(browser),
    (r) => (r.rows[0]?.pairs?.differenceCount ?? 0) >= 10,
    20_000,
  );
  const row = report.rows[0];
  assert.ok(row?.pairs);
  const difference = row.pairs.medianDifferenceMs ?? Number.NaN;
  assert.ok(difference >= 35 && difference <= 120, `median paired difference ${difference}`);
  assert.equal(row.pairs.warmupExcluded > 0, true, "warm-up pairs were not excluded");
  const text = await summaryText(browser, "[data-metric=median-difference]");
  assert.match(text ?? "", /^Median paired difference: \+\d+ ms \(Vercel − Cloudflare\): Vercel took longer/);
  const vercelMedian = await summaryText(browser, "tr[data-metric=median] td[data-provider=vercel]");
  assert.match(vercelMedian ?? "", /^\d+ ms$/);
  const achieved = await summaryText(browser, "tr[data-metric=achieved] td[data-provider=cloudflare]");
  const achievedHz = Number.parseFloat(achieved ?? "");
  assert.ok(achievedHz >= 4 && achievedHz <= 5.5, `displayed Cloudflare achieved rate ${achieved}`);
  console.log(`displayed: ${text}; Vercel median ${vercelMedian}; Cloudflare achieved ${achieved}`);

  origins.cloudflare.fault = { kind: "status", status: 500 };
  await waitFor(
    "Cloudflare failures counted as vercel_only pairs",
    () => summaryText(browser, "tr[data-category=vercel_only] td"),
    (count) => Number(count) >= 3,
  );
  origins.cloudflare.fault = { kind: "ok" };
  const errors = await summaryText(browser, "tr[data-metric=errors] td[data-provider=cloudflare]");
  assert.match(errors ?? "", /^[1-9]\d* of \d+ \(network 0, HTTP [1-9]/);

  origins.vercel.revisionOverride = "0000000000000000000000000000000000000000";
  const warning = await waitFor(
    "revision mismatch warning",
    () => summaryText(browser, "[data-revision-mismatch]"),
    (value) => value !== null,
  );
  origins.vercel.revisionOverride = null;
  assert.match(warning ?? "", /Revision mismatch/);
  const split = await displayedReport(browser);
  assert.ok(split.spansSegments, "a backend revision change did not split the window into segments");
  assert.ok(await summaryText(browser, "[data-spans-segments]"));
  console.log("revision mismatch warned and split the window into per-segment rows");

  await assertNoHorizontalOverflow(browser, "compare");
  await browser.command("click", "#stop");
  origins.vercel.fault = { kind: "ok" };
}

type ComparisonState = {
  rows: {
    role: "baseline" | "selected";
    interval: { markerId: string; label: string };
    spansSegments: boolean;
    sides: { provider: Provider; medianDeltaMs: number | null; summary: { ok: number; attempted: number; medianMs: number | null } }[];
  }[];
  baselineUsable: boolean;
};

const comparisonState = (browser: BrowserSession) =>
  browser.eval<ComparisonState>(`JSON.parse(document.querySelector("#interval-compare").dataset.comparison ?? '{"rows":[]}')`);

const domClick = (browser: BrowserSession, selector: string) =>
  browser.eval(`document.querySelector(${q(selector)}).click()`);

async function markNow(browser: BrowserSession, label: string): Promise<string> {
  const before = await browser.eval<string[]>(`[...document.querySelectorAll("#marker-list li")].map((li) => li.dataset.markerId)`);
  await browser.command("fill", "#marker-label", label);
  await browser.command("click", "#mark");
  const after = await waitFor(
    `marker ${label}`,
    () => browser.eval<string[]>(`[...document.querySelectorAll("#marker-list li")].map((li) => li.dataset.markerId)`),
    (ids) => ids.length === before.length + 1,
  );
  const added = after.find((id) => !before.includes(id));
  assert.ok(added);
  return added;
}

async function intervalsScenario({ browser, origins }: Stack): Promise<void> {
  await startCompare(browser, origins.cloudflare);
  await waitFor("warm-up notice", () => summaryText(browser, "[data-warmup=active]"), (text) => text !== null);
  await waitFor("warm-up to finish", () => summaryText(browser, "[data-warmup=active]"), (text) => text === null, 15_000);

  const baseline = await markNow(browser, "Baseline");
  await delay(2_000);
  origins.vercel.fault = { kind: "delay", ms: 60 };
  const upload = await markNow(browser, "Upload started");
  await delay(2_500);
  origins.vercel.fault = { kind: "ok" };
  const recovery = await markNow(browser, "Recovery");
  await delay(1_000);

  const hostile = '<img src=x onerror="window.__xss=1">';
  await browser.command("fill", `li[data-marker-id="${recovery}"] .label-edit`, hostile);
  await browser.command("press", "Enter");
  await browser.eval(`document.activeElement.blur()`);
  await waitFor(
    "relabelled phase in the summary",
    () => displayedReport(browser),
    (report) => report.rows.some((row) => row.phase === hostile),
  );
  const injected = await browser.eval<{ images: number; xss: unknown; text: boolean }>(
    `({ images: document.querySelectorAll("main img").length, xss: window.__xss ?? null, text: [...document.querySelectorAll(".label-edit")].some((input) => input.value.includes("<img")) })`,
  );
  assert.deepEqual(injected, { images: 0, xss: null, text: true }, "a marker label was interpreted as HTML");

  await domClick(browser, `input[data-select-interval="${baseline}"]`);
  await domClick(browser, `input[data-select-interval="${upload}"]`);
  const selected = await waitFor(
    "two selected intervals with both destinations",
    () => comparisonState(browser),
    (c) => c.rows.length === 2 && c.rows.every((row) => row.sides.length === 2),
  );
  const uploadRow = selected.rows.find((row) => row.interval.markerId === upload);
  const baseRow = selected.rows.find((row) => row.interval.markerId === baseline);
  const vercelMedian = (row: typeof uploadRow) => row?.sides.find((side) => side.provider === "vercel")?.summary.medianMs ?? 0;
  assert.ok(vercelMedian(uploadRow) - vercelMedian(baseRow) >= 50, `interval medians ${vercelMedian(baseRow)} -> ${vercelMedian(uploadRow)}`);

  const experimentBefore = await browser.eval<string>(`document.querySelector("#experiment").dataset.experimentId`);
  await domClick(browser, `button[data-baseline="${baseline}"]`);
  const withBaseline = await waitFor(
    "baseline deltas",
    () => comparisonState(browser),
    (c) => c.rows.some((row) => row.role === "baseline") && c.baselineUsable,
  );
  const delta = withBaseline.rows
    .find((row) => row.role === "selected" && row.interval.markerId === upload)
    ?.sides.find((side) => side.provider === "vercel")?.medianDeltaMs;
  assert.ok(delta !== null && delta !== undefined && delta >= 50, `Vercel median delta ${delta}`);
  const deltaText = await summaryText(browser, `tr[data-interval="${upload}"][data-provider=vercel][data-role=selected] td[data-metric=median-delta]`);
  assert.match(deltaText ?? "", /^\+\d+ ms$/);
  console.log(`Upload interval Vercel median vs baseline: ${deltaText}`);
  assert.equal(await browser.eval<boolean>(`document.querySelector('button[data-baseline="${upload}"]').disabled`), true, "baseline was not locked");

  await domClick(browser, "#clear-baseline");
  const experimentAfter = await waitFor(
    "new experiment",
    () => browser.eval<string>(`document.querySelector("#experiment").dataset.experimentId`),
    (id) => id !== experimentBefore,
  );
  assert.notEqual(experimentAfter, experimentBefore);

  await assertNoHorizontalOverflow(browser, "intervals");
  await browser.command("click", "#stop");
}

const EXPORTS = resolve(".work/tmp/exports");

function assertNearlyEqual(actual: unknown, expected: unknown, path: string): void {
  if (typeof actual === "number" && typeof expected === "number") {
    assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${path}: ${actual} != ${expected}`);
    return;
  }
  if (typeof actual !== "object" || actual === null || typeof expected !== "object" || expected === null) {
    assert.equal(actual, expected, path);
    return;
  }
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  for (const key of keys) {
    assertNearlyEqual((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], `${path}.${key}`);
  }
}

async function downloadExports(browser: BrowserSession, directory: string): Promise<{ json: string; csv: string }> {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const before = new Set(readdirSync(browser.downloads));
  await browser.command("click", "#export");
  const fresh = await waitFor(
    "both export files",
    async () => readdirSync(browser.downloads).filter((name) => !before.has(name) && !name.endsWith(".crdownload")),
    (names) => names.length === 2,
  );
  const files: Record<string, string> = {};
  for (const name of fresh) {
    const extension = name.endsWith(".json") ? "json" : name.endsWith(".csv") ? "csv" : null;
    assert.ok(extension, `unexpected download ${name}`);
    assert.match(name, /^blip-127\.0\.0\.1_\d+-\d{4}-\d{2}-\d{2}T/);
    files[extension] = resolve(directory, `export.${extension}`);
    renameSync(resolve(browser.downloads, name), files[extension]);
  }
  const stems = new Set(fresh.map((name) => name.replace(/\.(json|csv)$/, "")));
  assert.equal(stems.size, 1, "JSON and CSV came from different snapshots");
  return { json: files.json ?? "", csv: files.csv ?? "" };
}

function summarizeCheck(paths: string[]): { code: number; output: string } {
  try {
    const output = execFileSync("node", ["scripts/summarize-export.ts", "--check", ...paths], { encoding: "utf8", stdio: "pipe" });
    return { code: 0, output };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failed.status ?? 1, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
  }
}

async function exportScenario({ browser, origins }: Stack): Promise<void> {
  await startCompare(browser, origins.cloudflare);
  await waitFor("warm-up notice", () => summaryText(browser, "[data-warmup=active]"), (text) => text !== null);
  await waitFor("warm-up to finish", () => summaryText(browser, "[data-warmup=active]"), (text) => text === null, 15_000);
  await markNow(browser, "Baseline");
  await delay(1_500);
  origins.cloudflare.fault = { kind: "status", status: 500 };
  origins.vercel.fault = { kind: "hang" };
  await delay(800);
  origins.cloudflare.fault = { kind: "ok" };
  await markNow(browser, "Recovery");
  await delay(1_000);
  origins.vercel.fault = { kind: "ok" };

  const running = await downloadExports(browser, resolve(EXPORTS, "running"));
  await delay(3_500);
  await browser.command("click", "#stop");
  await waitFor("stop", () => graphSummary(browser), (s) => s.state === "idle");
  const stopped = await downloadExports(browser, resolve(EXPORTS, "stopped"));

  const document = parseExportJson(readFileSync(stopped.json, "utf8"));
  assertNearlyEqual(document.displayed, await displayedReport(browser), "displayed");
  const outcomes = new Set(document.records.map((r) => (r.kind === "attempt" ? r.result.outcome : `unsent:${r.reason}`)));
  for (const outcome of ["ok", "http_error", "timeout", "unsent:concurrency_cap"]) {
    assert.ok(outcomes.has(outcome), `export lacks ${outcome}: ${[...outcomes].join(", ")}`);
  }
  assert.equal(document.markers.length, 2);
  const csv = readFileSync(stopped.csv, "utf8");
  for (const type of ["run", "attempt", "unsent_range", "marker", "segment"]) {
    assert.match(csv, new RegExp(`\\r\\n${type},`), `CSV lacks ${type} rows`);
  }

  const result = summarizeCheck([resolve(EXPORTS, "running"), resolve(EXPORTS, "stopped")]);
  assert.equal(result.code, 0, result.output);
  console.log(result.output.trim());

  const tampered = resolve(EXPORTS, "tampered");
  rmSync(tampered, { recursive: true, force: true });
  mkdirSync(tampered, { recursive: true });
  const altered = structuredClone(document);
  const okAttempt = altered.records.find((r) => r.kind === "attempt" && r.result.outcome === "ok" && !r.warmup);
  assert.ok(okAttempt && okAttempt.kind === "attempt" && okAttempt.result.outcome === "ok");
  okAttempt.result.latencyMs += 5_000;
  writeFileSync(resolve(tampered, "export.json"), JSON.stringify(altered));
  const rejected = summarizeCheck([tampered]);
  assert.notEqual(rejected.code, 0, "a tampered export still reproduced the displayed summary");
  console.log("tampered export correctly failed to reproduce");
}

const SCENARIOS: Record<string, Scenario> = {
  stack: stackScenario,
  live: liveScenario,
  compare: compareScenario,
  intervals: intervalsScenario,
  export: exportScenario,
};

const requested = process.argv[2];
const names = requested === "all" ? Object.keys(SCENARIOS) : requested !== undefined && requested in SCENARIOS ? [requested] : null;
if (process.argv.length !== 3 || names === null) {
  console.error(`usage: node scripts/browser/check.ts <${[...Object.keys(SCENARIOS), "all"].join("|")}>`);
  process.exit(2);
}

try {
  await buildFixtureUi();
  for (const name of names) {
    const scenario = SCENARIOS[name];
    if (scenario !== undefined) await withStack(name, scenario);
  }
} finally {
  stamp("local");
}
