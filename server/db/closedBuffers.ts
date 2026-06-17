// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';

const closeStmt = db.prepare(`
  INSERT INTO closed_buffers (user_id, network_id, target)
  VALUES (?, ?, ?)
  ON CONFLICT(user_id, network_id, target) DO UPDATE SET
    closed_at = datetime('now')
`);

const reopenStmt = db.prepare(`
  DELETE FROM closed_buffers WHERE user_id = ? AND network_id = ? AND target = ?
`);

const isClosedStmt = db.prepare(`
  SELECT 1 FROM closed_buffers WHERE user_id = ? AND network_id = ? AND target = ?
`);

const listForUserStmt = db.prepare(`
  SELECT network_id AS networkId, target FROM closed_buffers WHERE user_id = ?
`);

export function closeBuffer(userId: number, networkId: number, target: string): void {
  closeStmt.run(userId, networkId, target);
}

// Returns true if a row was actually deleted (i.e., the buffer had been closed).
export function reopenBuffer(userId: number, networkId: number, target: string): boolean {
  return reopenStmt.run(userId, networkId, target).changes > 0;
}

export function isClosed(userId: number, networkId: number, target: string): boolean {
  return !!isClosedStmt.get(userId, networkId, target);
}

// Returns Set of `${networkId}::${target}` keys for fast snapshot filtering.
// Targets are case-folded so the lookup tolerates servers handing us
// inconsistently-cased channel/nick names (#289/#319) — a DM closed as `Bob`
// still matches a `bob` history row. Callers must fold the target on lookup too
// (see isHiddenClosedBuffer in wsHub). IRC targets are case-insensitive, so
// folding can't collide two genuinely distinct buffers.
export function closedKeySetForUser(userId: number): Set<string> {
  const set = new Set<string>();
  const rows = listForUserStmt.all(userId) as Array<{ networkId: number; target: string }>;
  for (const row of rows) {
    set.add(`${row.networkId}::${row.target.toLowerCase()}`);
  }
  return set;
}
