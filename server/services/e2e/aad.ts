// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Additional Authenticated Data (AAD) construction for an RPE2E01 chunk.
//
// AAD layout (length-prefixed, big-endian):
//
//   PROTO(7 bytes, fixed)
//     || be16(channel.len) || channel
//     || be16(8)           || msgid (8 bytes)
//     || be16(8)           || ts_be (8 bytes, i64)
//     || be16(1)           || part  (1 byte)
//     || be16(1)           || total (1 byte)
//
// Every non-const field carries a u16 big-endian length prefix — even the
// fixed-size ones — so the layout is position-independent and no crafted
// channel name (e.g. one containing ':') can shift later fields. The 7-byte
// PROTO prefix is constant and therefore not length-prefixed.
//
// The sender handle is deliberately NOT in the AAD: sender authentication is
// enforced at the keyring layer (decrypt looks up the session by
// (handle_from_IRC_prefix, channel)), and the sender does not always know its
// own ident@host before encrypting. This mirrors repartee exactly; the golden
// vector in aad.test.ts pins the byte sequence for interop.

import { PROTO } from './constants.js';

const utf8 = new TextEncoder();

function be16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

/**
 * Build the AAD for a single chunk. `msgid` must be exactly 8 bytes; `ts` is
 * unix seconds (encoded as a big-endian i64); `part`/`total` are 1-indexed.
 */
export function buildAad(
  channel: string,
  msgid: Uint8Array,
  ts: number | bigint,
  part: number,
  total: number,
): Uint8Array {
  const chan = utf8.encode(channel);
  const tsBuf = Buffer.alloc(8);
  tsBuf.writeBigInt64BE(BigInt(ts));

  return Buffer.concat([
    utf8.encode(PROTO), // "RPE2E01" (7 bytes, not length-prefixed)
    be16(chan.length),
    chan,
    be16(8),
    Buffer.from(msgid),
    be16(8),
    tsBuf,
    be16(1),
    Buffer.from([part & 0xff]),
    be16(1),
    Buffer.from([total & 0xff]),
  ]);
}
