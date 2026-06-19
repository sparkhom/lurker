// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { IgnoreRuleInput } from './ignoredMasks.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-ignored-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let mod: typeof import('./ignoredMasks.js');
let user: ReturnType<typeof import('./users.js').createUser>;
let net1: ReturnType<typeof import('./networks.js').createNetwork>;
let net2: ReturnType<typeof import('./networks.js').createNetwork>;

function rule(overrides: Partial<IgnoreRuleInput> = {}): IgnoreRuleInput {
  return {
    mask: 'bozo',
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
  ({ createUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  mod = await import('./ignoredMasks.js');
  user = createUser('ig-alice');
  net1 = createNetwork(user.id, { name: 'libera', host: 'h', port: 6697, tls: true, nick: 'a' });
  net2 = createNetwork(user.id, { name: 'oftc', host: 'h2', port: 6697, tls: true, nick: 'a' });
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('addRule / listRules', () => {
  it('round-trips every field, parsing levels/channels CSV back to arrays', () => {
    const { id, created } = mod.addRule({
      userId: user.id,
      networkId: net1!.id,
      rule: rule({
        mask: null,
        channels: ['#chan', '#other'],
        pattern: '(word1|word2)',
        patternKind: 'regex',
        levels: ['PUBLIC', 'NOHIGHLIGHT'],
        isExcept: true,
        expiresAt: '2099-01-01T00:00:00.000Z',
      }),
    });
    expect(created).toBe(true);
    const list = mod.listRules({ userId: user.id, networkId: net1!.id });
    const got = list.find((r) => r.id === id)!;
    expect(got).toMatchObject({
      mask: null,
      channels: ['#chan', '#other'],
      pattern: '(word1|word2)',
      patternKind: 'regex',
      levels: ['PUBLIC', 'NOHIGHLIGHT'],
      isExcept: true,
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
  });

  it('dedupes an identical rule (returns the existing id, created:false)', () => {
    const first = mod.addRule({
      userId: user.id,
      networkId: net2!.id,
      rule: rule({ mask: 'dup' }),
    });
    expect(first.created).toBe(true);
    const second = mod.addRule({
      userId: user.id,
      networkId: net2!.id,
      rule: rule({ mask: 'dup' }),
    });
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
  });

  it('lets the same mask coexist with different levels (no UNIQUE constraint)', () => {
    const a = mod.addRule({
      userId: user.id,
      networkId: net2!.id,
      rule: rule({ mask: 'coex', levels: ['JOINS'] }),
    });
    const b = mod.addRule({
      userId: user.id,
      networkId: net2!.id,
      rule: rule({ mask: 'coex', levels: ['NOHIGHLIGHT'] }),
    });
    expect(a.created && b.created).toBe(true);
    expect(a.id).not.toBe(b.id);
    const coex = mod
      .listRules({ userId: user.id, networkId: net2!.id })
      .filter((r) => r.mask === 'coex');
    expect(coex).toHaveLength(2);
  });
});

describe('removeRuleById / removeRuleByMask', () => {
  it('removes a single rule by id', () => {
    const { id } = mod.addRule({
      userId: user.id,
      networkId: net1!.id,
      rule: rule({ mask: 'byid' }),
    });
    expect(mod.removeRuleById({ userId: user.id, networkId: net1!.id, id })).toBe(true);
    expect(mod.removeRuleById({ userId: user.id, networkId: net1!.id, id })).toBe(false);
  });

  it('removes every rule matching a mask (case-insensitive, possibly multiple)', () => {
    mod.addRule({
      userId: user.id,
      networkId: net1!.id,
      rule: rule({ mask: 'multi', levels: ['JOINS'] }),
    });
    mod.addRule({
      userId: user.id,
      networkId: net1!.id,
      rule: rule({ mask: 'multi', levels: ['PARTS'] }),
    });
    const removed = mod.removeRuleByMask({ userId: user.id, networkId: net1!.id, mask: 'MULTI' });
    expect(removed).toBe(2);
  });
});

describe('listAllRulesForUser', () => {
  it('groups rules across networks with networkId attached', () => {
    const u = createUser('ig-bob');
    const n1 = createNetwork(u.id, { name: 'a', host: 'h', port: 6697, tls: true, nick: 'b' })!;
    const n2 = createNetwork(u.id, { name: 'b', host: 'h2', port: 6697, tls: true, nick: 'b' })!;
    mod.addRule({ userId: u.id, networkId: n1.id, rule: rule({ mask: '*!*@spam.example' }) });
    mod.addRule({ userId: u.id, networkId: n2.id, rule: rule({ mask: 'trolla' }) });
    const all = mod.listAllRulesForUser(u.id);
    expect(all.map((r) => r.mask).toSorted()).toEqual(['*!*@spam.example', 'trolla']);
    expect(new Set(all.map((r) => r.networkId))).toEqual(new Set([n1.id, n2.id]));
  });
});

describe('sweepExpired', () => {
  it('deletes lapsed rules and reports the affected (user, network) pairs', () => {
    const u = createUser('ig-carol');
    const n = createNetwork(u.id, { name: 'a', host: 'h', port: 6697, tls: true, nick: 'c' })!;
    mod.addRule({
      userId: u.id,
      networkId: n.id,
      rule: rule({ mask: 'gone', expiresAt: '2000-01-01T00:00:00.000Z' }),
    });
    mod.addRule({ userId: u.id, networkId: n.id, rule: rule({ mask: 'stays' }) });
    const affected = mod.sweepExpired();
    expect(affected).toContainEqual({ userId: u.id, networkId: n.id });
    const remaining = mod.listRules({ userId: u.id, networkId: n.id }).map((r) => r.mask);
    expect(remaining).toEqual(['stays']);
  });
});
