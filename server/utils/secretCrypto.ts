// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// At-rest encryption for the handful of IRC network secrets a cell stores
// (server password, SASL account/password, connect-time commands). The hosted
// service continuously replicates each cell's SQLite to R2 via Litestream, so a
// leaked/misconfigured backup would otherwise expose every customer's network
// passwords in cleartext. We wrap those columns with AES-256-GCM under a key
// held in the cell's environment (LURKER_SECRET_KEY), NOT in the DB — so the
// replicated SQLite file holds only ciphertext.
//
//   key present  → encrypt on write, decrypt on read (hosted cells).
//   key absent   → plaintext, exactly as before (every self-host install).
//
// Honest scope: this defends backups / disk snapshots / DB dumps. It does NOT
// defend a live RCE on the running cell — the app must decrypt to use a secret.
// Never claim "we can't read it"; only account passwords are one-way (scrypt).
//
// Stored form is a self-describing envelope string, so no schema column or
// migration is needed and key rotation stays additive:
//
//   lk1.<keyid>.<base64url(iv | tag | ciphertext)>
//
// where keyid = the first 8 hex of sha256(key), iv = 12 random bytes, and tag =
// the 16-byte GCM auth tag. A value that doesn't start with `lk1.` is treated as
// legacy plaintext and returned unchanged on read (lazy migration; the boot-time
// backfill in db/networks.ts wraps such rows once a key is configured).

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const ENVELOPE_PREFIX = 'lk1';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEYID_HEX_LEN = 8; // length of the keyid (sha256(key) prefix) in the envelope
const PRIMARY_KEY_ENV = 'LURKER_SECRET_KEY';

// The full envelope shape: lk1.<8-hex-keyid>.<base64url>. Matching the whole
// shape — not just the `lk1.` prefix — means a legitimate plaintext secret that
// merely starts with "lk1." isn't misclassified as ciphertext (which would make
// encryptSecret skip wrapping it and decryptSecret throw on read).
const ENVELOPE_RE = new RegExp(
  `^${ENVELOPE_PREFIX}\\.[0-9a-f]{${KEYID_HEX_LEN}}\\.[A-Za-z0-9_-]+$`,
);

interface KeyEntry {
  keyid: string;
  key: Buffer;
}

interface Registry {
  primary: KeyEntry;
  byId: Map<string, KeyEntry>;
}

// Decode an operator-supplied key string into exactly 32 bytes. Accepts base64
// / base64url (the usual `openssl rand -base64 32` output) or a 64-char hex
// string. Throws on anything that isn't 32 bytes so a misconfigured key fails
// loud at boot rather than silently downgrading a hosted cell to plaintext.
function decodeKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const buf = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64'); // Buffer.from tolerates base64 and base64url
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `${PRIMARY_KEY_ENV} must decode to ${KEY_BYTES} bytes (got ${buf.length}); ` +
        `generate one with: openssl rand -base64 32`,
    );
  }
  return buf;
}

function fingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, KEYID_HEX_LEN);
}

// Built once, lazily, from the environment. `primary` is the key new writes are
// encrypted under, and `byId` indexes keys by keyid for decryption. Today only
// the single LURKER_SECRET_KEY is loaded, so changing it makes existing
// ciphertext undecryptable; the envelope carries a keyid purely so multi-key
// rotation (load retired keys into byId here, re-wrap on next write) can be ADDED
// later without a format change. null when no key is configured.
let registry: Registry | null = null;
let registryBuilt = false;

function buildRegistry(): Registry | null {
  const primaryRaw = process.env[PRIMARY_KEY_ENV];
  if (!primaryRaw || primaryRaw.trim() === '') return null;
  const key = decodeKey(primaryRaw);
  const primary: KeyEntry = { keyid: fingerprint(key), key };
  return { primary, byId: new Map([[primary.keyid, primary]]) };
}

function getRegistry(): Registry | null {
  if (!registryBuilt) {
    registry = buildRegistry();
    registryBuilt = true;
  }
  return registry;
}

/** Reset the cached key registry. Test-only: lets a suite flip LURKER_SECRET_KEY. */
export function resetKeyRegistryForTests(): void {
  registry = null;
  registryBuilt = false;
}

/** True when a network-secret encryption key is configured (hosted cells). */
export function hasSecretKey(): boolean {
  return getRegistry() !== null;
}

/** True if `value` is one of our encrypted envelopes (vs legacy plaintext). */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && ENVELOPE_RE.test(value);
}

// Encrypt a single secret for storage. null / empty-string pass through
// untouched (an empty value is "no secret", nothing to wrap). With no key
// configured the value is returned as-is, so self-host stays plaintext. An
// already-encrypted value is returned unchanged (never double-wrap).
export function encryptSecret(plain: string | null): string | null {
  if (plain == null || plain === '') return plain;
  if (isEncrypted(plain)) return plain;
  const reg = getRegistry();
  if (!reg) return plain;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, reg.primary.key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, ct]).toString('base64url');
  return `${ENVELOPE_PREFIX}.${reg.primary.keyid}.${payload}`;
}

// Decrypt a stored secret back to plaintext. null and legacy plaintext (no
// envelope prefix) pass through unchanged. Throws on a malformed envelope, an
// unknown key id, or a failed auth tag (tampering / wrong key): a hosted cell
// that can't decrypt its own secrets is misconfigured and must fail loud rather
// than hand ciphertext to an IRC server or render it in the UI.
export function decryptSecret(stored: string | null): string | null {
  if (stored == null || !isEncrypted(stored)) return stored;
  const parts = stored.split('.');
  if (parts.length !== 3) throw new Error('secretCrypto: malformed envelope');
  const [, keyid, payloadB64] = parts;
  const entry = getRegistry()?.byId.get(keyid);
  if (!entry) {
    throw new Error(
      `secretCrypto: no key for id "${keyid}" — is ${PRIMARY_KEY_ENV} set to the right value?`,
    );
  }
  const payload = Buffer.from(payloadB64, 'base64url');
  if (payload.length < IV_BYTES + TAG_BYTES) throw new Error('secretCrypto: truncated envelope');
  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = payload.subarray(IV_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv(ALGORITHM, entry.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (err) {
    throw new Error(
      `secretCrypto: failed to decrypt (wrong key or tampered ciphertext): ${(err as Error).message}`,
      { cause: err },
    );
  }
}
