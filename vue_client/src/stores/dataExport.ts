// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';

// Mirror of the user's current/most-recent data-export job. Seeded from
// GET /api/exports/latest when the data settings pane mounts, kept live by the
// `export` WebSocket events the server fans out as the background build
// progresses. One job per user at a time, so a single slot is enough.
export interface ClientExportJob {
  id: number;
  status: 'pending' | 'running' | 'done' | 'error';
  includeMessages: boolean;
  total: number;
  processed: number;
  filename: string | null;
  byteSize: number | null;
  error: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  downloadable: boolean;
}

export const useDataExportStore = defineStore('dataExport', {
  state: () => ({
    job: null as ClientExportJob | null,
  }),
  actions: {
    apply(job: ClientExportJob | null) {
      // Ignore an out-of-order update for an older job than the one we track
      // (e.g. a late progress frame after the user kicked off a rebuild).
      if (job && this.job && job.id < this.job.id) return;
      this.job = job;
    },
    clear() {
      this.job = null;
    },
  },
});
