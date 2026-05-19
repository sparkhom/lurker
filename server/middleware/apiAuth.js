// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { findActiveByHash, hashToken, touchLastUsed } from '../db/apiTokens.js';
import { findUserById } from '../db/users.js';

// Sibling of middleware/auth.js#requireAuth, but for bearer-token clients
// (HTTP API + MCP). Tokens are HTTP-only by design — the WebSocket endpoint
// remains cookie-only so the in-process plugin runtime question stays
// deferred without re-auth gymnastics. `req.user` is populated to the same
// shape `requireAuth` sets so downstream handlers can't tell the transport
// apart; `req.session` is intentionally absent.
export function requireApiAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(\S+)$/.exec(header);
  if (!match) return res.status(401).json({ error: 'unauthorized' });
  const raw = match[1];
  const tokenRow = findActiveByHash(hashToken(raw));
  if (!tokenRow) return res.status(401).json({ error: 'unauthorized' });
  const user = findUserById(tokenRow.userId);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  req.apiToken = { id: tokenRow.id, scope: tokenRow.scope };
  touchLastUsed(tokenRow.id);
  next();
}
