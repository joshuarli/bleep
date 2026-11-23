import assert from "node:assert/strict";
import { test } from "node:test";
import vercel from "../api/probe.ts";
import worker from "../worker/index.ts";
import { assertProbeContract } from "./probe-contract.ts";

const ID = "abcdefghijklmnopqrstuv";
const url = (path: string) => `https://probe.test${path}`;

test("Cloudflare adapter obeys the probe contract and reports its colo", async () => {
  await assertProbeContract((path, init) => worker.fetch(new Request(url(path), init)), "cloudflare");
  const request = Object.assign(new Request(url(`/probe?id=${ID}`)), { cf: { colo: "SJC" } });
  const response = worker.fetch(request);
  assert.equal(response.headers.get("x-blip-location"), "SJC");
  assert.equal(response.headers.get("x-blip-location-kind"), "colo");
});

test("Vercel adapter obeys the probe contract and reports its execution region", async (t) => {
  await assertProbeContract((path, init) => vercel.fetch(new Request(url(path), init)), "vercel");
  t.after(() => {
    delete process.env.VERCEL_REGION;
  });
  process.env.VERCEL_REGION = "sfo1";
  const response = vercel.fetch(new Request(url(`/probe?id=${ID}`)));
  assert.equal(response.headers.get("x-blip-location"), "sfo1");
  assert.equal(response.headers.get("x-blip-location-kind"), "execution-region");
});

test("both adapters return byte-identical success payloads", async () => {
  const request = () => new Request(url(`/probe?id=${ID}`));
  assert.equal(await worker.fetch(request()).text(), await vercel.fetch(request()).text());
});

test("a missing platform location is reported as unknown", () => {
  delete process.env.VERCEL_REGION;
  const response = vercel.fetch(new Request(url(`/probe?id=${ID}`)));
  assert.equal(response.headers.get("x-blip-location"), "unknown");
});

test("the Cloudflare adapter does not answer paths outside the probe route", () => {
  assert.equal(worker.fetch(new Request(url("/other"))).status, 404);
});
