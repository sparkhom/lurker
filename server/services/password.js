import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const SCRYPT_N = 1 << 15;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;
// Node's default scrypt `maxmem` is 32 MiB, which our N/r tuple bumps right
// up against and trips ERR_CRYPTO_INVALID_SCRYPT_PARAMS. Give ourselves
// generous headroom so verify works the same on any host.
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_r * 4;

const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 256;

export function isValidPassword(password) {
  if (typeof password !== 'string') return false;
  return password.length >= MIN_PASSWORD_LEN && password.length <= MAX_PASSWORD_LEN;
}

export function passwordRequirementsMessage() {
  return `password must be between ${MIN_PASSWORD_LEN} and ${MAX_PASSWORD_LEN} characters`;
}

export function hashPassword(password) {
  const salt = randomBytes(SALT_LEN);
  const derived = scryptSync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_r,
    p: SCRYPT_p,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt$')) return false;
  const parts = stored.split('$');
  if (parts.length !== 6) return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;
  let derived;
  try {
    derived = scryptSync(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: 128 * N * r * 4,
    });
  } catch {
    return false;
  }
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
