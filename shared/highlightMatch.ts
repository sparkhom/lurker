// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { buildTextTest, cleanForMatch } from './textMatch.js';
import { buildMaskMatcher, buildChannelMatcher, patternKindToTextKind } from './ignoreMatch.js';

const ELIGIBLE_TYPES = new Set(['message', 'action']);

// The structural shape the engine needs; the DB HighlightRule satisfies it.
interface HighlightRule {
  id: number;
  enabled: boolean;
  pattern: string | null;
  mask?: string | null;
  channels?: string[] | null;
  kind: string;
  case_sensitive: boolean;
}

export interface CompiledRule {
  id: number;
  hasMask: boolean;
  matchesMask: (nick: string | null, userhost: string | null) => boolean;
  matchesChannel: (target: string) => boolean;
  // Predicate over the cleaned message text. A mask-only rule (no keyword) tests
  // always-true, so it highlights every in-scope message from the sender.
  test: (text: string) => boolean;
}

interface MatchableEvent {
  type: string;
  self?: boolean;
  text?: string | null;
  nick?: string | null;
  userhost?: string | null;
  target?: string;
}

export function compileRules(rules: HighlightRule[]): CompiledRule[] {
  const compiled: CompiledRule[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const hasMask = !!(rule.mask && rule.mask !== '*');
    // A rule must do something — carry a sender mask or a keyword pattern.
    if (!hasMask && !rule.pattern) continue;
    let test: (text: string) => boolean;
    if (!rule.pattern) {
      test = () => true;
    } else {
      const t = buildTextTest(rule.pattern, patternKindToTextKind(rule.kind), rule.case_sensitive);
      if (!t) continue; // invalid regex → drop the rule rather than throw
      test = t;
    }
    compiled.push({
      id: rule.id,
      hasMask,
      matchesMask: buildMaskMatcher(rule.mask ?? null),
      matchesChannel: buildChannelMatcher(rule.channels ?? null),
      test,
    });
  }
  return compiled;
}

export function matchEvent(
  event: MatchableEvent | null | undefined,
  compiled: CompiledRule[],
): { matched: boolean; ruleId: number | null } {
  // Cheapest guard first: with no rules there is nothing to match, so skip the
  // eligibility checks and text cleaning entirely.
  if (compiled.length === 0) return { matched: false, ruleId: null };
  if (!event || !ELIGIBLE_TYPES.has(event.type)) return { matched: false, ruleId: null };
  if (event.self) return { matched: false, ruleId: null };
  const target = event.target || '';
  const nick = event.nick ?? null;
  const userhost = event.userhost ?? null;
  // Clean the text lazily — a mask-only match never needs it.
  let cleaned: string | null = null;
  const text = () => (cleaned === null ? (cleaned = cleanForMatch(event.text || '')) : cleaned);
  for (const rule of compiled) {
    if (!rule.matchesChannel(target)) continue;
    if (rule.hasMask && !rule.matchesMask(nick, userhost)) continue;
    if (rule.test(text())) return { matched: true, ruleId: rule.id };
  }
  return { matched: false, ruleId: null };
}
