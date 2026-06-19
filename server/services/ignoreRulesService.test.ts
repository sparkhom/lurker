// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { IgnoreRuleInput } from '../db/ignoredMasks.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-igsvc-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('../db/users.js').createUser;
let createNetwork: typeof import('../db/networks.js').createNetwork;
let svc: typeof import('./ignoreRulesService.js').default;
let user: ReturnType<typeof import('../db/users.js').createUser>;
let net: ReturnType<typeof import('../db/networks.js').createNetwork>;

function base(overrides: Partial<IgnoreRuleInput> = {}): IgnoreRuleInput {
  return {
    mask: 'bob',
    channels: null,
    pattern: null,
    patternKind: 'substr',
    levels: ['ALL'],
    isExcept: false,
    expiresAt: null,
    ...overrides,
  };
}

beforeAll(async () => {
  ({ createUser } = await import('../db/users.js'));
  ({ createNetwork } = await import('../db/networks.js'));
  svc = (await import('./ignoreRulesService.js')).default;
  user = createUser('igsvc-alice');
  net = createNetwork(user.id, { name: 'libera', host: 'h', port: 6697, tls: true, nick: 'a' })!;
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('ignoreRulesService.add validation', () => {
  it('rejects an unparseable expiry (untrusted WS payload hardening)', () => {
    expect(svc.add(user.id, net!.id, base({ expiresAt: 'not-a-date' }))).toMatchObject({
      ok: false,
    });
  });

  it('canonicalizes a valid expiry to ISO before storing', () => {
    const r = svc.add(user.id, net!.id, base({ mask: 'bobby', expiresAt: '2099-01-01T00:00:00Z' }));
    expect(r.ok).toBe(true);
    const stored = svc.list(user.id, net!.id).find((x) => x.mask === 'bobby');
    expect(stored?.expiresAt).toBe('2099-01-01T00:00:00.000Z');
  });

  it('rejects an invalid regex pattern', () => {
    expect(svc.add(user.id, net!.id, base({ pattern: '(', patternKind: 'regex' }))).toMatchObject({
      ok: false,
    });
  });

  it('rejects a rule with no valid levels', () => {
    expect(svc.add(user.id, net!.id, base({ levels: ['bogus'] }))).toMatchObject({ ok: false });
  });
});
