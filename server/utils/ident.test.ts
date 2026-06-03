// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { deriveIdent } from './ident.js';

describe('deriveIdent', () => {
  it('node edition surfaces the global account id from the acct-<id> username', () => {
    expect(
      deriveIdent({
        nodeMode: true,
        accountUsername: 'acct-42',
        networkUsername: 'whatever',
        nick: 'alice',
      }),
    ).toBe('lu42');
  });

  it('node edition ignores the per-network username (uniqueness is forced)', () => {
    // Two users who both picked the network username "bob" still get distinct
    // idents, because node edition keys off the account, not their choice.
    expect(
      deriveIdent({
        nodeMode: true,
        accountUsername: 'acct-7',
        networkUsername: 'bob',
        nick: 'bob',
      }),
    ).toBe('lu7');
    expect(
      deriveIdent({
        nodeMode: true,
        accountUsername: 'acct-8',
        networkUsername: 'bob',
        nick: 'bob',
      }),
    ).toBe('lu8');
  });

  it('node edition falls back safely for a non-acct username (e.g. the operator)', () => {
    expect(
      deriveIdent({ nodeMode: true, accountUsername: 'brad', networkUsername: null, nick: 'brad' }),
    ).toBe('brad');
  });

  it('standalone uses the configured network username', () => {
    expect(
      deriveIdent({
        nodeMode: false,
        accountUsername: 'acct-42',
        networkUsername: 'alice',
        nick: 'al',
      }),
    ).toBe('alice');
  });

  it('standalone falls back to the nick when no username is set', () => {
    expect(
      deriveIdent({
        nodeMode: false,
        accountUsername: 'acct-42',
        networkUsername: null,
        nick: 'al',
      }),
    ).toBe('al');
  });

  it('strips ident-invalid characters', () => {
    expect(
      deriveIdent({ nodeMode: false, accountUsername: '', networkUsername: 'a b@c!', nick: 'x' }),
    ).toBe('abc');
  });
});
