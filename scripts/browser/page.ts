import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Provider } from "../../src/config/targets.ts";
import type { Report } from "../../src/measure/report.ts";
import type { BrowserSession } from "./agent.ts";

export const q = (value: unknown) => JSON.stringify(value);

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

export const SCREENSHOTS = resolve(".work/tmp/screens");

export const graphSummary = (browser: BrowserSession) =>
  browser.eval<GraphSummary>(`JSON.parse(document.querySelector("figure.graph").dataset.summary)`);

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

export const displayedReport = (browser: BrowserSession) =>
  browser.eval<Report>(`JSON.parse(document.querySelector("#summary").dataset.report)`);

export const summaryText = (browser: BrowserSession, selector: string) =>
  browser.eval<string | null>(`document.querySelector(${q(selector)})?.textContent ?? null`);

export const domClick = (browser: BrowserSession, selector: string) =>
  browser.eval(`document.querySelector(${q(selector)}).click()`);

export async function markNow(browser: BrowserSession, label: string): Promise<string> {
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

export function assertNearlyEqual(actual: unknown, expected: unknown, path: string): void {
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

export async function downloadExports(browser: BrowserSession, directory: string): Promise<{ json: string; csv: string }> {
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
    assert.match(name, /^blip-[a-z0-9._-]+-\d{4}-\d{2}-\d{2}T[\d-]+Z\.(json|csv)$/);
    files[extension] = resolve(directory, `export.${extension}`);
    renameSync(resolve(browser.downloads, name), files[extension]);
  }
  const stems = new Set(fresh.map((name) => name.replace(/\.(json|csv)$/, "")));
  assert.equal(stems.size, 1, "JSON and CSV came from different snapshots");
  return { json: files.json ?? "", csv: files.csv ?? "" };
}

export function summarizeCheck(paths: string[]): { code: number; output: string } {
  try {
    const output = execFileSync("node", ["scripts/summarize-export.ts", "--check", ...paths], { encoding: "utf8", stdio: "pipe" });
    return { code: 0, output };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failed.status ?? 1, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
  }
}
