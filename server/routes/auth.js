import { Router } from 'express';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';

import {
  findUserById,
  findUserByUsername,
  countUsers,
  createUser,
  deleteUser,
} from '../db/users.js';
import { inviteStatus, consumeInvite } from '../db/invites.js';
import {
  listForUser as listCredentialsForUser,
  findByCredentialId,
  countAll as countAllCredentials,
  countForUser as countCredentialsForUser,
  insertCredential,
  updateCounter,
  updateLabel,
  deleteById as deleteCredentialById,
} from '../db/webauthnCredentials.js';
import { createSession, deleteSession } from '../db/sessions.js';
import { SESSION_COOKIE, getCookieOptions, requireAuth } from '../middleware/auth.js';
import {
  rpConfig,
  saveChallenge,
  consumeChallenge,
  userIdToHandle,
} from '../services/webauthn.js';

const CHALLENGE_COOKIE = 'lurker_webauthn_challenge';

function challengeCookieOptions() {
  // Short-lived, signed, scoped to the auth flow. Mirrors session cookie
  // security flags so it works under the same dev/prod settings.
  const base = getCookieOptions();
  return { ...base, maxAge: 5 * 60 * 1000 };
}

function setChallengeCookie(res, token) {
  res.cookie(CHALLENGE_COOKIE, token, challengeCookieOptions());
}

function clearChallengeCookie(res) {
  res.clearCookie(CHALLENGE_COOKIE, { ...challengeCookieOptions(), maxAge: undefined });
}

function isValidUsername(name) {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 64) return false;
  return /^[A-Za-z0-9_.\- ]+$/.test(trimmed);
}

function publicCredential(c) {
  return {
    id: c.id,
    label: c.label,
    deviceType: c.deviceType,
    backedUp: c.backedUp,
    transports: c.transports,
    createdAt: c.createdAt,
    lastUsedAt: c.lastUsedAt,
  };
}

const router = Router();

// ---------- setup status ----------

// "Needs setup" means the system has no users yet — i.e. the very first run
// before the operator bootstraps their admin account. Once a user exists,
// further accounts come in through the invite flow, not this endpoint.
router.get('/setup-status', (req, res) => {
  if (countUsers() === 0) {
    return res.json({ needsSetup: true, mode: 'create-user' });
  }
  return res.json({ needsSetup: false });
});

// ---------- setup / first-admin bootstrap ----------

// Open registration only while there are zero users. The first account
// created here is promoted to admin and gets exclusive control over invites
// and user management.
router.post('/setup/options', async (req, res) => {
  if (countUsers() > 0) {
    return res.status(409).json({ error: 'setup already complete' });
  }
  const requested = (req.body?.username || '').trim();
  if (!isValidUsername(requested)) {
    return res.status(400).json({ error: 'invalid username' });
  }
  if (findUserByUsername(requested)) {
    return res.status(409).json({ error: 'username already taken' });
  }
  const user = createUser(requested, { role: 'admin' });
  const { rpID, rpName } = rpConfig();
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: user.username,
    userID: userIdToHandle(user.id),
    userDisplayName: user.username,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'preferred',
    },
    excludeCredentials: [],
  });

  const token = saveChallenge({
    purpose: 'setup',
    challenge: options.challenge,
    userId: user.id,
  });
  setChallengeCookie(res, token);
  res.json({ options, mode: 'create-user', username: user.username });
});

router.post('/setup/verify', async (req, res) => {
  const token = req.signedCookies?.[CHALLENGE_COOKIE];
  const entry = consumeChallenge(token);
  clearChallengeCookie(res);
  if (!entry || entry.purpose !== 'setup') {
    return res.status(400).json({ error: 'no pending setup' });
  }
  // Race guard: if another tab finished setup between options and verify,
  // back out. We can't safely create credentials against the now-existing
  // admin from an anonymous request.
  if (countAllCredentials() > 0) {
    return res.status(409).json({ error: 'setup already complete' });
  }
  const { rpID, expectedOrigin } = rpConfig();
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: req.body?.response,
      expectedChallenge: entry.challenge,
      expectedOrigin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'verification failed' });
  }
  if (!verification.verified || !verification.registrationInfo) {
    return res.status(400).json({ error: 'verification failed' });
  }

  const user = findUserById(entry.userId);
  if (!user) return res.status(500).json({ error: 'user vanished mid-setup' });

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const label = (req.body?.label || '').toString().trim().slice(0, 64) || null;
  insertCredential({
    userId: user.id,
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports || [],
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
    label,
  });

  const { token: sessionToken } = createSession(user.id);
  res.cookie(SESSION_COOKIE, sessionToken, getCookieOptions());
  res.json({ user: { id: user.id, username: user.username, role: user.role } });
});

// ---------- invite redemption ----------

// Public status probe. Returns the bare minimum the UI needs to render the
// landing page — no info about who created the invite or for whom.
router.get('/invite/:token', (req, res) => {
  const result = inviteStatus(req.params.token);
  if (result.status === 'valid') return res.json({ valid: true });
  if (result.status === 'expired') return res.json({ valid: false, expired: true });
  return res.json({ valid: false });
});

router.post('/invite/:token/options', async (req, res) => {
  const result = inviteStatus(req.params.token);
  if (result.status !== 'valid') {
    return res.status(404).json({ error: 'invalid or used invite' });
  }
  const requested = (req.body?.username || '').trim();
  if (!isValidUsername(requested)) {
    return res.status(400).json({ error: 'invalid username' });
  }
  if (findUserByUsername(requested)) {
    return res.status(409).json({ error: 'username already taken' });
  }
  // Create the user up-front so we have a stable webauthn user handle for the
  // registration options. If the user abandons the flow we end up with a
  // username-squatter the admin can remove, mirroring the existing setup
  // flow's tradeoff.
  const user = createUser(requested, { role: 'user' });
  const { rpID, rpName } = rpConfig();
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: user.username,
    userID: userIdToHandle(user.id),
    userDisplayName: user.username,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'preferred',
    },
    excludeCredentials: [],
  });
  const token = saveChallenge({
    purpose: 'invite',
    challenge: options.challenge,
    userId: user.id,
    inviteToken: req.params.token,
  });
  setChallengeCookie(res, token);
  res.json({ options, username: user.username });
});

router.post('/invite/:token/verify', async (req, res) => {
  const challengeToken = req.signedCookies?.[CHALLENGE_COOKIE];
  const entry = consumeChallenge(challengeToken);
  clearChallengeCookie(res);
  if (!entry || entry.purpose !== 'invite' || entry.inviteToken !== req.params.token) {
    return res.status(400).json({ error: 'no pending invite' });
  }
  // Re-check the invite right before committing. Status may have changed
  // between options and verify (admin revoke, parallel redemption).
  if (inviteStatus(req.params.token).status !== 'valid') {
    deleteUser(entry.userId);
    return res.status(409).json({ error: 'invite is no longer valid' });
  }
  const { rpID, expectedOrigin } = rpConfig();
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: req.body?.response,
      expectedChallenge: entry.challenge,
      expectedOrigin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch (err) {
    deleteUser(entry.userId);
    return res.status(400).json({ error: err.message || 'verification failed' });
  }
  if (!verification.verified || !verification.registrationInfo) {
    deleteUser(entry.userId);
    return res.status(400).json({ error: 'verification failed' });
  }

  const user = findUserById(entry.userId);
  if (!user) return res.status(500).json({ error: 'user vanished mid-setup' });

  // Atomic consume — only one parallel redemption can win. If we lose,
  // tear down the user we created and surface the conflict.
  if (!consumeInvite(req.params.token, user.id)) {
    deleteUser(user.id);
    return res.status(409).json({ error: 'invite is no longer valid' });
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const label = (req.body?.label || '').toString().trim().slice(0, 64) || null;
  insertCredential({
    userId: user.id,
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports || [],
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
    label,
  });

  const { token: sessionToken } = createSession(user.id);
  res.cookie(SESSION_COOKIE, sessionToken, getCookieOptions());
  res.json({ user: { id: user.id, username: user.username, role: user.role } });
});

// ---------- login ----------

router.post('/login/options', async (req, res) => {
  if (countAllCredentials() === 0) {
    return res.status(409).json({ error: 'no passkeys registered' });
  }
  const { rpID } = rpConfig();
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'preferred',
    // Empty allowCredentials lets the browser surface any discoverable
    // (resident-key) passkey for this RP — no username field needed.
    allowCredentials: [],
  });
  const token = saveChallenge({
    purpose: 'login',
    challenge: options.challenge,
  });
  setChallengeCookie(res, token);
  res.json({ options });
});

router.post('/login/verify', async (req, res) => {
  const token = req.signedCookies?.[CHALLENGE_COOKIE];
  const entry = consumeChallenge(token);
  clearChallengeCookie(res);
  if (!entry || entry.purpose !== 'login') {
    return res.status(400).json({ error: 'no pending login' });
  }
  const response = req.body?.response;
  const credentialId = response?.id;
  if (!credentialId) return res.status(400).json({ error: 'missing credential id' });

  const stored = findByCredentialId(credentialId);
  if (!stored) return res.status(401).json({ error: 'unknown credential' });

  const { rpID, expectedOrigin } = rpConfig();
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: entry.challenge,
      expectedOrigin,
      expectedRPID: rpID,
      credential: {
        id: stored.credentialId,
        publicKey: new Uint8Array(stored.publicKey),
        counter: stored.counter,
        transports: stored.transports,
      },
      requireUserVerification: false,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'verification failed' });
  }
  if (!verification.verified) return res.status(401).json({ error: 'verification failed' });

  updateCounter(stored.id, verification.authenticationInfo.newCounter);

  const user = findUserById(stored.userId);
  if (!user) return res.status(500).json({ error: 'user no longer exists' });

  const { token: sessionToken } = createSession(user.id);
  res.cookie(SESSION_COOKIE, sessionToken, getCookieOptions());
  res.json({ user: { id: user.id, username: user.username, role: user.role } });
});

// ---------- session ----------

router.post('/logout', (req, res) => {
  const token = req.signedCookies?.[SESSION_COOKIE];
  if (token) deleteSession(token);
  res.clearCookie(SESSION_COOKIE, { ...getCookieOptions(), maxAge: undefined });
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: { id: req.user.id, username: req.user.username, role: req.user.role } });
});

// ---------- passkey management (authed) ----------

router.get('/passkeys', requireAuth, (req, res) => {
  res.json({ passkeys: listCredentialsForUser(req.user.id).map(publicCredential) });
});

router.post('/passkeys/options', requireAuth, async (req, res) => {
  const { rpID, rpName } = rpConfig();
  const existing = listCredentialsForUser(req.user.id);
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: req.user.username,
    userID: userIdToHandle(req.user.id),
    userDisplayName: req.user.username,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'preferred',
    },
    excludeCredentials: existing.map((c) => ({
      id: c.credentialId,
      transports: c.transports,
    })),
  });
  const token = saveChallenge({
    purpose: 'add-passkey',
    challenge: options.challenge,
    userId: req.user.id,
  });
  setChallengeCookie(res, token);
  res.json({ options });
});

router.post('/passkeys/verify', requireAuth, async (req, res) => {
  const token = req.signedCookies?.[CHALLENGE_COOKIE];
  const entry = consumeChallenge(token);
  clearChallengeCookie(res);
  if (!entry || entry.purpose !== 'add-passkey' || entry.userId !== req.user.id) {
    return res.status(400).json({ error: 'no pending registration' });
  }
  const { rpID, expectedOrigin } = rpConfig();
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: req.body?.response,
      expectedChallenge: entry.challenge,
      expectedOrigin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'verification failed' });
  }
  if (!verification.verified || !verification.registrationInfo) {
    return res.status(400).json({ error: 'verification failed' });
  }
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const label = (req.body?.label || '').toString().trim().slice(0, 64) || null;
  const stored = insertCredential({
    userId: req.user.id,
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports || [],
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
    label,
  });
  res.json({ passkey: publicCredential(stored) });
});

router.patch('/passkeys/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const label = (req.body?.label || '').toString().trim().slice(0, 64) || null;
  const ok = updateLabel(id, req.user.id, label);
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

router.delete('/passkeys/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  // Refuse to remove the last passkey — that locks the account out, and we
  // don't have a fallback auth method to recover with.
  if (countCredentialsForUser(req.user.id) <= 1) {
    return res.status(409).json({ error: 'cannot remove your only passkey' });
  }
  const ok = deleteCredentialById(id, req.user.id);
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

export default router;
