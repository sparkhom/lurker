// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';

// Mirror of the server's per-user system-console ring. Seeded via the
// `system-log-snapshot` payload on each WS (re)connect; appended via live
// `system-log` events.
const MAX_LINES = 1000;

export interface SystemLogLine {
  id: number;
  type: string;
  body: string;
  createdAt: string;
  [key: string]: unknown;
}

export const useSystemLogStore = defineStore('systemLog', {
  state: () => ({
    lines: [] as SystemLogLine[],
    // Highest id we've already merged. Lets a redundant re-snapshot land
    // without re-pushing lines that are already in the buffer — the server
    // re-ships the snapshot on every visibility-return resync.
    maxId: 0,
  }),
  actions: {
    applySnapshot(lines: SystemLogLine[]) {
      if (!Array.isArray(lines)) return;
      if (lines.length === 0 && this.lines.length === 0) return;
      // The snapshot can contain lines older than the current head (initial
      // connect) AND lines newer than the current head (visibility-return
      // resync after the ring grew on the server). Merge by id with the
      // existing lines, dedupe, and sort. Cheaper than trying to detect
      // which direction the gap is.
      const byId = new Map<number, SystemLogLine>();
      for (const line of this.lines) byId.set(line.id, line);
      for (const line of lines) {
        if (line && typeof line.id === 'number') byId.set(line.id, line);
      }
      const merged = Array.from(byId.values()).toSorted((a, b) => a.id - b.id);
      this.lines = merged;
      this.maxId = merged.length ? merged[merged.length - 1].id : 0;
      this.trim();
    },
    applyLine(line: SystemLogLine) {
      if (!line || typeof line.id !== 'number') return;
      if (line.id <= this.maxId) return;
      this.lines.push(line);
      this.maxId = line.id;
      this.trim();
    },
    trim() {
      if (this.lines.length > MAX_LINES) {
        this.lines.splice(0, this.lines.length - MAX_LINES);
      }
    },
    clear() {
      this.lines = [];
      this.maxId = 0;
    },
  },
});
