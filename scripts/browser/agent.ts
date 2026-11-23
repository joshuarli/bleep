import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

type AgentReply = { success: boolean; data: Record<string, unknown> | null; error: string | null };

export class BrowserSession {
  readonly name: string;
  readonly downloads: string;

  constructor(name: string, downloads: string) {
    this.name = name;
    this.downloads = downloads;
  }

  async command(...args: string[]): Promise<Record<string, unknown>> {
    let stdout: string;
    try {
      ({ stdout } = await run("agent-browser", ["--session", this.name, "--download-path", this.downloads, "--json", ...args], {
        maxBuffer: 64 * 1024 * 1024,
      }));
    } catch (error) {
      const out = (error as { stdout?: string }).stdout ?? "";
      const reply = out.trim() ? (JSON.parse(out) as AgentReply) : null;
      throw new Error(`agent-browser ${args[0]} failed: ${reply?.error ?? String(error)}`);
    }
    const reply = JSON.parse(stdout) as AgentReply;
    if (!reply.success) throw new Error(`agent-browser ${args[0]} failed: ${reply.error}`);
    return reply.data ?? {};
  }

  async open(url: string): Promise<void> {
    await this.command("open", url);
  }

  async eval<T>(script: string): Promise<T> {
    const data = await this.command("eval", script);
    return data.result as T;
  }

  async viewport(width: number, height: number): Promise<void> {
    await this.command("set", "viewport", String(width), String(height));
  }

  async screenshot(path: string, fullPage = true): Promise<void> {
    await this.command("screenshot", ...(fullPage ? ["--full"] : []), path);
  }

  async close(): Promise<void> {
    await run("agent-browser", ["--session", this.name, "close"]).catch(() => undefined);
  }
}
