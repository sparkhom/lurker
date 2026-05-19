// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  createToken,
  listForUser,
  revoke,
} from '../db/apiTokens.js';

// Admin UI for managing per-user MCP/API bearer tokens. Sibling of bookmarks.js:
// authenticated through the browser session cookie (not the bearer it manages),
// because this is where you mint tokens from. The middleware/apiAuth path is
// the read path used by /mcp; this router is the write path used by the
// browser-side settings pane.

const router = Router();
router.use(requireAuth);

const VALID_SCOPES = new Set(['read', 'read-write']);
const MAX_NAME_LEN = 64;

router.get('/', (req, res) => {
  res.json({ items: listForUser(req.user.id) });
});

router.post('/', (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const scope = typeof req.body?.scope === 'string' ? req.body.scope : '';
  if (!name) return res.status(400).json({ error: 'name required' });
  if (name.length > MAX_NAME_LEN) {
    return res.status(400).json({ error: `name too long (max ${MAX_NAME_LEN})` });
  }
  if (!VALID_SCOPES.has(scope)) {
    return res.status(400).json({ error: 'invalid scope' });
  }
  // createToken returns { id, name, scope, token } — the raw token is shown
  // exactly once here and never persisted. UI shows it in a one-time-reveal
  // modal; after the modal closes there's no API path to recover it.
  const created = createToken({ userId: req.user.id, name, scope });
  res.status(201).json(created);
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
  const ok = revoke(id, req.user.id);
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

export default router;
