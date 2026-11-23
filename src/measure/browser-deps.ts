import type { ProbeClientDeps } from "./probe-client.ts";
import type { ResourceDetail } from "./types.ts";

const RESOURCE_DETAIL_CAPACITY = 256;

export type BrowserProbeDeps = ProbeClientDeps & { dispose(): void };

export function browserProbeDeps(): BrowserProbeDeps {
  const details = new Map<string, ResourceDetail>();
  const remember = (entry: PerformanceResourceTiming) => {
    if (!entry.name.includes("/probe?id=")) return;
    details.set(entry.name, { nextHopProtocol: entry.nextHopProtocol || null });
    if (details.size > RESOURCE_DETAIL_CAPACITY) {
      const oldest = details.keys().next().value;
      if (oldest !== undefined) details.delete(oldest);
    }
  };
  const observer =
    typeof PerformanceObserver === "undefined"
      ? null
      : new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) remember(entry as PerformanceResourceTiming);
          performance.clearResourceTimings();
        });
  observer?.observe({ type: "resource", buffered: false });

  return {
    clock: performance,
    timers: {
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: (handle) => window.clearTimeout(handle as number),
    },
    fetch: (url, init) => fetch(url, init),
    resourceTiming: (url) => {
      for (const entry of performance.getEntriesByName(url, "resource")) {
        remember(entry as PerformanceResourceTiming);
      }
      const detail = details.get(url) ?? null;
      details.delete(url);
      return detail;
    },
    dispose: () => observer?.disconnect(),
  };
}
