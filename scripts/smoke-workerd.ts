import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { assertProbeContract } from "../test/probe-contract.ts";

const port = 8787;
const origin = `http://127.0.0.1:${port}`;
const server = spawn("npx", ["cf", "dev", "--port", String(port), "--host", "127.0.0.1"], {
  detached: true,
  stdio: "ignore",
});

async function waitUntilServing(): Promise<void> {
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    try {
      await fetch(`${origin}/probe`);
      return;
    } catch {
      await delay(200);
    }
  }
  throw new Error(`cf dev did not serve ${origin} within 30 seconds`);
}

try {
  await waitUntilServing();
  await assertProbeContract((path, init) => fetch(`${origin}${path}`, init), "cloudflare");
  const page = await fetch(`${origin}/`);
  if (page.status !== 200) throw new Error(`static asset status ${page.status}`);
  console.log("workerd probe contract passed");
} finally {
  if (server.pid !== undefined) process.kill(-server.pid, "SIGTERM");
}
