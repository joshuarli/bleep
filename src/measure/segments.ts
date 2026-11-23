import { PROVIDERS, type Provider } from "../config/targets.ts";
import { recordEnd, recordStart, type MeasurementRecord, type Milliseconds, type RunInfo } from "./types.ts";

export type PhaseBoundary = { at: Milliseconds; label: string };

export const SEGMENT_REASONS = ["run", "resume", "location", "revision", "phase"] as const;
export type SegmentReason = (typeof SEGMENT_REASONS)[number];

export type Segment = {
  index: number;
  runId: string;
  sessionSegment: number;
  fromAt: Milliseconds;
  toAt: Milliseconds;
  startReasons: SegmentReason[];
  phase: string | null;
  locations: Record<Provider, string | null>;
  revisions: Record<Provider, string | null>;
  uiRevision: string;
  revisionMismatch: boolean;
};

export type Segmentation = {
  segments: Segment[];
  segmentOf: Map<MeasurementRecord, number>;
};

const emptyByProvider = (): Record<Provider, string | null> => ({ cloudflare: null, vercel: null });

function phaseAt(phases: readonly PhaseBoundary[], at: Milliseconds): PhaseBoundary | null {
  let current: PhaseBoundary | null = null;
  for (const phase of phases) {
    if (phase.at <= at) current = phase;
    else break;
  }
  return current;
}

export function buildSegments(
  records: Iterable<MeasurementRecord>,
  runs: ReadonlyMap<string, RunInfo>,
  phases: readonly PhaseBoundary[],
): Segmentation {
  const sortedPhases = [...phases].sort((a, b) => a.at - b.at);
  const sorted = [...records].sort((a, b) => recordStart(a) - recordStart(b));
  const segments: Segment[] = [];
  const segmentOf = new Map<MeasurementRecord, number>();
  let current: Segment | null = null;
  let currentPhase: PhaseBoundary | null = null;

  const open = (record: MeasurementRecord, reasons: SegmentReason[], from: Segment | null): Segment => {
    const run = runs.get(record.runId);
    const segment: Segment = {
      index: segments.length,
      runId: record.runId,
      sessionSegment: record.segment,
      fromAt: recordStart(record),
      toAt: recordEnd(record),
      startReasons: reasons,
      phase: currentPhase?.label ?? null,
      locations: from === null ? emptyByProvider() : { ...from.locations },
      revisions: from === null ? emptyByProvider() : { ...from.revisions },
      uiRevision: run?.uiRevision ?? "unknown",
      revisionMismatch: false,
    };
    segments.push(segment);
    return segment;
  };

  for (const record of sorted) {
    const at = recordStart(record);
    const phase = phaseAt(sortedPhases, at);
    const reasons: SegmentReason[] = [];
    if (current === null || current.runId !== record.runId) reasons.push("run");
    else if (current.sessionSegment !== record.segment) reasons.push("resume");
    if (current !== null && phase !== currentPhase) reasons.push("phase");
    currentPhase = phase;

    const meta = record.kind === "attempt" ? record.result.response : null;
    const carry = reasons.includes("run") ? null : current;
    if (current !== null && carry !== null && meta !== null) {
      if (meta.location !== null && carry.locations[record.provider] !== null && meta.location !== carry.locations[record.provider]) {
        reasons.push("location");
      }
      if (meta.revision !== null && carry.revisions[record.provider] !== null && meta.revision !== carry.revisions[record.provider]) {
        reasons.push("revision");
      }
    }
    if (current === null || reasons.length > 0) current = open(record, reasons, carry);

    if (meta !== null) {
      if (meta.location !== null) current.locations[record.provider] = meta.location;
      if (meta.revision !== null) current.revisions[record.provider] = meta.revision;
    }
    current.revisionMismatch = PROVIDERS.some(
      (provider) => current !== null && current.revisions[provider] !== null && current.revisions[provider] !== current.uiRevision,
    );
    current.toAt = Math.max(current.toAt, recordEnd(record));
    segmentOf.set(record, current.index);
  }
  return { segments, segmentOf };
}

export function segmentsOverlapping(segments: readonly Segment[], fromAt: Milliseconds, toAt: Milliseconds): Segment[] {
  return segments.filter((segment) => segment.toAt >= fromAt && segment.fromAt < toAt);
}
