// In-memory scan store. One operator, one in-flight scan at a time — sample
// scope. Restart drops history; that's acceptable here.

import { randomUUID } from "node:crypto";

export interface Proposal {
  nick: string;
  currentNote: string;
  proposedNote: string;
  rationale: string;
  evidence: number[];
}

// A message from the IRC backlog as returned by the Lurker MCP tool.
export interface IrcMessage {
  id: number;
  time: number;
  nick: string;
  text: string;
  type: string;
  self: boolean;
  dm: boolean;
}

// A timestamped trace event emitted by the agent loop.
export interface ScanEvent {
  type: string;
  at: number;
  [key: string]: unknown;
}

export type ScanStatus = "running" | "done" | "error";

export interface Scan {
  id: string;
  networkId: number;
  target: string;
  depth: number;
  status: ScanStatus;
  toolCallCount: number;
  proposals: Proposal[] | null;
  messages: Record<number, IrcMessage> | null; // map of messageId -> message, for evidence rendering
  events: ScanEvent[]; // ordered trace of model turns / tool calls; consumed by the UI
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

const scans = new Map<string, Scan>();

export function createScan({
  networkId,
  target,
  depth,
}: {
  networkId: number;
  target: string;
  depth: number;
}): Scan {
  const id = randomUUID();
  const scan: Scan = {
    id,
    networkId,
    target,
    depth,
    status: "running",
    toolCallCount: 0,
    proposals: null,
    messages: null,
    events: [],
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  scans.set(id, scan);
  return scan;
}

export function appendEvent(id: string, event: Omit<ScanEvent, "at">): Scan | null {
  const scan = scans.get(id);
  if (!scan) return null;
  scan.events.push({ ...event, at: Date.now() } as ScanEvent);
  return scan;
}

export function getScan(id: string): Scan | null {
  return scans.get(id) ?? null;
}

export function updateScan(id: string, patch: Partial<Scan>): Scan | null {
  const scan = scans.get(id);
  if (!scan) return null;
  Object.assign(scan, patch);
  return scan;
}

export function finishScan(
  id: string,
  { proposals, messages }: { proposals: Proposal[]; messages: Record<number, IrcMessage> },
): Scan | null {
  return updateScan(id, {
    status: "done",
    proposals,
    messages,
    finishedAt: Date.now(),
  });
}

export function errorScan(id: string, error: unknown): Scan | null {
  return updateScan(id, {
    status: "error",
    error: (error as Error)?.message ?? String(error),
    finishedAt: Date.now(),
  });
}
