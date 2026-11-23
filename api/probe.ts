import { handleProbe } from "../src/probe/handler.ts";

export default {
  fetch(request: Request): Response {
    return handleProbe(request, {
      provider: "vercel",
      runtime: "node-fluid",
      location: process.env.VERCEL_REGION ?? null,
      locationKind: "execution-region",
    });
  },
};
