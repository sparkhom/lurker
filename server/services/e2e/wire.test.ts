// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';

import { encodeChunk, freshMsgid, parseChunk, type WireChunk } from './wire.js';
import { WIRE_PREFIX } from './constants.js';

function sampleChunk(): WireChunk {
  return {
    msgid: new Uint8Array(8).fill(0xab),
    ts: 1_712_000_000,
    part: 1,
    total: 1,
    nonce: new Uint8Array(24).fill(0x42),
    ciphertext: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
  };
}

describe('wire format', () => {
  it('encodes with the RPE2E01 prefix', () => {
    expect(encodeChunk(sampleChunk()).startsWith(WIRE_PREFIX)).toBe(true);
  });

  it('round-trips encode -> parse', () => {
    const c = sampleChunk();
    const parsed = parseChunk(encodeChunk(c));
    expect(parsed).toEqual(c);
  });

  it('returns null for cleartext lines', () => {
    expect(parseChunk('hello world')).toBeNull();
    expect(parseChunk('')).toBeNull();
  });

  it('rejects invalid part/total on encode', () => {
    expect(() => encodeChunk({ ...sampleChunk(), total: 0 })).toThrow(/invalid total/);
    expect(() => encodeChunk({ ...sampleChunk(), total: 17 })).toThrow(/invalid total/);
    expect(() => encodeChunk({ ...sampleChunk(), total: 3, part: 4 })).toThrow(
      /invalid part\/total/,
    );
  });

  it('rejects a bad nonce length on parse', () => {
    // "YWJj" decodes to 3 bytes, not 24.
    expect(() => parseChunk('+RPE2E01 abababababababab 1712000000 1/1 YWJj:ZGVm')).toThrow(
      /nonce must be 24 bytes/,
    );
  });

  it('rejects extra fields', () => {
    const line = encodeChunk(sampleChunk()) + ' extra';
    expect(() => parseChunk(line)).toThrow(/extra fields/);
  });

  it('uses standard base64 (padded) on the wire', () => {
    // A 24-byte nonce base64-encodes to 32 chars with standard alphabet; the
    // 4-byte ciphertext here pads with '='. Confirms STANDARD, not url-safe.
    const line = encodeChunk(sampleChunk());
    const body = line.split(' ').at(-1)!;
    expect(body).toContain('=');
  });

  it('freshMsgid produces 8 random-ish bytes', () => {
    const a = freshMsgid();
    expect(a.length).toBe(8);
    expect(a).not.toEqual(freshMsgid());
  });
});
