// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Admin control for chat-history retention: how many days of `messages` rows
// the server keeps before services/messageRetentionSweeper deletes them.
// Modelled on adminNetworks.ts's policy route — a single instance-wide
// setting, no CRUD list. Mounted under admin.ts, so requireAuth +
// requireAdmin already apply.

import { Router } from 'express';
import type { Request, Response } from 'express';
import { getMessageRetentionDays, setMessageRetentionDays } from '../db/instanceSettings.js';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.json({ retentionDays: getMessageRetentionDays() });
});

router.put('/', (req: Request, res: Response) => {
  const raw = (req.body as Record<string, unknown> | null)?.retentionDays;
  // null clears the setting — "keep forever" — same convention the getter uses.
  if (raw === null) {
    setMessageRetentionDays(null);
    res.json({ ok: true, retentionDays: null });
    return;
  }
  const days = Number(raw);
  if (!Number.isInteger(days) || days <= 0) {
    res.status(400).json({ error: 'retentionDays must be a positive integer, or null' });
    return;
  }
  setMessageRetentionDays(days);
  res.json({ ok: true, retentionDays: days });
});

export default router;
