// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { createUrlRegex } from '../../shared/urlPattern.js';

const ELIGIBLE_TYPES = new Set(['message', 'action']);

interface HighlightRule {
  id: number;
  enabled: boolean;
  pattern: string;
  kind: string;
  case_sensitive: boolean;
}

export interface CompiledRule {
  id: number;
  test: (text: string) => boolean;
}

interface MatchableEvent {
  type: string;
  self?: boolean;
  text?: string;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegexSource(pattern: string): string {
  let out = '';
  for (const ch of pattern) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += escapeRegex(ch);
  }
  return out;
}

function buildTest(rule: HighlightRule): ((text: string) => boolean) | null {
  const flags = rule.case_sensitive ? '' : 'i';
  let source: string;
  if (rule.kind === 'regex') {
    source = rule.pattern;
  } else if (rule.kind === 'glob') {
    source = `(?:^|\\W)(?:${globToRegexSource(rule.pattern)})(?=\\W|$)`;
  } else {
    source = `(?:^|\\W)(?:${escapeRegex(rule.pattern)})(?=\\W|$)`;
  }
  try {
    const re = new RegExp(source, flags);
    return (text: string) => re.test(text);
  } catch {
    return null;
  }
}

export function compileRules(rules: HighlightRule[]): CompiledRule[] {
  const compiled: CompiledRule[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!rule.pattern) continue;
    const test = buildTest(rule);
    if (!test) continue;
    compiled.push({ id: rule.id, test });
  }
  return compiled;
}

// Blank out URLs before matching so a highlight word inside a link — e.g. a
// nick that happens to appear in `https://example.com/nick` — doesn't trigger
// a highlight. The URL is replaced with a space (not removed) so the words on
// either side can't fuse into a false match. Uses the same URL definition the
// client uses to auto-link, so "renders as a link" and "ignored for
// highlights" stay in lockstep.
function stripUrls(text: string): string {
  return text.replace(createUrlRegex(), ' ');
}

export function matchEvent(
  event: MatchableEvent | null | undefined,
  compiled: CompiledRule[],
): { matched: boolean; ruleId: number | null } {
  // Cheapest guard first: with no rules there is nothing to match, so skip
  // the eligibility checks and URL-stripping work entirely.
  if (compiled.length === 0) return { matched: false, ruleId: null };
  if (!event || !ELIGIBLE_TYPES.has(event.type)) return { matched: false, ruleId: null };
  if (event.self) return { matched: false, ruleId: null };
  const text = event.text || '';
  if (!text) return { matched: false, ruleId: null };
  const cleaned = stripUrls(text);
  for (const { id, test } of compiled) {
    if (test(cleaned)) return { matched: true, ruleId: id };
  }
  return { matched: false, ruleId: null };
}
