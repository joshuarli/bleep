import { handleProbe, PROBE_PATH } from "../src/probe/handler.ts";

type CloudflareRequest = Request & { cf?: { colo?: string } };

export default {
  fetch(request: CloudflareRequest): Response {
    if (new URL(request.url).pathname !== PROBE_PATH) {
      return new Response("not found", { status: 404 });
    }
    return handleProbe(request, {
      provider: "cloudflare",
      runtime: "workers",
      location: request.cf?.colo ?? null,
      locationKind: "colo",
    });
  },
};
