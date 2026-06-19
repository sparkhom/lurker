// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Per-(user, network) ignore-rule cache + write path (issue #301). Mirrors
// highlightRulesService: getCompiled() caches the compiled rule set used on the
// insert hot path; every mutation invalidates so ircConnection's stamp/highlight
// decisions never read a stale set.

import type { IgnoreRuleRow, IgnoreRuleInput } from '../db/ignoredMasks.js';
import {
  addRule,
  removeRuleById,
  removeRuleByMask,
  listRules,
  sweepExpired as sweepExpiredRows,
} from '../db/ignoredMasks.js';
import { compileIgnoreRules, canonicalizeLevels } from './ignoreMatch.js';

type Compiled = ReturnType<typeof compileIgnoreRules>;

const ALLOWED_KINDS = new Set(['substr', 'full', 'regex']);
const MAX_PATTERN_LENGTH = 512;

class IgnoreRulesService {
  private cache = new Map<string, Compiled>();

  private key(userId: number, networkId: number): string {
    return `${userId}:${networkId}`;
  }

  list(userId: number, networkId: number): IgnoreRuleRow[] {
    return listRules({ userId, networkId });
  }

  add(
    userId: number,
    networkId: number,
    input: IgnoreRuleInput,
  ): { ok: false; error: string } | { ok: true; id: number; created: boolean } {
    if (!ALLOWED_KINDS.has(input.patternKind)) {
      return { ok: false, error: 'pattern kind must be substr, full, or regex' };
    }
    if (input.pattern && input.pattern.length > MAX_PATTERN_LENGTH) {
      return { ok: false, error: `pattern exceeds ${MAX_PATTERN_LENGTH} chars` };
    }
    if (input.pattern && input.patternKind === 'regex') {
      try {
        void new RegExp(input.pattern);
      } catch (e) {
        return { ok: false, error: `invalid regex: ${(e as Error).message}` };
      }
    }
    const levels = canonicalizeLevels(input.levels);
    if (levels.length === 0) {
      return { ok: false, error: 'at least one valid level is required' };
    }
    // expiresAt arrives from an untrusted WS payload. Reject anything Date.parse
    // can't read (a NaN would make the rule never expire and never sweep), and
    // canonicalize to ISO so the DB stores one consistent format.
    let expiresAt = input.expiresAt;
    if (expiresAt != null) {
      const t = Date.parse(expiresAt);
      if (Number.isNaN(t)) return { ok: false, error: 'invalid expiry timestamp' };
      expiresAt = new Date(t).toISOString();
    }
    // A rule with no who/where/what AND only ALL would hide the whole network —
    // allow it (irssi does), but a fully-empty rule (no mask, no channels, no
    // pattern) with no real effect is still stored; the matcher makes it inert.
    const { id, created } = addRule({ userId, networkId, rule: { ...input, levels, expiresAt } });
    this.invalidate(userId, networkId);
    return { ok: true, id, created };
  }

  removeById(userId: number, networkId: number, id: number): boolean {
    const ok = removeRuleById({ userId, networkId, id });
    if (ok) this.invalidate(userId, networkId);
    return ok;
  }

  removeByMask(userId: number, networkId: number, mask: string): number {
    const n = removeRuleByMask({ userId, networkId, mask });
    if (n) this.invalidate(userId, networkId);
    return n;
  }

  getCompiled(userId: number, networkId: number): Compiled {
    const k = this.key(userId, networkId);
    const cached = this.cache.get(k);
    if (cached) return cached;
    const compiled = compileIgnoreRules(listRules({ userId, networkId }));
    this.cache.set(k, compiled);
    return compiled;
  }

  invalidate(userId: number, networkId: number): void {
    this.cache.delete(this.key(userId, networkId));
  }

  // Delete every lapsed rule, invalidate the caches it touched, and return the
  // affected (user, network) pairs so the caller can fan out updated lists.
  sweepExpired(): { userId: number; networkId: number }[] {
    const affected = sweepExpiredRows();
    for (const { userId, networkId } of affected) this.invalidate(userId, networkId);
    return affected;
  }
}

const ignoreRulesService = new IgnoreRulesService();
export default ignoreRulesService;
