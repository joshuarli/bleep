import { defineConfig } from "cf/config";
import * as entrypoint from "./worker/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "blip-monitor",
    compatibilityDate: "2026-11-23",
    entrypoint,
    assets: { runWorkerFirst: ["/probe"] },
  },
});
