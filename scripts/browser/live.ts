import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ENDPOINTS_BY_TARGET } from "../../src/config/endpoints.ts";
import { PROVIDERS, type Provider } from "../../src/config/targets.ts";
import { parseExportJson } from "../../src/export/document.ts";
import { BrowserSession } from "./agent.ts";
import { downloadExports, graphSummary, markNow, q, summarizeCheck, summaryText, waitFor } from "./page.ts";

const EVIDENCE = resolve("docs/evidence/live");
const MEASURE_MS = 8_000;
const production = ENDPOINTS_BY_TARGET.production;

type NetworkRequest = { method: string; url: string };

type ArrangementResult = {
  ui: Provider;
  probe: Provider;
  origin: "same-origin" | "cross-origin";
  ok: number;
  attempted: number;
  failed: number;
  unsent: number;
  medianMs: number | null;
  locations: string[];
  revisions: string[];
  protocols: string[];
};

const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

async function captureProbeRequests(browser: BrowserSession, path: string): Promise<NetworkRequest[]> {
  await browser.command("network", "har", "stop", path);
  const har = JSON.parse(readFileSync(path, "utf8")) as { log: { entries: { request: NetworkRequest }[] } };
  rmSync(path);
  return har.log.entries.map((entry) => entry.request).filter((request) => new URL(request.url).pathname === "/probe");
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length / 2) - 1] ?? null;
}

async function proveFrom(ui: Provider): Promise<ArrangementResult[]> {
  const downloads = resolve(`.work/tmp/downloads/live-${ui}`);
  rmSync(downloads, { recursive: true, force: true });
  mkdirSync(downloads, { recursive: true });
  const browser = new BrowserSession(`blip-live-${ui}`, downloads);
  try {
    await browser.viewport(1280, 860);
    await browser.open(`${production[ui].origin}/`);
    await waitFor("controls", () => browser.eval<boolean>(`document.querySelector("#start") !== null`), (ready) => ready);
    await browser.command("network", "har", "start");
    await browser.command("click", "input[name=mode][value=compare]");
    await browser.command("click", "#start");
    await waitFor("warm-up notice", () => summaryText(browser, "[data-warmup=active]"), (text) => text !== null);
    await waitFor("warm-up to finish", () => summaryText(browser, "[data-warmup=active]"), (text) => text === null, 20_000);
    await markNow(browser, "Live check");
    await delay(MEASURE_MS / 2);

    await browser.command("click", "#graph");
    const paused = await waitFor("pause", () => graphSummary(browser), (s) => s.state === "paused");
    assert.equal(paused.inflight, 0);
    await delay(1_500);
    await browser.command("click", "#graph");
    await waitFor("resume with a visible pause", () => graphSummary(browser), (s) => s.state === "running" && s.pauseBands >= 1);
    await delay(MEASURE_MS / 2);

    await browser.viewport(390, 844);
    await delay(400);
    const overflow = await browser.eval<{ scroll: number; client: number }>(
      `({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth })`,
    );
    assert.ok(overflow.scroll <= overflow.client, `${ui} UI overflows at 390 px: ${q(overflow)}`);
    await browser.screenshot(resolve(EVIDENCE, `${ui}-ui-390.png`), false);
    await browser.viewport(1280, 860);

    await browser.command("click", "#stop");
    await waitFor("stop", () => graphSummary(browser), (s) => s.state === "idle");
    const files = await downloadExports(browser, resolve(".work/tmp/live-export", ui));
    renameSync(files.json, resolve(EVIDENCE, `${ui}-ui.json`));
    renameSync(files.csv, resolve(EVIDENCE, `${ui}-ui.csv`));
    await browser.screenshot(resolve(EVIDENCE, `${ui}-ui-desktop.png`), false);

    const requests = await captureProbeRequests(browser, resolve(downloads, "probes.har"));
    const preflights = requests.filter((request) => request.method === "OPTIONS");
    assert.equal(preflights.length, 0, `${ui} UI sent preflights: ${q(preflights.slice(0, 3))}`);
    for (const probe of PROVIDERS) {
      const host = new URL(production[probe].origin).host;
      assert.ok(requests.some((r) => r.method === "GET" && new URL(r.url).host === host), `${ui} UI sent no GET to ${host}`);
    }

    await browser.command("network", "har", "start");
    await browser.eval(
      `fetch(${q(`${production[ui === "cloudflare" ? "vercel" : "cloudflare"].origin}/probe?id=abcdefghijklmnopqrstuv`)}, { mode: "cors", credentials: "omit", cache: "no-store", headers: { "x-blip-control": "1" } }).then(() => "ok", () => "rejected")`,
    );
    await delay(500);
    const control = (await captureProbeRequests(browser, resolve(downloads, "control.har"))).filter(
      (request) => request.method === "OPTIONS",
    );
    assert.ok(control.length > 0, "the custom-header control produced no visible preflight, so the zero-preflight check cannot fail");

    const document = parseExportJson(readFileSync(resolve(EVIDENCE, `${ui}-ui.json`), "utf8"));
    assert.equal(document.app.frontendRevision, head, "page revision is not HEAD");
    assert.equal(document.app.uiOrigin, production[ui].origin);
    const ids = new Set<string>();
    return PROVIDERS.map((probe) => {
      const attempts = document.records.filter((r) => r.kind === "attempt" && r.provider === probe);
      const results: ArrangementResult = {
        ui,
        probe,
        origin: ui === probe ? "same-origin" : "cross-origin",
        ok: 0,
        attempted: 0,
        failed: 0,
        unsent: 0,
        medianMs: null,
        locations: [],
        revisions: [],
        protocols: [],
      };
      const latencies: number[] = [];
      const locations = new Set<string>();
      const revisions = new Set<string>();
      const protocols = new Set<string>();
      for (const record of document.records) {
        if (record.provider !== probe) continue;
        if (record.kind === "unsent") {
          results.unsent += record.count;
          continue;
        }
        assert.ok(!ids.has(record.probeId), "a probe ID repeated");
        ids.add(record.probeId);
        assert.equal(record.sameOrigin, ui === probe, `${ui} UI -> ${probe}: wrong same-origin flag`);
        const result = record.result;
        if (result.outcome === "cancelled" || record.warmup) continue;
        results.attempted++;
        if (result.outcome !== "ok") {
          results.failed++;
          continue;
        }
        results.ok++;
        latencies.push(result.latencyMs);
        if (result.response.location !== null) locations.add(result.response.location);
        if (result.response.revision !== null) revisions.add(result.response.revision);
        if (result.response.nextHopProtocol !== null) protocols.add(result.response.nextHopProtocol);
      }
      assert.ok(attempts.length > 0 && results.ok > 0, `${ui} UI -> ${probe}: no successful probes`);
      results.medianMs = median(latencies);
      results.locations = [...locations];
      results.revisions = [...revisions];
      results.protocols = [...protocols];
      assert.deepEqual(results.revisions, [head], `${ui} UI -> ${probe}: backend revisions ${q(results.revisions)}`);
      if (probe === "vercel") assert.deepEqual(results.locations, ["sfo1"], "Vercel did not execute in sfo1");
      else assert.ok(results.locations.every((l) => /^[A-Z]{3}$/.test(l)), `Cloudflare colos ${q(results.locations)}`);
      return results;
    });
  } finally {
    await browser.close();
  }
}

async function proof(): Promise<void> {
  rmSync(EVIDENCE, { recursive: true, force: true });
  mkdirSync(EVIDENCE, { recursive: true });
  const arrangements: ArrangementResult[] = [];
  for (const ui of PROVIDERS) arrangements.push(...(await proveFrom(ui)));

  const check = summarizeCheck([EVIDENCE]);
  assert.equal(check.code, 0, check.output);

  const ms = (value: number | null) => (value === null ? "–" : `${value.toFixed(1)} ms`);
  const rows = arrangements.map(
    (a) =>
      `| ${a.ui} page | ${a.probe} probe | ${a.origin} | ${a.ok} of ${a.attempted} | ${a.failed} | ${a.unsent} | ${ms(a.medianMs)} | ${a.locations.join(", ")} | ${a.protocols.join(", ") || "not reported"} |`,
  );
  writeFileSync(
    resolve(EVIDENCE, "README.md"),
    `# Live browser proof

  \`node scripts/browser/live.ts\` produced these files on ${new Date().toISOString().slice(0, 10)} from one machine and network. They are a functional proof, not a performance result.

  Both pages and both probes ran revision \`${head}\`. Each page ran Compare mode in headless Chrome for about ${MEASURE_MS / 1_000} s after the 10 s warm-up, with one pause and resume. The figures below exclude the warm-up and cancelled requests.

  | Page | Probe | Arrangement | Successful of attempted | Failed | Not sent | Median | Observed location | Protocol |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  ${rows.join("\n")}

  The check also verified these facts:

  - No probe request from either page caused an \`OPTIONS\` preflight. A control request with a custom header did cause one, so the check can fail.
  - Every probe ID was unique, and every successful response echoed its ID byte for byte.
  - Every backend reported the page's revision. Vercel reported \`sfo1\`.
  - Each page paused and resumed, and neither page overflows horizontally at 390 × 844.
  - Each export reproduces the summary its page displayed: \`node scripts/summarize-export.ts --check docs/evidence/live\`.

  \`node scripts/verify-live.ts --all\` covers the server side: anonymous access, the probe contract, nonce echoes, \`no-store\` with no cache hits, CORS on success and errors, and that Vercel is not served through Cloudflare.

  The exports contain no credentials or IP addresses. They contain random probe IDs, page-relative times, and the raw \`cf-ray\` and \`x-vercel-id\` request identifiers.
  `,
  );
  console.log(rows.join("\n"));
  console.log("live browser proof passed");
}

const RUNS = resolve("docs/evidence/runs");
const RUN_COUNT = 3;
const RUN_MS = 130_000;

async function recordRun(ui: Provider, index: number): Promise<void> {
  const downloads = resolve(`.work/tmp/downloads/run-${ui}-${index}`);
  rmSync(downloads, { recursive: true, force: true });
  mkdirSync(downloads, { recursive: true });
  const browser = new BrowserSession(`blip-run-${ui}`, downloads);
  try {
    await browser.viewport(1280, 860);
    await browser.open(`${production[ui].origin}/`);
    await waitFor("controls", () => browser.eval<boolean>(`document.querySelector("#start") !== null`), (ready) => ready);
    await browser.command("click", "input[name=scale][value=15m]");
    await browser.command("click", "input[name=mode][value=compare]");
    await browser.command("click", "#start");
    await delay(RUN_MS);
    await browser.command("click", "#stop");
    await waitFor("stop", () => graphSummary(browser), (s) => s.state === "idle");
    const files = await downloadExports(browser, resolve(".work/tmp/run-export", `${ui}-${index}`));
    renameSync(files.json, resolve(RUNS, `${ui}-ui-run${index}.json`));
    renameSync(files.csv, resolve(RUNS, `${ui}-ui-run${index}.csv`));
    console.log(`${ui} UI run ${index} saved`);
  } finally {
    await browser.close();
  }
}

async function runs(): Promise<void> {
  rmSync(RUNS, { recursive: true, force: true });
  mkdirSync(RUNS, { recursive: true });
  for (let index = 1; index <= RUN_COUNT; index++) {
    for (const ui of PROVIDERS) await recordRun(ui, index);
  }
  const check = summarizeCheck([RUNS]);
  assert.equal(check.code, 0, check.output);
  console.log(check.output.trim());
}

const mode = process.argv[2] ?? "proof";
if (mode === "proof") await proof();
else if (mode === "runs") await runs();
else {
  console.error("usage: node scripts/browser/live.ts [proof|runs]");
  process.exit(2);
}
