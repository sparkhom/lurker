// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import { EventEmitter } from 'events';

// Per-user system-console log. A live tail of server lifecycle events
// (network connect, channel join, presence batches, etc.) that the client
// surfaces in a virtual buffer reached via the "lurker" sidebar header.
//
// Ephemeral by design — the messages table would bloat with debug rows that
// nobody reads outside an active troubleshooting session. The ring survives
// in memory until process restart. Global lines (userId == null) are visible
// to every connected user so they can see "server starting up" on the
// session they opened right after a deploy.

const MAX_GLOBAL = 200;
const MAX_PER_USER = 500;

let nextId = 1;

const global = [];
const perUser = new Map();

const emitter = new EventEmitter();

function append(ring, max, line) {
  ring.push(line);
  if (ring.length > max) ring.splice(0, ring.length - max);
}

function buildLine({ level, scope, text, userId, fields }) {
  return {
    id: nextId++,
    ts: new Date().toISOString(),
    level: level || 'info',
    scope: scope || 'lurker',
    text: String(text == null ? '' : text),
    userId: userId == null ? null : Number(userId),
    fields: fields && typeof fields === 'object' ? fields : null,
  };
}

export function log({ level, scope, text, userId = null, fields } = {}) {
  const line = buildLine({ level, scope, text, userId, fields });
  if (line.userId == null) {
    append(global, MAX_GLOBAL, line);
  } else {
    let ring = perUser.get(line.userId);
    if (!ring) { ring = []; perUser.set(line.userId, ring); }
    append(ring, MAX_PER_USER, line);
  }
  emitter.emit('line', line);
  return line;
}

// Returns the global lines + this user's own lines, merged by id (id is
// monotonic per-process, so id order == time order — and no two appends
// can collide on a tie).
export function getRecent(userId) {
  const ring = perUser.get(Number(userId)) || [];
  if (ring.length === 0) return global.slice();
  if (global.length === 0) return ring.slice();
  const out = new Array(ring.length + global.length);
  let i = 0, j = 0, k = 0;
  while (i < global.length && j < ring.length) {
    out[k++] = global[i].id < ring[j].id ? global[i++] : ring[j++];
  }
  while (i < global.length) out[k++] = global[i++];
  while (j < ring.length) out[k++] = ring[j++];
  return out;
}

// Forget everything we've cached for this user. Called when a user is
// deleted so their personal ring doesn't keep a stale account's history
// alive across re-signups.
export function dropUser(userId) {
  perUser.delete(Number(userId));
}

export function on(event, handler) { emitter.on(event, handler); }
export function off(event, handler) { emitter.off(event, handler); }

export default { log, getRecent, dropUser, on, off };
