// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Node edition + orchestrator config before importing the module under test.
process.env.LURKER_EDITION = 'node';
process.env.LURKER_NODE_SECRET = 'fleet-secret';
process.env.LURKER_ORCHESTRATOR_URL = 'http://orchestrator:8020';
process.env.LURKER_NODE_NAME = 'cell-test';

import { setupTestDb } from '../test-utils/testApp.js';

const ctx = setupTestDb('moderation-report');

type FetchMock = (...args: unknown[]) => Promise<{ ok: boolean }>;

let mod: typeof import('./moderationReport.js');
let insertUpload: typeof import('../db/uploadHistory.js').insertUpload;
let listUnsyncedUploads: typeof import('../db/uploadHistory.js').listUnsyncedUploads;
let userId: number;

function seedUpload(uploadId: string): number {
  return insertUpload(userId, {
    provider: 'hoarder',
    url: `https://cdn.test/${uploadId}.jpg`,
    filename: `${uploadId}.png`,
    mime: 'image/jpeg',
    byte_size: 1000,
    width: 100,
    height: 100,
    thumbnail: null,
    thumbnail_url: `https://cdn.test/thumbs/${uploadId}.jpg`,
  });
}

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  mod = await import('./moderationReport.js');
  ({ insertUpload, listUnsyncedUploads } = await import('../db/uploadHistory.js'));
  userId = createUser('mod-reporter-alice').id;
});

afterAll(() => {
  ctx.cleanup();
  vi.unstubAllGlobals();
  delete process.env.LURKER_EDITION;
});

describe('reportUpload', () => {
  it('posts to /_cp/moderation/uploads with the bearer + cell-stamped body', async () => {
    const fetchMock = vi.fn<FetchMock>().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const ok = await mod.reportUpload({
      cell_upload_id: 42,
      cell_user_id: userId,
      url: 'https://cdn.test/x.jpg',
      thumb_url: 'https://cdn.test/thumbs/x.jpg',
      mime: 'image/jpeg',
      byte_size: 1234,
      width: 800,
      height: 600,
    });
    expect(ok).toBe(true);
    const [url, opts] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('http://orchestrator:8020/_cp/moderation/uploads');
    expect(opts.headers.Authorization).toBe('Bearer fleet-secret');
    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({ cell: 'cell-test', cell_upload_id: 42, cell_user_id: userId });
  });

  it('returns false (never throws) when the control plane is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn<FetchMock>().mockRejectedValue(new Error('ECONNREFUSED')));
    const ok = await mod.reportUpload({
      cell_upload_id: 43,
      cell_user_id: userId,
      url: 'https://cdn.test/y.jpg',
      thumb_url: null,
      mime: 'image/jpeg',
      byte_size: 1,
      width: null,
      height: null,
    });
    expect(ok).toBe(false);
  });
});

describe('flushUnsyncedUploads', () => {
  it('drains unsynced rows and marks them synced when the CP accepts them', async () => {
    const id1 = seedUpload('flush-a');
    const id2 = seedUpload('flush-b');
    expect(listUnsyncedUploads(500).some((r) => r.id === id1)).toBe(true);

    vi.stubGlobal('fetch', vi.fn<FetchMock>().mockResolvedValue({ ok: true }));
    const synced = await mod.flushUnsyncedUploads();
    expect(synced).toBeGreaterThanOrEqual(2);

    const stillUnsynced = listUnsyncedUploads(500).map((r) => r.id);
    expect(stillUnsynced).not.toContain(id1);
    expect(stillUnsynced).not.toContain(id2);
  });

  it('leaves rows unsynced when the CP is down (retried next tick)', async () => {
    const id = seedUpload('flush-down');
    vi.stubGlobal('fetch', vi.fn<FetchMock>().mockResolvedValue({ ok: false }));
    await mod.flushUnsyncedUploads();
    expect(listUnsyncedUploads(500).some((r) => r.id === id)).toBe(true);
  });
});

describe('reportUploadSoon', () => {
  it('reports inline (fire-and-forget) and marks the row synced on success', async () => {
    const id = seedUpload('soon');
    vi.stubGlobal('fetch', vi.fn<FetchMock>().mockResolvedValue({ ok: true }));
    mod.reportUploadSoon({
      cell_upload_id: id,
      cell_user_id: userId,
      url: 'https://cdn.test/soon.jpg',
      thumb_url: null,
      mime: 'image/jpeg',
      byte_size: 1,
      width: null,
      height: null,
    });
    // Fire-and-forget — let the resolved-promise microtask settle.
    await new Promise((r) => setTimeout(r, 20));
    expect(listUnsyncedUploads(500).some((r) => r.id === id)).toBe(false);
  });
});
