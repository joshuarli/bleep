import assert from "node:assert/strict";

type ProbeFetch = (path: string, init?: RequestInit) => Promise<Response> | Response;

const VALID_ID = "abcdefghijklmnopqrstuv";

export async function assertProbeContract(
  probe: ProbeFetch,
  provider: "cloudflare" | "vercel",
): Promise<void> {
  const ok = await probe(`/probe?id=${VALID_ID}`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), `{"v":1,"id":"${VALID_ID}"}`);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  assert.equal(ok.headers.get("access-control-allow-origin"), "*");
  assert.equal(ok.headers.get("timing-allow-origin"), "*");
  assert.equal(ok.headers.get("x-blip-provider"), provider);
  assert.match(ok.headers.get("access-control-expose-headers") ?? "", /x-blip-revision/);
  assert.ok(ok.headers.get("x-blip-revision"));

  for (const path of [
    "/probe",
    "/probe?id=short",
    `/probe?id=${VALID_ID}x`,
    `/probe?id=${VALID_ID.slice(0, -1)}%21`,
    `/probe?id=${VALID_ID}&extra=1`,
    `/probe?id=${VALID_ID}&id=${VALID_ID}`,
  ]) {
    const rejected = await probe(path);
    assert.equal(rejected.status, 400, path);
    assert.equal(rejected.headers.get("access-control-allow-origin"), "*", path);
    assert.equal(rejected.headers.get("cache-control"), "no-store", path);
    assert.doesNotMatch(await rejected.text(), /"v":1/, path);
  }

  const wrongMethod = await probe(`/probe?id=${VALID_ID}`, { method: "POST" });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET");
  assert.equal(wrongMethod.headers.get("access-control-allow-origin"), "*");
}
