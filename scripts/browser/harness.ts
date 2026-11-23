import type { Provider } from "../../src/config/targets.ts";
import { browserProbeDeps } from "../../src/measure/browser-deps.ts";
import { newProbeId, sendProbe } from "../../src/measure/probe-client.ts";
import type { ProbeResult } from "../../src/measure/types.ts";

const deps = browserProbeDeps();

declare global {
  interface Window {
    blipHarness: { probe(provider: Provider, origin: string, timeoutMs: number): Promise<ProbeResult> };
  }
}

window.blipHarness = {
  probe(provider, origin, timeoutMs) {
    const id = newProbeId((bytes) => crypto.getRandomValues(bytes));
    return sendProbe(deps, { provider, origin }, id, new AbortController().signal, timeoutMs);
  },
};
