// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// X25519 ECDH + HKDF-SHA256 wrap-key derivation, and the RFC 7748 Appendix A
// birational map between Ed25519 and X25519 keys.
//
// The wrap key is derived from an X25519 Diffie-Hellman shared secret expanded
// with HKDF-SHA256 (constant salt "RPE2E01-WRAP", per-context info string).
// The Ed25519 -> X25519 conversion lets the REKEY distribution path encrypt to
// a peer whose only stable key is their Ed25519 identity; it matches
// libsodium's crypto_sign_ed25519_{pk,sk}_to_curve25519 so libsodium-based
// peers (the Perl/Python scripts) derive the same keypair.

import { randomBytes } from 'node:crypto';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { HKDF_WRAP_SALT } from './constants.js';

export const WRAP_KEY_LEN = 32;

const utf8 = new TextEncoder();
const WRAP_SALT = utf8.encode(HKDF_WRAP_SALT);

export interface EphemeralKeypair {
  /** 32-byte X25519 secret. */
  secretKey: Uint8Array;
  /** 32-byte X25519 public key. */
  publicKey: Uint8Array;
}

/** Generate a fresh ephemeral X25519 keypair for a handshake. */
export function generateEphemeral(): EphemeralKeypair {
  const secretKey = new Uint8Array(randomBytes(32));
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

/**
 * Derive a 32-byte wrap key from an X25519 ECDH of our secret with the peer's
 * public, expanded via HKDF-SHA256. `info` binds the key to the protocol and
 * handshake context (use `wrapInfo`/`rekeyInfo` from constants).
 */
export function deriveWrapKey(
  mySecret: Uint8Array,
  peerPublic: Uint8Array,
  info: Uint8Array,
): Uint8Array {
  const shared = x25519.getSharedSecret(mySecret, peerPublic);
  return hkdf(sha256, shared, WRAP_SALT, info, WRAP_KEY_LEN);
}

/** Convert an Ed25519 public key to its X25519 (Montgomery) counterpart. */
export function ed25519PubToX25519(edPub: Uint8Array): Uint8Array {
  return ed25519.utils.toMontgomery(edPub);
}

/** Convert an Ed25519 secret seed to its X25519 scalar. */
export function ed25519SeedToX25519(edSeed: Uint8Array): Uint8Array {
  return ed25519.utils.toMontgomerySecret(edSeed);
}
