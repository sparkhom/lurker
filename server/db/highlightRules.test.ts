// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-hl-rules-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let mod: typeof import('./highlightRules.js');
let db: typeof import('./index.js').default;
let user: ReturnType<typeof import('./users.js').createUser>;
let net1: ReturnType<typeof import('./networks.js').createNetwork>;
let net2: ReturnType<typeof import('./networks.js').createNetwork>;

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  mod = await import('./highlightRules.js');
  ({ default: db } = await import('./index.js'));
  user = createUser('hr-alice');
  net1 = createNetwork(user.id, {
    name: 'libera',
    host: 'h',
    port: 6697,
    tls: true,
    nick: 'alice',
  });
  net2 = createNetwork(user.id, { name: 'oftc', host: 'h2', port: 6697, tls: true, nick: 'aly' });
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('CRUD basics', () => {
  it('createRule + getRule + updateRule + deleteRule round-trip', () => {
    const r = mod.createRule(user.id, { pattern: 'review', kind: 'full' });
    expect(r).toMatchObject({ pattern: 'review', enabled: true, case_sensitive: false });
    expect(mod.getRule(r!.id, user.id)!.pattern).toBe('review');
    const updated = mod.updateRule(r!.id, user.id, { enabled: false });
    expect(updated!.enabled).toBe(false);
    mod.deleteRule(r!.id, user.id);
    expect(mod.getRule(r!.id, user.id)).toBeNull();
  });

  it("owner scoping — another user can't fetch or edit your rules", () => {
    const r = mod.createRule(user.id, { pattern: 'mine' });
    const stranger = createUser('hr-stranger');
    expect(mod.getRule(r!.id, stranger.id)).toBeNull();
    expect(mod.updateRule(r!.id, stranger.id, { enabled: false })).toBeNull();
  });

  it('round-trips a mask + channels rule (no keyword)', () => {
    const r = mod.createRule(user.id, {
      mask: 'bob!*@*',
      channels: ['#ops', '#dev'],
      kind: 'full',
    });
    const got = mod.getRule(r!.id, user.id)!;
    expect(got.pattern).toBeNull();
    expect(got.mask).toBe('bob!*@*');
    expect(got.channels).toEqual(['#ops', '#dev']);
  });
});

describe('listScopedRules — network scope', () => {
  it('returns global rules plus rules attached to the network', () => {
    const scopeUser = createUser('hr-scope');
    const nA = createNetwork(scopeUser.id, {
      name: 'a',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'n',
    });
    const nB = createNetwork(scopeUser.id, {
      name: 'b',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'n',
    });
    const globalRule = mod.createRule(scopeUser.id, { pattern: 'global' });
    const aRule = mod.createRule(scopeUser.id, { pattern: 'onlyA', networkId: nA!.id });

    const scopedA = mod.listScopedRules(scopeUser.id, nA!.id).map((r) => r.pattern);
    expect(scopedA).toContain('global');
    expect(scopedA).toContain('onlyA');

    const scopedB = mod.listScopedRules(scopeUser.id, nB!.id).map((r) => r.pattern);
    expect(scopedB).toContain('global');
    expect(scopedB).not.toContain('onlyA');

    // networkIds is reported on the scoped/listed rules
    expect(mod.getRule(globalRule!.id, scopeUser.id)!.networkIds).toEqual([]);
    expect(mod.getRule(aRule!.id, scopeUser.id)!.networkIds).toEqual([nA!.id]);
  });
});

describe('upsertAutoNickRule', () => {
  it('creates an auto rule and attaches the network (changed: true)', () => {
    const { rule, changed } = mod.upsertAutoNickRule(user.id, net1!.id, 'alice');
    expect(changed).toBe(true);
    expect(rule!.auto_managed).toBe(true);
    expect(rule!.pattern).toBe('alice');
    const links = db
      .prepare(`SELECT network_id FROM highlight_rule_networks WHERE rule_id = ?`)
      .all(rule!.id) as Array<{ network_id: number }>;
    expect(links.map((l) => l.network_id)).toEqual([net1!.id]);
  });

  it('is idempotent — re-attaching the same nick reports changed: false', () => {
    const again = mod.upsertAutoNickRule(user.id, net1!.id, 'alice');
    expect(again.changed).toBe(false);
    expect(again.rule!.pattern).toBe('alice');
  });

  it('attaches additional networks that share the same nick', () => {
    // Now set net2's nick to also be 'alice' and call upsert; the existing
    // auto rule should pick up net2.
    const { rule } = mod.upsertAutoNickRule(user.id, net2!.id, 'alice');
    const links = db
      .prepare(
        `SELECT network_id FROM highlight_rule_networks WHERE rule_id = ? ORDER BY network_id`,
      )
      .all(rule!.id) as Array<{ network_id: number }>;
    expect(links.map((l) => l.network_id).toSorted()).toEqual([net1!.id, net2!.id].toSorted());
  });

  it("switching a network's nick detaches the old auto rule and sweeps it when orphaned", () => {
    // net1's nick changes from 'alice' to 'newbie'. After this call the
    // old auto rule for 'alice' loses net1, gains nothing for 'alice', and
    // the new auto rule for 'newbie' should appear.
    mod.upsertAutoNickRule(user.id, net1!.id, 'newbie');
    const { rule: aliceRule } = mod.upsertAutoNickRule(user.id, net2!.id, 'alice'); // ensure stable
    const aliceLinks = db
      .prepare(`SELECT network_id FROM highlight_rule_networks WHERE rule_id = ?`)
      .all(aliceRule!.id) as Array<{ network_id: number }>;
    expect(aliceLinks.map((l) => l.network_id)).toEqual([net2!.id]);
    const newbieRule = mod.listRules(user.id).find((r) => r.pattern === 'newbie' && r.auto_managed);
    expect(newbieRule).toBeTruthy();
    const newbieLinks = db
      .prepare(`SELECT network_id FROM highlight_rule_networks WHERE rule_id = ?`)
      .all(newbieRule!.id) as Array<{ network_id: number }>;
    expect(newbieLinks.map((l) => l.network_id)).toEqual([net1!.id]);
  });

  it('skips auto-creation when a matching manual rule already exists (incl. substr default)', () => {
    // The manual default is substr — it must still suppress the auto rule.
    const manual = mod.createRule(user.id, {
      pattern: 'override',
      kind: 'substr',
      case_sensitive: false,
    });
    const out = mod.upsertAutoNickRule(user.id, net1!.id, 'override');
    // No auto rule (rule null) because the manual substr rule covers it.
    expect(out.rule).toBeNull();
    expect(mod.listRules(user.id).some((r) => r.pattern === 'override' && r.auto_managed)).toBe(
      false,
    );
    // The manual rule was not converted to auto_managed.
    expect(mod.getRule(manual!.id, user.id)!.auto_managed).toBe(false);
  });

  it('null/empty nick returns null', () => {
    expect(mod.upsertAutoNickRule(user.id, net1!.id, '').rule).toBeNull();
    // The implementation guards !nick at runtime; cast for the type check
    expect(mod.upsertAutoNickRule(user.id, net1!.id, null as unknown as string).rule).toBeNull();
  });
});
