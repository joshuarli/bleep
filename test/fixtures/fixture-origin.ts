import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { extname, join, normalize } from "node:path";
import type { Provider } from "../../src/config/targets.ts";
import { handleProbe } from "../../src/probe/handler.ts";

export const SIMULATED_LOCATION = "simulated";

export type Fault =
  | { kind: "ok" }
  | { kind: "delay"; ms: number }
  | { kind: "hang" }
  | { kind: "status"; status: number }
  | { kind: "wrong_id" }
  | { kind: "html" }
  | { kind: "redirect" }
  | { kind: "close" };

export type MethodCounts = { GET: number; OPTIONS: number; other: number };

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

const CORS = { "access-control-allow-origin": "*", "cache-control": "no-store" };

export class FixtureOrigin {
  readonly provider: Provider;
  readonly port: number;
  readonly staticRoot: string;
  fault: Fault = { kind: "ok" };
  revisionOverride: string | null = null;
  probeCounts: MethodCounts = { GET: 0, OPTIONS: 0, other: 0 };
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(provider: Provider, port: number, staticRoot: string) {
    this.provider = provider;
    this.port = port;
    this.staticRoot = staticRoot;
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  resetCounts(): void {
    this.probeCounts = { GET: 0, OPTIONS: 0, other: 0 };
  }

  async start(): Promise<void> {
    const server = createServer((request, response) => {
      this.route(request, response).catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, "127.0.0.1", () => resolve());
    });
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server === null) return;
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.origin);
    if (url.pathname === "/probe") return this.probe(request, response, url);
    return this.serveStatic(url.pathname, response);
  }

  private async probe(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const method = request.method ?? "GET";
    if (method === "GET" || method === "OPTIONS") this.probeCounts[method]++;
    else this.probeCounts.other++;

    const fault = this.fault;
    switch (fault.kind) {
      case "hang":
        return;
      case "close":
        request.socket.destroy();
        return;
      case "redirect":
        response.writeHead(302, { ...CORS, location: `/probe${url.search}` }).end();
        return;
      case "html":
        response.writeHead(200, { ...CORS, "content-type": "text/html" }).end("<!doctype html><p>challenge</p>");
        return;
      case "delay":
        await new Promise((resolve) => setTimeout(resolve, fault.ms));
        break;
    }

    const probeUrl = fault.kind === "wrong_id" ? new URL("/probe?id=wrongwrongwrongwrongxx", this.origin) : url;
    const answer = handleProbe(new Request(probeUrl, { method }), {
      provider: this.provider,
      runtime: this.provider === "cloudflare" ? "workers" : "node-fluid",
      location: SIMULATED_LOCATION,
      locationKind: this.provider === "cloudflare" ? "colo" : "execution-region",
    });
    const status = fault.kind === "status" ? fault.status : answer.status;
    if (this.revisionOverride !== null) answer.headers.set("x-blip-revision", this.revisionOverride);
    response.writeHead(status, Object.fromEntries(answer.headers));
    response.end(await answer.text());
  }

  private serveStatic(pathname: string, response: ServerResponse): void {
    const relative = normalize(pathname === "/" ? "/index.html" : pathname);
    const file = join(this.staticRoot, relative);
    if (!file.startsWith(this.staticRoot) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(file).pipe(response);
  }
}
