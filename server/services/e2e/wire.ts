// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// RPE2E01 wire format: encode/parse `+RPE2E01 <msgid> <ts> <part>/<total> <nonce_b64>:<ct_b64>`.
//
// Each chunk is a standalone cryptographic unit — receivers decrypt and render
// immediately, with no reassembly state. The nonce and ciphertext use STANDARD
// base64 (with padding) — NOTE this differs from the handshake messages, which
// use URL-safe-no-pad. `msgid` is 8 random bytes, lowercase-hex on the wire.

import { randomBytes } from 'node:crypto';

import { MAX_CHUNKS, WIRE_PREFIX } from './constants.js';
import { wireError } from './errors.js';

export const MSGID_LEN = 8;
const NONCE_LEN = 24;

export interface WireChunk {
  /** 8-byte message id, shared across all chunks of one logical message. */
  msgid: Uint8Array;
  /** Unix seconds (i64 on the wire / in the AAD). */
  ts: number;
  /** 1-indexed chunk number. */
  part: number;
  /** Total chunk count (1..=16). */
  total: number;
  /** 24-byte XChaCha20 nonce. */
  nonce: Uint8Array;
  /** AEAD ciphertext (includes the Poly1305 tag). */
  ciphertext: Uint8Array;
}

/** Serialize a chunk into a single IRC-safe line (no trailing newline). */
export function encodeChunk(chunk: WireChunk): string {
  const { msgid, ts, part, total, nonce, ciphertext } = chunk;
  if (total === 0 || total > MAX_CHUNKS) {
    throw wireError(`invalid total: ${total}`);
  }
  if (part === 0 || part > total) {
    throw wireError(`invalid part/total: ${part}/${total}`);
  }
  const msgidHex = Buffer.from(msgid).toString('hex');
  const nonceB64 = Buffer.from(nonce).toString('base64');
  const ctB64 = Buffer.from(ciphertext).toString('base64');
  return `${WIRE_PREFIX} ${msgidHex} ${ts} ${part}/${total} ${nonceB64}:${ctB64}`;
}

/**
 * Parse an incoming line. Returns `null` if it is not an RPE2E01 chunk (i.e.
 * cleartext), or throws `E2eError('wire')` if it is malformed.
 */
export function parseChunk(line: string): WireChunk | null {
  if (!line.startsWith(WIRE_PREFIX)) return null;
  const rest = line.slice(WIRE_PREFIX.length);
  const fields = rest.split(/\s+/).filter((f) => f.length > 0);
  if (fields.length !== 4) {
    throw wireError(fields.length < 4 ? 'missing fields' : 'extra fields');
  }
  const [msgidHex, tsStr, partTot, body] = fields;

  if (msgidHex.length !== MSGID_LEN * 2 || !/^[0-9a-fA-F]+$/.test(msgidHex)) {
    throw wireError('msgid must be 16 hex chars');
  }
  const msgid = new Uint8Array(Buffer.from(msgidHex, 'hex'));

  if (!/^-?\d+$/.test(tsStr)) throw wireError(`bad ts: ${tsStr}`);
  const ts = Number(tsStr);

  const slash = partTot.indexOf('/');
  if (slash < 0) throw wireError('part/total missing slash');
  const part = Number(partTot.slice(0, slash));
  const total = Number(partTot.slice(slash + 1));
  if (
    !Number.isInteger(part) ||
    !Number.isInteger(total) ||
    total === 0 ||
    total > MAX_CHUNKS ||
    part === 0 ||
    part > total
  ) {
    throw wireError(`bad part/total ${partTot}`);
  }

  const colon = body.indexOf(':');
  if (colon < 0) throw wireError('missing nonce:ct separator');
  const nonce = new Uint8Array(Buffer.from(body.slice(0, colon), 'base64'));
  if (nonce.length !== NONCE_LEN) {
    throw wireError(`nonce must be 24 bytes, got ${nonce.length}`);
  }
  const ciphertext = new Uint8Array(Buffer.from(body.slice(colon + 1), 'base64'));

  return { msgid, ts, part, total, nonce, ciphertext };
}

/** Generate a fresh 8-byte random message id. */
export function freshMsgid(): Uint8Array {
  return new Uint8Array(randomBytes(MSGID_LEN));
}
