// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import { findSession } from '../db/sessions.js';
import { findUserById, touchUserLastSeen } from '../db/users.js';

export const SESSION_COOKIE = 'lurker_session';

export function getCookieOptions() {
  // Secure is opt-in via COOKIE_SECURE=true. Tying it to NODE_ENV silently
  // breaks the common self-hosted shapes: LAN hostnames over plain HTTP, and
  // proxies (Cloudflare Tunnel, reverse proxies) that terminate TLS upstream
  // and connect to the container in cleartext — in both cases the browser
  // drops Secure cookies and the user appears logged in but the session
  // cookie never lands. Operators serving Lurker over true end-to-end HTTPS
  // can flip this on to harden against cleartext-network eavesdropping.
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    signed: true,
    path: '/',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  };
}

export function loadSession(req) {
  const token = req.signedCookies?.[SESSION_COOKIE];
  if (!token) return null;
  const session = findSession(token);
  if (!session) return null;
  const user = findUserById(session.user_id);
  if (!user) return null;
  return { session, user };
}

export function requireAuth(req, res, next) {
  const ctx = loadSession(req);
  if (!ctx) return res.status(401).json({ error: 'unauthorized' });
  req.user = ctx.user;
  req.session = ctx.session;
  touchUserLastSeen(ctx.user.id);
  next();
}

// Stack on top of requireAuth. Returns 403 (not 401) so the client knows the
// session is fine but the user just lacks the role — different from a missing
// or expired cookie, which the auth-store redirect handler reacts to.
export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  next();
}
