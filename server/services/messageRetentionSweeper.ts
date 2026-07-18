// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Periodic prune of chat history past the operator-configured retention window
// (instance setting messages.retention_days, db/instanceSettings.ts). Unset
// (null) means keep forever — the default, so an upgrade never silently starts
// deleting a self-hoster's existing history. Modelled on ignoreSweeper.ts.

import { deleteOlderThan } from '../db/messages.js';
import { getMessageRetentionDays } from '../db/instanceSettings.js';

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;

/** Delete messages older than the configured retention window. No-op (and
 *  returns 0) when retention is unset. Returns the number of rows deleted. */
export function sweepExpiredMessages(): number {
  const days = getMessageRetentionDays();
  if (days == null) return 0;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  try {
    return deleteOlderThan(cutoff);
  } catch (e) {
    console.warn('[messages] retention sweep failed:', (e as Error)?.message || e);
    return 0;
  }
}

export function startMessageRetentionSweeper(): void {
  if (timer) return;
  timer = setInterval(sweepExpiredMessages, SWEEP_INTERVAL_MS);
  timer.unref();
}

export function stopMessageRetentionSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
