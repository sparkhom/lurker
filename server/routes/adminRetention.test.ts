// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Admin control for the chat-history retention window (server/routes/adminRetention.ts).
// Same split as adminNetworks.test.ts: this covers the policy read/write and its
// validation; the sweeper itself is covered by messageRetentionSweeper.test.ts.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';
import type { User } from '../db/users.js';

const ctx = setupTestDb('routes-admin-retention');

let app: Express;
let adminAgent: LurkerTestAgent;
let userAgent: LurkerTestAgent;
let setMessageRetentionDays: typeof import('../db/instanceSettings.js').setMessageRetentionDays;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const router = (await import('./admin.js')).default;
  ({ setMessageRetentionDays } = await import('../db/instanceSettings.js'));

  const admin: User = createUser('adminret-root', { role: 'admin' });
  const plainUser: User = createUser('adminret-nobody');

  app = createTestApp({ '/api/admin': router });
  adminAgent = await createAuthedAgent(app, admin.id);
  userAgent = await createAuthedAgent(app, plainUser.id);
});

afterAll(() => ctx.cleanup());

beforeEach(() => {
  setMessageRetentionDays(null);
});

describe('auth', () => {
  it('refuses a non-admin', async () => {
    expect((await userAgent.get('/api/admin/retention')).status).toBe(403);
    expect((await userAgent.put('/api/admin/retention').send({ retentionDays: 30 })).status).toBe(
      403,
    );
  });
});

describe('GET /api/admin/retention', () => {
  it('defaults to null (keep forever)', async () => {
    const res = await adminAgent.get('/api/admin/retention');
    expect(res.status).toBe(200);
    expect(res.body.retentionDays).toBeNull();
  });
});

describe('PUT /api/admin/retention', () => {
  it('sets a retention window', async () => {
    const res = await adminAgent.put('/api/admin/retention').send({ retentionDays: 30 });
    expect(res.status).toBe(200);
    expect(res.body.retentionDays).toBe(30);
    expect((await adminAgent.get('/api/admin/retention')).body.retentionDays).toBe(30);
  });

  it('clears the window back to forever with null', async () => {
    await adminAgent.put('/api/admin/retention').send({ retentionDays: 30 });
    const res = await adminAgent.put('/api/admin/retention').send({ retentionDays: null });
    expect(res.status).toBe(200);
    expect(res.body.retentionDays).toBeNull();
  });

  it('rejects a non-positive or non-integer value', async () => {
    expect((await adminAgent.put('/api/admin/retention').send({ retentionDays: 0 })).status).toBe(
      400,
    );
    expect(
      (await adminAgent.put('/api/admin/retention').send({ retentionDays: -5 })).status,
    ).toBe(400);
    expect(
      (await adminAgent.put('/api/admin/retention').send({ retentionDays: 1.5 })).status,
    ).toBe(400);
    expect(
      (await adminAgent.put('/api/admin/retention').send({ retentionDays: 'forever' })).status,
    ).toBe(400);
  });
});
