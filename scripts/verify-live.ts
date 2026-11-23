import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { ENDPOINTS_BY_TARGET, type Endpoint } from "../src/config/endpoints.ts";
import { PROVIDERS, type Provider } from "../src/config/targets.ts";
import { assertProbeContract } from "../test/probe-contract.ts";

const MODES = ["--contract", "--all"] as const;
type Mode = (typeof MODES)[number];

const mode = process.argv[2];
if (process.argv.length !== 3 || !(MODES as readonly string[]).includes(mode ?? "")) {
  console.error(`usage: node scripts/verify-live.ts <${MODES.join("|")}>`);
  process.exit(2);
}

const production = ENDPOINTS_BY_TARGET.production;
const anonymous = (url: string, init?: RequestInit) =>
  fetch(url, { ...init, redirect: "manual", credentials: "omit", cache: "no-store" });
const freshId = () => randomBytes(16).toString("base64url");

async function verifyProbe(endpoint: Endpoint): Promise<string> {
  await assertProbeContract((path, init) => anonymous(`${endpoint.origin}${path}`, init), endpoint.provider);

  let revision: string | null = null;
  for (let i = 0; i < 3; i++) {
    const id = freshId();
    const response = await anonymous(`${endpoint.origin}/probe?id=${id}`);
    const where = `${endpoint.provider} probe ${i}`;
    assert.equal(response.status, 200, where);
    assert.equal(await response.text(), `{"v":1,"id":"${id}"}`, where);
    assert.equal(response.headers.get("cache-control"), "no-store", where);
    assert.equal(response.headers.get("access-control-allow-origin"), "*", where);
    assert.equal(response.headers.get("age"), null, `${where}: served from a cache`);
    assert.doesNotMatch(response.headers.get("x-vercel-cache") ?? "", /HIT|STALE/, where);
    assert.doesNotMatch(response.headers.get("cf-cache-status") ?? "", /HIT|STALE/, where);
    assert.doesNotMatch(response.headers.get("content-type") ?? "", /html/, where);
    const reported = response.headers.get("x-blip-revision");
    assert.ok(reported && !reported.endsWith("-dirty"), `${where}: revision ${reported}`);
    assert.ok(revision === null || revision === reported, `${where}: revision changed mid-check`);
    revision = reported;
    assertLocation(endpoint.provider, response.headers, where);
  }
  assert.ok(revision);
  return revision;
}

function assertLocation(provider: Provider, headers: Headers, where: string): void {
  const location = headers.get("x-blip-location");
  if (provider === "cloudflare") {
    assert.equal(headers.get("x-blip-location-kind"), "colo", where);
    assert.match(location ?? "", /^[A-Z]{3}$/, `${where}: colo ${location}`);
    assert.ok(headers.get("cf-ray"), `${where}: missing cf-ray`);
  } else {
    assert.equal(headers.get("x-blip-location-kind"), "execution-region", where);
    assert.equal(location, "sfo1", `${where}: Vercel executed in ${location}, not sfo1`);
    assert.equal(headers.get("cf-ray"), null, `${where}: Vercel response passed through Cloudflare`);
    assert.ok(
      /vercel/i.test(headers.get("server") ?? "") || headers.get("x-vercel-id"),
      `${where}: response does not identify Vercel`,
    );
  }
}

async function verifyPage(endpoint: Endpoint): Promise<string> {
  const page = await anonymous(`${endpoint.origin}/`);
  const where = `${endpoint.provider} UI`;
  assert.equal(page.status, 200, where);
  const html = await page.text();
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(scripts.length > 0, `${where}: no module script`);
  let bundle = "";
  for (const src of scripts) {
    const script = await anonymous(new URL(src ?? "", `${endpoint.origin}/`).toString());
    assert.equal(script.status, 200, `${where}: ${src}`);
    bundle += await script.text();
  }
  for (const target of PROVIDERS) {
    assert.ok(bundle.includes(production[target].origin), `${where}: bundle lacks ${target} endpoint`);
  }
  const revision = bundle.match(/\b[0-9a-f]{40}(?:-dirty)?\b/)?.[0];
  assert.ok(revision && !revision.endsWith("-dirty"), `${where}: revision ${revision}`);
  return revision;
}

const revisions: Record<string, string> = {};
for (const provider of PROVIDERS) {
  revisions[`${provider} probe`] = await verifyProbe(production[provider]);
}
if ((mode as Mode) === "--all") {
  for (const provider of PROVIDERS) {
    revisions[`${provider} UI`] = await verifyPage(production[provider]);
  }
  const distinct = new Set(Object.values(revisions));
  assert.equal(distinct.size, 1, `deployed revisions differ: ${JSON.stringify(revisions)}`);
}

const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
for (const [what, revision] of Object.entries(revisions)) {
  console.log(`${what}: ${revision}${revision === head ? " (HEAD)" : ""}`);
}
console.log(`verify-live ${mode} passed`);
