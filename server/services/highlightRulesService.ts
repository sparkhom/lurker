// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { EventEmitter } from 'events';
import type { HighlightRule, RuleFields } from '../db/highlightRules.js';
import {
  listRules,
  listScopedRules,
  getRule,
  createRule,
  updateRule,
  deleteRule,
  upsertAutoNickRule,
} from '../db/highlightRules.js';
import type { CompiledRule } from './highlightEngine.js';
import { compileRules } from './highlightEngine.js';
import { normalizeChannelList } from '../../shared/channels.js';

// Unified with ignore's pattern kinds; 'glob' is highlight-only and 'plain' is
// the retired alias for 'full', both still accepted so old rules keep working.
const ALLOWED_KINDS = new Set(['substr', 'full', 'glob', 'plain', 'regex']);
const MAX_PATTERN_LENGTH = 256;
const MAX_MASK_LENGTH = 256;

type ServiceResult<T = undefined> =
  | (T extends undefined ? { ok: true } : { ok: true } & { [K in keyof T]: T[K] })
  | { ok: false; error: string; status?: number };

function validateKind(kind: unknown): string | null {
  if (typeof kind !== 'string' || !ALLOWED_KINDS.has(kind))
    return 'kind must be substr, full, glob, or regex';
  return null;
}

function validateRegex(pattern: string | null): string | null {
  if (!pattern) return null;
  try {
    void new RegExp(pattern);
    return null;
  } catch (e) {
    return `invalid regex: ${(e as Error).message}`;
  }
}

function normalizeChannels(raw: unknown): string[] | null {
  if (raw == null) return null;
  const out = normalizeChannelList(Array.isArray(raw) ? raw : [raw]);
  return out.length ? out : null;
}

interface CreateFields {
  pattern?: unknown;
  mask?: unknown;
  channels?: unknown;
  kind?: unknown;
  case_sensitive?: unknown;
  enabled?: unknown;
  networkId?: unknown;
}

class HighlightRulesService extends EventEmitter {
  // Compiled rule sets are scoped per (user, network): a network sees its own
  // rules plus the user's global rules. Keyed "userId:networkId".
  private cache = new Map<string, CompiledRule[]>();

  private key(userId: number, networkId: number): string {
    return `${userId}:${networkId}`;
  }

  list(userId: number): HighlightRule[] {
    return listRules(userId);
  }

  create(
    userId: number,
    fields: CreateFields,
  ): { ok: false; error: string } | { ok: true; rule: HighlightRule | null } {
    const pattern = typeof fields.pattern === 'string' ? fields.pattern.trim() : '';
    // A bare '*' mask means "anyone" — i.e. no sender constraint. On its own it
    // would compile to a dead rule, so normalize it away and let the
    // pattern-or-mask check below reject a '*'-only rule.
    const rawMask = typeof fields.mask === 'string' ? fields.mask.trim() : '';
    const mask = rawMask === '*' ? '' : rawMask;
    if (!pattern && !mask) return { ok: false, error: 'a pattern or mask is required' };
    if (pattern.length > MAX_PATTERN_LENGTH)
      return { ok: false, error: `pattern exceeds ${MAX_PATTERN_LENGTH} chars` };
    if (mask.length > MAX_MASK_LENGTH)
      return { ok: false, error: `mask exceeds ${MAX_MASK_LENGTH} chars` };
    const kind = typeof fields.kind === 'string' ? fields.kind : 'substr';
    const kindErr = validateKind(kind);
    if (kindErr) return { ok: false, error: kindErr };
    if (kind === 'regex') {
      const regexErr = validateRegex(pattern);
      if (regexErr) return { ok: false, error: regexErr };
    }
    const networkId =
      typeof fields.networkId === 'number' && fields.networkId > 0 ? fields.networkId : null;
    const rule = createRule(userId, {
      pattern: pattern || null,
      mask: mask || null,
      channels: normalizeChannels(fields.channels),
      kind,
      case_sensitive: !!fields.case_sensitive,
      enabled: fields.enabled !== false,
      networkId,
    });
    this.invalidate(userId);
    return { ok: true, rule };
  }

  update(
    id: number,
    userId: number,
    fields: CreateFields,
  ): { ok: false; error: string; status?: number } | { ok: true; rule: HighlightRule | null } {
    const existing = getRule(id, userId);
    if (!existing) return { ok: false, error: 'rule not found', status: 404 };
    const isAutoManaged = !!existing.auto_managed;
    const update: RuleFields = {};
    // Auto-managed rules track the network nick and are fully system-managed —
    // every field (including enabled) is read-only to the user.
    const blockAuto = (field: string): { ok: false; error: string; status: number } | null =>
      isAutoManaged
        ? { ok: false, error: `cannot edit ${field} of auto-managed rule`, status: 400 }
        : null;
    if ('pattern' in fields) {
      const blocked = blockAuto('pattern');
      if (blocked) return blocked;
      const pattern = typeof fields.pattern === 'string' ? fields.pattern.trim() : '';
      if (pattern.length > MAX_PATTERN_LENGTH)
        return { ok: false, error: `pattern exceeds ${MAX_PATTERN_LENGTH} chars` };
      update.pattern = pattern || null;
    }
    if ('mask' in fields) {
      const blocked = blockAuto('mask');
      if (blocked) return blocked;
      const rawMask = typeof fields.mask === 'string' ? fields.mask.trim() : '';
      const mask = rawMask === '*' ? '' : rawMask;
      if (mask.length > MAX_MASK_LENGTH)
        return { ok: false, error: `mask exceeds ${MAX_MASK_LENGTH} chars` };
      update.mask = mask || null;
    }
    if ('channels' in fields) {
      const blocked = blockAuto('channels');
      if (blocked) return blocked;
      update.channels = normalizeChannels(fields.channels);
    }
    if ('kind' in fields) {
      const blocked = blockAuto('kind');
      if (blocked) return blocked;
      const kindErr = validateKind(fields.kind);
      if (kindErr) return { ok: false, error: kindErr };
      update.kind = fields.kind as string;
    }
    if ('case_sensitive' in fields) {
      const blocked = blockAuto('case_sensitive');
      if (blocked) return blocked;
      update.case_sensitive = !!fields.case_sensitive;
    }
    if ('enabled' in fields) {
      // Auto-managed nick rules are fully system-managed — no enable/disable
      // either, so the 🔒 row is entirely read-only.
      const blocked = blockAuto('enabled');
      if (blocked) return blocked;
      update.enabled = !!fields.enabled;
    }
    if ('networkId' in fields) {
      // Re-scope: makes an edit (incl. global↔network) a single atomic, id-stable
      // update instead of create-then-delete. null = global.
      const blocked = blockAuto('network scope');
      if (blocked) return blocked;
      update.networkId =
        typeof fields.networkId === 'number' && fields.networkId > 0 ? fields.networkId : null;
    }

    const finalKind = update.kind || existing.kind;
    // Use `in` (not ??) so an explicit clear-to-null (PATCH {pattern:''}) is
    // honored: otherwise the guard reads the stale existing value and a rule with
    // neither pattern nor mask slips through and compiles to nothing.
    const finalPattern = 'pattern' in update ? update.pattern : existing.pattern;
    const finalMask = 'mask' in update ? update.mask : existing.mask;
    if (!finalPattern && !finalMask) return { ok: false, error: 'a pattern or mask is required' };
    if (finalKind === 'regex') {
      const regexErr = validateRegex(finalPattern ?? null);
      if (regexErr) return { ok: false, error: regexErr };
    }
    const rule = updateRule(id, userId, update);
    this.invalidate(userId);
    return { ok: true, rule };
  }

  remove(id: number, userId: number): ServiceResult {
    const existing = getRule(id, userId);
    if (!existing) return { ok: false, error: 'rule not found', status: 404 };
    if (existing.auto_managed) {
      return { ok: false, error: 'cannot delete auto-managed rule', status: 400 };
    }
    deleteRule(id, userId);
    this.invalidate(userId);
    return { ok: true };
  }

  upsertAutoNickRule(
    userId: number,
    networkId: number,
    nick: string | null | undefined,
  ): HighlightRule | null {
    if (!nick) return null;
    // Only invalidate (→ cross-tab refetch fanout) when the upsert actually
    // changed something. A reconnect re-attaches an already-attached nick rule
    // (a no-op), so without this gate every reconnect storms all tabs with
    // redundant GET /api/highlight-rules for zero change.
    const { rule, changed } = upsertAutoNickRule(userId, networkId, nick);
    if (changed) this.invalidate(userId);
    return rule;
  }

  getCompiled(userId: number, networkId: number): CompiledRule[] {
    const k = this.key(userId, networkId);
    const cached = this.cache.get(k);
    if (cached) return cached;
    const compiled = compileRules(listScopedRules(userId, networkId));
    this.cache.set(k, compiled);
    return compiled;
  }

  // A global rule (no network scope) feeds every network's compiled set, so any
  // change drops all of the user's cached networks. emit('change') drives the
  // cross-device WS resync.
  invalidate(userId: number): void {
    const prefix = `${userId}:`;
    for (const key of this.cache.keys()) if (key.startsWith(prefix)) this.cache.delete(key);
    this.emit('change', { userId });
  }
}

const highlightRulesService = new HighlightRulesService();
export default highlightRulesService;
