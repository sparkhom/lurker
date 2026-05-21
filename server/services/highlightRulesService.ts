// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { EventEmitter } from 'events';
import type { HighlightRule, RuleFields } from '../db/highlightRules.js';
import {
  listRules,
  getRule,
  createRule,
  updateRule,
  deleteRule,
  upsertAutoNickRule,
} from '../db/highlightRules.js';
import type { CompiledRule } from './highlightEngine.js';
import { compileRules } from './highlightEngine.js';

const ALLOWED_KINDS = new Set(['plain', 'glob', 'regex']);
const MAX_PATTERN_LENGTH = 256;

type ServiceResult<T = undefined> =
  | (T extends undefined ? { ok: true } : { ok: true } & { [K in keyof T]: T[K] })
  | { ok: false; error: string; status?: number };

function validatePattern(pattern: unknown): string | null {
  if (typeof pattern !== 'string') return 'pattern must be a string';
  const trimmed = pattern.trim();
  if (!trimmed) return 'pattern is required';
  if (trimmed.length > MAX_PATTERN_LENGTH) return `pattern exceeds ${MAX_PATTERN_LENGTH} chars`;
  return null;
}

function validateKind(kind: unknown): string | null {
  if (typeof kind !== 'string' || !ALLOWED_KINDS.has(kind))
    return 'kind must be plain, glob, or regex';
  return null;
}

function validateRegex(pattern: string): string | null {
  try {
    const compiled = new RegExp(pattern);
    return compiled ? null : null;
  } catch (e) {
    return `invalid regex: ${(e as Error).message}`;
  }
}

interface CreateFields {
  pattern?: unknown;
  kind?: unknown;
  case_sensitive?: unknown;
  enabled?: unknown;
}

class HighlightRulesService extends EventEmitter {
  private cache = new Map<number, CompiledRule[]>();

  list(userId: number): HighlightRule[] {
    return listRules(userId);
  }

  create(
    userId: number,
    fields: CreateFields,
  ): { ok: false; error: string } | { ok: true; rule: HighlightRule | null } {
    const pattern = ((fields.pattern as string) || '').trim();
    const kind = (fields.kind as string) || 'plain';
    const patternErr = validatePattern(pattern);
    if (patternErr) return { ok: false, error: patternErr };
    const kindErr = validateKind(kind);
    if (kindErr) return { ok: false, error: kindErr };
    if (kind === 'regex') {
      const regexErr = validateRegex(pattern);
      if (regexErr) return { ok: false, error: regexErr };
    }
    const rule = createRule(userId, {
      pattern,
      kind,
      case_sensitive: !!fields.case_sensitive,
      enabled: fields.enabled !== false,
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
    if ('pattern' in fields) {
      if (isAutoManaged)
        return { ok: false, error: 'cannot edit pattern of auto-managed rule', status: 400 };
      const pattern = ((fields.pattern as string) || '').trim();
      const patternErr = validatePattern(pattern);
      if (patternErr) return { ok: false, error: patternErr };
      update.pattern = pattern;
    }
    if ('kind' in fields) {
      if (isAutoManaged)
        return { ok: false, error: 'cannot edit kind of auto-managed rule', status: 400 };
      const kindErr = validateKind(fields.kind);
      if (kindErr) return { ok: false, error: kindErr };
      update.kind = fields.kind as string;
    }
    if ('case_sensitive' in fields) {
      if (isAutoManaged)
        return { ok: false, error: 'cannot edit case_sensitive of auto-managed rule', status: 400 };
      update.case_sensitive = !!fields.case_sensitive;
    }
    if ('enabled' in fields) update.enabled = !!fields.enabled;

    const finalKind = update.kind || existing.kind;
    const finalPattern = update.pattern ?? existing.pattern;
    if (finalKind === 'regex') {
      const regexErr = validateRegex(finalPattern);
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
    const rule = upsertAutoNickRule(userId, networkId, nick);
    this.invalidate(userId);
    return rule;
  }

  getCompiled(userId: number): CompiledRule[] {
    const cached = this.cache.get(userId);
    if (cached) return cached;
    const rules = listRules(userId);
    const compiled = compileRules(rules);
    this.cache.set(userId, compiled);
    return compiled;
  }

  invalidate(userId: number): void {
    this.cache.delete(userId);
    this.emit('change', { userId });
  }
}

const highlightRulesService = new HighlightRulesService();
export default highlightRulesService;
