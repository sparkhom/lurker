// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';

// A deterministic 32-byte key (base64). The registry is built lazily on first
// use, so setting this before any test runs is enough.
const GOOD_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.LURKER_SECRET_KEY = GOOD_KEY;

import {
  encryptSecret,
  decryptSecret,
  isEncrypted,
  hasSecretKey,
  resetKeyRegistryForTests,
} from './secretCrypto.js';

describe('secretCrypto (key configured)', () => {
  it('round-trips a secret through encrypt → decrypt', () => {
    const plain = 'hunter2 🔒 with spaces';
    const wrapped = encryptSecret(plain)!;
    expect(wrapped).not.toBe(plain);
    expect(decryptSecret(wrapped)).toBe(plain);
  });

  it('produces a self-describing lk1 envelope', () => {
    const wrapped = encryptSecret('x')!;
    expect(isEncrypted(wrapped)).toBe(true);
    expect(wrapped.split('.')).toHaveLength(3);
    expect(wrapped.startsWith('lk1.')).toBe(true);
  });

  it('uses a random IV (same plaintext encrypts to different ciphertext)', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('passes null and empty string through untouched', () => {
    expect(encryptSecret(null)).toBeNull();
    expect(encryptSecret('')).toBe('');
    expect(decryptSecret(null)).toBeNull();
  });

  it('treats a non-envelope value as legacy plaintext on decrypt', () => {
    expect(decryptSecret('plain-legacy-password')).toBe('plain-legacy-password');
  });

  it('does not misclassify plaintext that merely starts with "lk1."', () => {
    // Only the full lk1.<8-hex-keyid>.<base64url> shape counts as ciphertext; a
    // plaintext secret that just starts with "lk1." is left alone — otherwise
    // encryptSecret would skip wrapping it and decryptSecret would throw on read.
    expect(isEncrypted('lk1.connect to nickserv')).toBe(false); // space → wrong shape
    expect(isEncrypted('lk1.zzzzzzzz.payload')).toBe(false); // keyid not hex
    expect(isEncrypted('lk1.deadbeef')).toBe(false); // no payload segment
    expect(decryptSecret('lk1.not-an-envelope')).toBe('lk1.not-an-envelope'); // passthrough, no throw
    // Such a value still gets wrapped on encrypt (round-trips), not skipped.
    const plain = 'lk1.my actual password';
    const wrapped = encryptSecret(plain)!;
    expect(isEncrypted(wrapped)).toBe(true);
    expect(decryptSecret(wrapped)).toBe(plain);
  });

  it('never double-wraps an already-encrypted value', () => {
    const wrapped = encryptSecret('once')!;
    expect(encryptSecret(wrapped)).toBe(wrapped);
  });

  it('reports a configured key', () => {
    expect(hasSecretKey()).toBe(true);
  });

  it('throws when the ciphertext has been tampered with', () => {
    const [prefix, keyid, payloadB64] = encryptSecret('tamper-me')!.split('.');
    const bytes = Buffer.from(payloadB64, 'base64url');
    bytes[bytes.length - 1] ^= 0xff; // flip the last ciphertext byte
    const tampered = `${prefix}.${keyid}.${bytes.toString('base64url')}`;
    expect(() => decryptSecret(tampered)).toThrow(/failed to decrypt/);
  });

  it('throws on an unknown key id', () => {
    const wrapped = encryptSecret('whatever')!;
    const parts = wrapped.split('.');
    parts[1] = 'deadbeef';
    expect(() => decryptSecret(parts.join('.'))).toThrow(/no key for id/);
  });

  it('fails loud when the configured key is malformed', () => {
    try {
      process.env.LURKER_SECRET_KEY = 'too-short';
      resetKeyRegistryForTests();
      expect(() => hasSecretKey()).toThrow(/must decode to 32 bytes/);
    } finally {
      process.env.LURKER_SECRET_KEY = GOOD_KEY;
      resetKeyRegistryForTests();
    }
  });
});
