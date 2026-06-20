// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { EventEmitter } from 'events';
import * as systemMessages from '../db/systemMessages.js';

// Server side of the system buffer (the "Lurker" sidebar header, issue #355). A
// live tail of server lifecycle events (network connect, channel join, presence
// batches, etc.) plus any global notices, surfaced in the client's system
// buffer.
//
// Durable: lines persist in the system_messages table (db/systemMessages.ts), so
// they survive a process restart and a client that connects *after* a global
// notice still sees it. Global lines (userId == null) are visible to every
// connected user; per-user lines are private to that account. This module layers
// the in-process EventEmitter fan-out (wsHub subscribes) on top of the store.

export interface LogLine {
  id: number;
  ts: string;
  level: string;
  scope: string;
  // Origin of the line — 'server' (lifecycle), 'client' (echoed command output),
  // and, for the broadcast follow-up, 'admin' / 'control-plane'. Lets the client
  // style/route by source without sniffing the text.
  source: string;
  text: string;
  userId: number | null;
  fields: Record<string, unknown> | null;
}

export interface LogParams {
  level?: string;
  scope?: string;
  source?: string;
  text?: unknown;
  userId?: number | null;
  fields?: Record<string, unknown> | null;
}

const emitter = new EventEmitter();

export function log({
  level,
  scope,
  source,
  text,
  userId = null,
  fields,
}: LogParams = {}): LogLine {
  const line = systemMessages.insert({
    userId: userId == null ? null : Number(userId),
    ts: new Date().toISOString(),
    level: level || 'info',
    scope: scope || 'lurker',
    source: source || 'server',
    text: String(text == null ? '' : text),
    // Defensive: a non-object fields payload is dropped to null rather than
    // persisted as junk JSON.
    fields: fields && typeof fields === 'object' ? fields : null,
  });
  emitter.emit('line', line);
  return line;
}

// The global lines + this user's own lines, oldest-first (id order == time
// order). Shipped as the system-buffer snapshot on each WS (re)connect.
export function getRecent(userId: number): LogLine[] {
  return systemMessages.recent(userId);
}

// Forget a user's personal lines. Called when an account is deleted so a
// recycled id never inherits stale history (the users FK also cascades).
export function dropUser(userId: number): void {
  systemMessages.dropUser(userId);
}

export function on(event: string, handler: (...args: unknown[]) => void): void {
  emitter.on(event, handler);
}
export function off(event: string, handler: (...args: unknown[]) => void): void {
  emitter.off(event, handler);
}

export default { log, getRecent, dropUser, on, off };
