import assert from "node:assert/strict";
import { test } from "node:test";
import { newProbeId, sendProbe, type ProbeClientDeps } from "../../src/measure/probe-client.ts";
import type { ProbeFetch, ProbeResult } from "../../src/measure/types.ts";
import { fakeResponse, FakeTime, flush, hangingFetch, probeOkResponse } from "./fakes.ts";

const ID = "abcdefghijklmnopqrstuv";
const CLOUDFLARE = { provider: "cloudflare", origin: "https://cf.test" } as const;

function deps(time: FakeTime, fetch: ProbeFetch): ProbeClientDeps {
  return { clock: time, timers: time, fetch, resourceTiming: () => ({ nextHopProtocol: "h2" }) };
}

const respondWith =
  (time: FakeTime, response: () => Response, networkMs = 0): ProbeFetch =>
  async () => {
    time.stall(networkMs);
    return response();
  };

async function probe(fetch: (time: FakeTime) => ProbeFetch): Promise<ProbeResult> {
  const time = new FakeTime();
  return sendProbe(deps(time, fetch(time)), CLOUDFLARE, ID, new AbortController().signal);
}

function assertFailure(result: ProbeResult, outcome: ProbeResult["outcome"]): void {
  assert.equal(result.outcome, outcome);
  assert.equal(result.latencyMs, null);
}

test("a valid response is ok and carries latency and metadata", async () => {
  const result = await probe((time) =>
    respondWith(time, () => probeOkResponse(ID, "cloudflare", { "x-blip-location": "SJC", "cf-ray": "r-SJC" }), 42),
  );
  assert.equal(result.outcome, "ok");
  assert.equal(result.latencyMs, 42);
  assert.equal(result.response?.location, "SJC");
  assert.equal(result.response?.cfRay, "r-SJC");
  assert.equal(result.response?.nextHopProtocol, "h2");
});

test("timing stops after the body is read and before validation", async () => {
  const time = new FakeTime();
  const fetch: ProbeFetch = async () => {
    time.stall(10);
    const response = probeOkResponse(ID, "cloudflare");
    const text = response.text.bind(response);
    const get = response.headers.get.bind(response.headers);
    Object.defineProperty(response, "text", {
      value: async () => {
        time.stall(5);
        return text();
      },
    });
    Object.defineProperty(response.headers, "get", {
      value: (name: string) => {
        time.stall(1_000);
        return get(name);
      },
    });
    return response;
  };
  const result = await sendProbe(deps(time, fetch), CLOUDFLARE, ID, new AbortController().signal);
  assert.equal(result.outcome, "ok");
  assert.equal(result.latencyMs, 15);
});

test("a request that outlives the timeout is a timeout with no latency", async () => {
  const time = new FakeTime();
  const pending = sendProbe(deps(time, hangingFetch()), CLOUDFLARE, ID, new AbortController().signal);
  time.advance(2_999);
  await flush();
  time.advance(1);
  const result = await pending;
  assertFailure(result, "timeout");
  assert.equal(result.completedAt, 3_000);
  assert.equal(time.timerCount, 0);
});

test("a body that stalls past the timeout is a timeout", async () => {
  const time = new FakeTime();
  const fetch: ProbeFetch = async (_url, init) => {
    const response = probeOkResponse(ID, "cloudflare");
    Object.defineProperty(response, "text", {
      value: () =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
        ),
    });
    return response;
  };
  const pending = sendProbe(deps(time, fetch), CLOUDFLARE, ID, new AbortController().signal);
  await flush();
  time.advance(3_000);
  assertFailure(await pending, "timeout");
});

test("a fetch rejection is a network error", async () => {
  const result = await probe(() => async () => {
    throw new TypeError("Failed to fetch");
  });
  assertFailure(result, "network_error");
  assert.equal(result.response, null);
});

for (const status of [500, 404]) {
  test(`status ${status} is an http error`, async () => {
    const result = await probe((time) =>
      respondWith(time, () => fakeResponse({ status, body: "nope", headers: { "x-blip-provider": "cloudflare" } })),
    );
    assertFailure(result, "http_error");
    assert.equal(result.response?.status, status);
  });
}

const invalidCases: [string, () => Response, string][] = [
  ["a wrong ID", () => probeOkResponse("zzzzzzzzzzzzzzzzzzzzzz", "cloudflare"), "body_mismatch"],
  [
    "HTML with status 200",
    () => fakeResponse({ body: "<html>challenge</html>", headers: { "x-blip-provider": "cloudflare" } }),
    "body_mismatch",
  ],
  [
    "malformed JSON",
    () => fakeResponse({ body: `{"v":1,"id":"${ID}"`, headers: { "x-blip-provider": "cloudflare" } }),
    "body_mismatch",
  ],
  ["another provider's response", () => probeOkResponse(ID, "vercel"), "provider_mismatch"],
  ["an opaque redirect", () => fakeResponse({ status: 200, type: "opaqueredirect" }), "opaque_redirect"],
  ["an opaque response", () => fakeResponse({ type: "opaque" }), "opaque_response"],
];
for (const [name, response, reason] of invalidCases) {
  test(`${name} is an invalid response`, async () => {
    const result = await probe((time) => respondWith(time, response, 7));
    assertFailure(result, "invalid_response");
    assert.equal(result.outcome === "invalid_response" && result.invalidReason, reason);
  });
}

test("a caller abort is cancelled, not a timeout or network error", async () => {
  const time = new FakeTime();
  const cancel = new AbortController();
  const pending = sendProbe(deps(time, hangingFetch()), CLOUDFLARE, ID, cancel.signal);
  time.advance(100);
  cancel.abort();
  const result = await pending;
  assertFailure(result, "cancelled");
  assert.equal(time.timerCount, 0);
});

test("an already-cancelled probe never fetches", async () => {
  const time = new FakeTime();
  const cancel = new AbortController();
  cancel.abort();
  let fetched = false;
  const result = await sendProbe(
    deps(time, async () => {
      fetched = true;
      return probeOkResponse(ID, "cloudflare");
    }),
    CLOUDFLARE,
    ID,
    cancel.signal,
  );
  assertFailure(result, "cancelled");
  assert.equal(fetched, false);
});

test("the request is anonymous, uncached, manual-redirect CORS with no custom headers", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  await probe((time) => async (url, init) => {
    seen = { url, init };
    return respondWith(time, () => probeOkResponse(ID, "cloudflare"))(url, init);
  });
  assert.equal(seen?.url, `https://cf.test/probe?id=${ID}`);
  assert.equal(seen?.init.cache, "no-store");
  assert.equal(seen?.init.credentials, "omit");
  assert.equal(seen?.init.redirect, "manual");
  assert.equal(seen?.init.mode, "cors");
  assert.equal(seen?.init.headers, undefined);
});

test("probe IDs are 22 base64url characters from 16 random bytes", () => {
  const id = newProbeId((bytes) => bytes.fill(0xfb));
  assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(id, "-_v7-_v7-_v7-_v7-_v7-w");
  assert.notEqual(newProbeId((b) => crypto.getRandomValues(b)), newProbeId((b) => crypto.getRandomValues(b)));
});

test("an empty metadata header is recorded as absent", async () => {
  const result = await probe((time) => respondWith(time, () => probeOkResponse(ID, "cloudflare", { "x-blip-location": "" })));
  assert.equal(result.response?.location, null);
});
