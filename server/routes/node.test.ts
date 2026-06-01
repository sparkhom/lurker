// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Edition + node secret are read at request time; set them before importing the
// router. vitest runs each test file in its own process, so this is scoped here.
process.env.LURKER_EDITION = 'node';
process.env.LURKER_NODE_SECRET = 'test-node-secret';

import type { Express } from 'express';
import { setupTestDb, createTestApp, createAnonAgent } from '../test-utils/testApp.js';

const ctx = setupTestDb('routes-node');
const AUTH = 'Bearer test-node-secret';

let app: Express;
let findUserById: typeof import('../db/users.js').findUserById;
let createUser: typeof import('../db/users.js').createUser;

beforeAll(async () => {
  const users = await import('../db/users.js');
  findUserById = users.findUserById;
  createUser = users.createUser;
  const router = (await import('./node.js')).default;
  app = createTestApp({ '/api/node': router });
});

afterAll(() => ctx.cleanup());

describe('node control API — auth', () => {
  it('rejects requests with no bearer (401)', async () => {
    expect((await createAnonAgent(app).get('/api/node/status')).status).toBe(401);
  });

  it('rejects a wrong secret (401)', async () => {
    const res = await createAnonAgent(app)
      .get('/api/node/status')
      .set('Authorization', 'Bearer nope');
    expect(res.status).toBe(401);
  });

  it('503s when no node secret is configured', async () => {
    const saved = process.env.LURKER_NODE_SECRET;
    delete process.env.LURKER_NODE_SECRET;
    try {
      const res = await createAnonAgent(app).get('/api/node/status').set('Authorization', AUTH);
      expect(res.status).toBe(503);
    } finally {
      process.env.LURKER_NODE_SECRET = saved;
    }
  });
});

describe('node control API — status', () => {
  it('reports edition + user count with a valid secret', async () => {
    const res = await createAnonAgent(app).get('/api/node/status').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.edition).toBe('node');
    expect(typeof res.body.users.count).toBe('number');
    expect(typeof res.body.version).toBe('string');
  });
});

describe('node control API — provision', () => {
  it('creates a tenant account as role=user and returns its id', async () => {
    const res = await createAnonAgent(app)
      .post('/api/node/users')
      .set('Authorization', AUTH)
      .send({ username: 'tenant-alice' });
    expect(res.status).toBe(201);
    expect(res.body.username).toBe('tenant-alice');
    expect(typeof res.body.id).toBe('number');
    expect(findUserById(res.body.id)?.role).toBe('user');
  });

  it('never mints an admin, even if the body asks for one', async () => {
    const res = await createAnonAgent(app)
      .post('/api/node/users')
      .set('Authorization', AUTH)
      .send({ username: 'tenant-mallory', role: 'admin' });
    expect(res.status).toBe(201);
    expect(findUserById(res.body.id)?.role).toBe('user');
  });

  it('rejects a missing username (400)', async () => {
    const res = await createAnonAgent(app)
      .post('/api/node/users')
      .set('Authorization', AUTH)
      .send({});
    expect(res.status).toBe(400);
  });

  it('rejects a username with disallowed characters (400)', async () => {
    const res = await createAnonAgent(app)
      .post('/api/node/users')
      .set('Authorization', AUTH)
      .send({ username: 'no/slashes' });
    expect(res.status).toBe(400);
  });

  it('409s on a duplicate username and surfaces the existing id', async () => {
    const first = await createAnonAgent(app)
      .post('/api/node/users')
      .set('Authorization', AUTH)
      .send({ username: 'tenant-dupe' });
    expect(first.status).toBe(201);
    const second = await createAnonAgent(app)
      .post('/api/node/users')
      .set('Authorization', AUTH)
      .send({ username: 'tenant-dupe' });
    expect(second.status).toBe(409);
    expect(second.body.id).toBe(first.body.id);
  });
});

describe('node control API — deprovision', () => {
  it('deletes a tenant account', async () => {
    const created = await createAnonAgent(app)
      .post('/api/node/users')
      .set('Authorization', AUTH)
      .send({ username: 'tenant-bob' });
    const id = created.body.id;
    const del = await createAnonAgent(app)
      .delete(`/api/node/users/${id}`)
      .set('Authorization', AUTH);
    expect(del.status).toBe(200);
    expect(findUserById(id)).toBeUndefined();
  });

  it('404s on an unknown user', async () => {
    const res = await createAnonAgent(app)
      .delete('/api/node/users/999999')
      .set('Authorization', AUTH);
    expect(res.status).toBe(404);
  });

  it('refuses to delete an admin (the operator) via the node API', async () => {
    const admin = createUser('operator', { role: 'admin' });
    const res = await createAnonAgent(app)
      .delete(`/api/node/users/${admin.id}`)
      .set('Authorization', AUTH);
    expect(res.status).toBe(409);
    expect(findUserById(admin.id)).toBeDefined();
  });
});
