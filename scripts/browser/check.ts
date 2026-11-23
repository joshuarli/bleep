import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { build } from "vite";
import { ENDPOINTS_BY_TARGET } from "../../src/config/endpoints.ts";
import { PROVIDERS, type Provider } from "../../src/config/targets.ts";
import { PROBE_REQUEST } from "../../src/measure/probe-client.ts";
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
  const browser = new BrowserSession(`blip-${name}`);
  try {
    for (const origin of Object.values(origins)) await origin.start();
    await scenario({ browser, origins });
    console.log(`scenario ${name} passed (simulated fixture endpoints)`);
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

const SCENARIOS: Record<string, Scenario> = {
  stack: stackScenario,
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
