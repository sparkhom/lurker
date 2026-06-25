// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';

import { buildAad } from './aad.js';

const msgid = (b: number) => new Uint8Array(8).fill(b);

describe('buildAad', () => {
  it('is deterministic', () => {
    expect(buildAad('#chan', msgid(1), 100, 1, 3)).toEqual(buildAad('#chan', msgid(1), 100, 1, 3));
  });

  it('is sensitive to every field', () => {
    const base = buildAad('#chan', msgid(1), 100, 1, 3);
    expect(base).not.toEqual(buildAad('#other', msgid(1), 100, 1, 3));
    expect(base).not.toEqual(buildAad('#chan', msgid(2), 100, 1, 3));
    expect(base).not.toEqual(buildAad('#chan', msgid(1), 101, 1, 3));
    expect(base).not.toEqual(buildAad('#chan', msgid(1), 100, 2, 3));
    expect(base).not.toEqual(buildAad('#chan', msgid(1), 100, 1, 4));
  });

  // Cross-client interop golden vector, taken verbatim from repartee's
  // wire.rs::build_aad_golden_vector. The weechat/Perl scripts produce the
  // same 40 bytes for these inputs — if this changes, interop breaks.
  it('matches the cross-client golden byte sequence', () => {
    const got = buildAad('#chan', msgid(1), 100, 1, 3);
    // prettier-ignore
    const expected = [
      0x52, 0x50, 0x45, 0x32, 0x45, 0x30, 0x31, // "RPE2E01"
      0x00, 0x05, 0x23, 0x63, 0x68, 0x61, 0x6e, // be16(5) || "#chan"
      0x00, 0x08, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, // be16(8) || msgid
      0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x64, // be16(8) || ts=100 be64
      0x00, 0x01, 0x01, // be16(1) || part=1
      0x00, 0x01, 0x03, // be16(1) || total=3
    ];
    expect(got.length).toBe(40);
    expect(Array.from(got)).toEqual(expected);
  });

  // The length-prefixed layout keeps a channel containing ':' distinct from
  // any other arrangement that happens to concatenate the same bytes.
  it('length-prefix defeats colon ambiguity', () => {
    const a = buildAad('#a:b', msgid(1), 100, 1, 3);
    const b = buildAad('#a', msgid(1), 100, 1, 3);
    expect(a).not.toEqual(b);
    expect(a.length).not.toBe(b.length);
  });
});
