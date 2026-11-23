import { createServer } from "node:http";
import vercel from "../api/probe.ts";
import { ENDPOINTS_BY_TARGET } from "../src/config/endpoints.ts";

const origin = new URL(ENDPOINTS_BY_TARGET.local.vercel.origin);

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", origin);
  if (url.pathname !== "/probe") {
    response.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  const answer = vercel.fetch(new Request(url, { method: request.method ?? "GET" }));
  response.writeHead(answer.status, Object.fromEntries(answer.headers));
  response.end(await answer.text());
}).listen(Number(origin.port), origin.hostname, () => {
  console.log(`local Vercel probe adapter on ${origin.origin} (simulated: no Vercel platform, location unknown)`);
});
