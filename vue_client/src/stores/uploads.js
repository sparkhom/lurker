// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import { defineStore } from 'pinia';
import { api, apiMultipart } from '../api.js';

// "Insert URL into MessageInput" needs to reach across the component tree.
// A tiny event bus pattern (Set of callbacks) keeps the modal independent of
// the input component — MessageInput subscribes on mount, unsubs on unmount.
const insertListeners = new Set();
export function onInsertUrl(cb) {
  insertListeners.add(cb);
  return () => insertListeners.delete(cb);
}
function emitInsert(url) {
  for (const cb of insertListeners) {
    try { cb(url); } catch (_) { /* listener errors are not our problem */ }
  }
}

const FAILURE_VISIBLE_MS = 10_000;

export const useUploadsStore = defineStore('uploads', {
  state: () => ({
    // Active upload — drives the status-bar "Uploading: NN%" segment.
    current: null,         // { progress: 0-100, filename: string|null }
    failedAt: null,        // epoch ms; status-bar renders "Upload failed" until cleared
    failedMessage: '',

    recent: [],            // paginated history rows
    cursor: null,          // smallest id seen, used as `before=` for the next page
    hasMore: true,
    loaded: false,
    loading: false,
    listError: '',
  }),
  actions: {
    async upload(file, filename = null) {
      if (this.current) return; // Single concurrent upload — keeps the status bar coherent.
      const fd = new FormData();
      fd.append('image', file, filename || file.name || 'upload');
      this.current = { progress: 0, filename: filename || file.name || null };
      this.failedAt = null;
      this.failedMessage = '';
      try {
        const result = await apiMultipart('/api/uploads', fd, {
          onProgress: (pct) => {
            if (this.current) this.current.progress = pct;
          },
        });
        emitInsert(result.url);
        // Prepend the new row optimistically without a refetch. The list shape
        // matches the server's GET response (sans `thumbnail_url`, which the
        // server only advertises when a thumbnail blob actually exists — same
        // gate we apply here based on the file's mime).
        if (this.loaded) {
          const isImage = typeof file.type === 'string' && file.type.startsWith('image/');
          this.recent.unshift({
            id: result.id,
            provider: undefined, // server-only field; recent-uploads modal will re-fetch if it cares
            url: result.url,
            filename,
            mime: file.type || null,
            ...(isImage ? { thumbnail_url: `/api/uploads/${result.id}/thumb` } : {}),
          });
        }
        return result;
      } catch (err) {
        this.failedAt = Date.now();
        this.failedMessage = err.message || 'upload failed';
        setTimeout(() => {
          if (this.failedAt && Date.now() - this.failedAt >= FAILURE_VISIBLE_MS - 50) {
            this.failedAt = null;
            this.failedMessage = '';
          }
        }, FAILURE_VISIBLE_MS);
        throw err;
      } finally {
        this.current = null;
      }
    },

    async uploadText(content, filename = 'message.txt') {
      // Long-message → .txt upload. Wrap the text in a Blob so it can ride
      // the same multipart endpoint as image uploads; the server branches on
      // text/plain and skips the sharp pipeline.
      const blob = new Blob([content], { type: 'text/plain' });
      return this.upload(blob, filename);
    },

    async loadRecent() {
      if (this.loading) return;
      this.loading = true;
      this.listError = '';
      try {
        const { items } = await api('/api/uploads?limit=50');
        this.recent = items || [];
        this.cursor = this.recent.length ? this.recent[this.recent.length - 1].id : null;
        this.hasMore = this.recent.length === 50;
        this.loaded = true;
      } catch (e) {
        this.listError = e.message || 'failed to load uploads';
        throw e;
      } finally {
        this.loading = false;
      }
    },

    async loadMore() {
      if (this.loading || !this.hasMore || this.cursor == null) return;
      this.loading = true;
      try {
        const { items } = await api(`/api/uploads?before=${this.cursor}&limit=50`);
        this.recent.push(...(items || []));
        if (items && items.length) {
          this.cursor = items[items.length - 1].id;
          this.hasMore = items.length === 50;
        } else {
          this.hasMore = false;
        }
      } catch (e) {
        this.listError = e.message || 'failed to load more';
      } finally {
        this.loading = false;
      }
    },

    async remove(id) {
      await api(`/api/uploads/${id}`, { method: 'DELETE' });
      this.recent = this.recent.filter((u) => u.id !== id);
    },

    requestInsert(url) {
      emitInsert(url);
    },
  },
});
