import type { Clock, ProbeFetch, Timers } from "../../src/measure/types.ts";

export class FakeTime implements Clock, Timers {
  current = 0;
  private nextHandle = 1;
  private pending = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, delay: number): number {
    const handle = this.nextHandle++;
    this.pending.set(handle, { at: this.current + Math.max(0, delay), callback });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  get timerCount(): number {
    return this.pending.size;
  }

  advance(ms: number): void {
    const end = this.current + ms;
    for (;;) {
      let due: [number, { at: number; callback: () => void }] | undefined;
      for (const entry of this.pending) {
        if (entry[1].at <= end && (due === undefined || entry[1].at < due[1].at)) due = entry;
      }
      if (due === undefined) break;
      this.pending.delete(due[0]);
      this.current = Math.max(this.current, due[1].at);
      due[1].callback();
    }
    this.current = end;
  }

  stall(ms: number): void {
    this.current += ms;
  }
}

export type FakeResponseInit = {
  status?: number;
  body?: string;
  type?: ResponseType;
  headers?: Record<string, string>;
};

export function fakeResponse(init: FakeResponseInit): Response {
  const response = new Response(init.body ?? "", {
    status: init.status ?? 200,
    headers: init.headers ?? {},
  });
  Object.defineProperty(response, "type", { value: init.type ?? "cors" });
  return response;
}

export function probeOkResponse(id: string, provider: string, extra: Record<string, string> = {}): Response {
  return fakeResponse({
    body: `{"v":1,"id":"${id}"}`,
    headers: { "x-blip-provider": provider, "x-blip-revision": "rev", ...extra },
  });
}

export function hangingFetch(): ProbeFetch {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
        once: true,
      });
    });
}

export const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
