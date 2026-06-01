// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireNodeAuth } from '../middleware/nodeAuth.js';
import { getEdition } from '../utils/edition.js';
import { APP_VERSION } from '../utils/userAgent.js';
import { isValidUsername } from '../utils/username.js';
import {
  countUsers,
  createUser,
  deleteUser,
  findUserById,
  findUserByUsername,
} from '../db/users.js';
import ircManager from '../services/ircManager.js';
import { sign as signCookie } from 'cookie-signature';
import { createSession } from '../db/sessions.js';
import { SESSION_COOKIE, getCookieOptions } from '../middleware/auth.js';

// Orchestrator-driven control surface for a cell. Mounted only in node edition
// (see server.ts behind isNodeMode()), and every route requires the node secret
// — a trust channel entirely separate from tenant sessions/api_tokens. A tenant
// can never reach this.
const router = Router();
router.use(requireNodeAuth);

// Health + capacity. `users.count` is the TOTAL provisioned accounts on this
// cell (not currently-online users) — that's the figure fill-then-pin placement
// keys on, since a cell's load is the tenants assigned to it. A4 will push the
// same shape on a heartbeat.
router.get('/status', (_req: Request, res: Response) => {
  res.json({
    edition: getEdition(),
    version: APP_VERSION,
    users: { count: countUsers() },
  });
});

// Provision a tenant account. The orchestrator owns identity, so this creates
// the bare account row only; wiring how a provisioned user gets a session on
// the cell is the routing/session-ownership work (B3). Role is ALWAYS 'user' —
// a SaaS tenant must never be admin (the cell's lone admin is the operator), so
// any role in the body is deliberately ignored.
router.post('/users', (req: Request, res: Response) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  // Same rule as the human signup/auth flows so a node-provisioned account is
  // valid everywhere (length bounds + charset, no control characters).
  if (!isValidUsername(username)) {
    res.status(400).json({ error: 'invalid username' });
    return;
  }
  const existing = findUserByUsername(username);
  if (existing) {
    // Surface the existing id so a retried provision can reconcile rather than
    // guess. Deliberately not an idempotent 200 — a real username clash should
    // be visible to the orchestrator.
    res.status(409).json({ error: 'username already exists', id: existing.id });
    return;
  }
  const user = createUser(username); // role defaults to 'user'
  res.status(201).json({ id: user.id, username: user.username });
});

// Deprovision a tenant account: tear down live IRC + WS first (mirrors the
// admin delete path, so an in-flight PRIVMSG can't hit a FK violation on the
// about-to-vanish rows), then hard-delete — per-user FKs cascade.
router.delete('/users/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const target = findUserById(id);
  if (!target) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  // The orchestrator manages tenants, never the operator — refuse to delete an
  // admin through the node API.
  if (target.role === 'admin') {
    res.status(409).json({ error: 'refusing to delete an admin account' });
    return;
  }
  ircManager.disposeUser(id, 'deprovisioned');
  deleteUser(id);
  res.json({ ok: true });
});

// Mint a real cell session for a provisioned tenant and return the signed
// `lurker_session` cookie value. The reverse proxy sets this on the customer's
// browser, so the cell authenticates them through its OWN existing session
// logic — HTTP (requireAuth) and the WS upgrade alike — with no new trust path.
// Fleet-authenticated; never reachable by a tenant.
router.post('/users/:id/session', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const target = findUserById(id);
  if (!target) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  // The operator's admin account is not a tenant — never mint a session for it
  // through the node API (D1 × node-mode invariant).
  if (target.role === 'admin') {
    res.status(409).json({ error: 'refusing to mint a session for an admin account' });
    return;
  }
  // Sign with the exact secret cookie-parser validates with (attached to req by
  // the cookieParser middleware) — always accepted by the cell's normal auth,
  // no per-request disk IO, no chance of divergence from the live key.
  const secret = req.secret;
  if (!secret) {
    res.status(500).json({ error: 'session secret unavailable' });
    return;
  }
  const { token } = createSession(id);
  const value = 's:' + signCookie(token, secret);
  res.json({ cookieName: SESSION_COOKIE, value, maxAgeMs: getCookieOptions().maxAge });
});

export default router;
