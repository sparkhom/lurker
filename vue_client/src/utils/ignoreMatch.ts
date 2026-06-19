// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Client mirror of server/services/ignoreMatch.ts (issue #301). The server runs
// the same logic at insert time (highlight suppression + hidden stamp + push
// gate); the client runs it at render time (MessageList filter + nohilight
// styling + MemberList). ANY change here must land in the server copy too, or
// "hidden on this device" and "stamped hidden server-side" diverge.

import { createUrlRegex } from '../../../shared/urlPattern.js';
import { LEVEL_DEFS, ALL_TYPES, HIGHLIGHTABLE } from '../../../shared/ignoreLevels.js';

// Level vocabulary lives in shared/ignoreLevels.ts (single source for server,
// client, parser). Re-export the helpers the store/parser pull from here.
export { KNOWN_LEVELS, canonicalLevel, canonicalizeLevels } from '../../../shared/ignoreLevels.js';

// ---- text matching (mirror of textMatch.buildTextTest) ---------------------

type TextKind = 'substr' | 'plain' | 'glob' | 'regex';

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

function buildTextTest(
  pattern: string,
  kind: TextKind,
  caseSensitive: boolean,
): ((text: string) => boolean) | null {
  if (kind === 'substr') {
    if (caseSensitive) return (text: string) => text.includes(pattern);
    const needle = pattern.toLowerCase();
    return (text: string) => text.toLowerCase().includes(needle);
  }
  const flags = caseSensitive ? '' : 'i';
  let source: string;
  if (kind === 'regex') source = pattern;
  else if (kind === 'glob') source = `(?:^|\\W)(?:${globToRegexSource(pattern)})(?=\\W|$)`;
  else source = `(?:^|\\W)(?:${escapeRegex(pattern)})(?=\\W|$)`;
  try {
    const re = new RegExp(source, flags);
    return (text: string) => re.test(text);
  } catch {
    return null;
  }
}

function stripUrls(text: string): string {
  return text.replace(createUrlRegex(), ' ');
}

// ---- mask glob (mirror; bare nick globs) -----------------------------------

function splitMask(mask: string): { nick: string; user: string; host: string } {
  let nick = '*';
  let user = '*';
  let host = '*';
  const atIdx = mask.indexOf('@');
  let pre = mask;
  if (atIdx !== -1) {
    pre = mask.slice(0, atIdx);
    host = mask.slice(atIdx + 1) || '*';
  }
  const bangIdx = pre.indexOf('!');
  if (bangIdx !== -1) {
    nick = pre.slice(0, bangIdx) || '*';
    user = pre.slice(bangIdx + 1) || '*';
  } else if (atIdx !== -1) {
    user = pre || '*';
  } else {
    nick = pre || '*';
  }
  return { nick, user, host };
}

function globToRegex(pattern: string, caseInsensitive: boolean): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$', caseInsensitive ? 'i' : '');
}

// ---- rule shape + evaluation -----------------------------------------------

export interface IgnoreRule {
  id?: number;
  mask: string | null;
  channels: string[] | null;
  pattern: string | null;
  patternKind: 'substr' | 'full' | 'regex';
  levels: string[];
  isExcept: boolean;
  expiresAt: string | null;
}

export interface IgnoreInput {
  nick: string | null;
  userhost: string | null;
  target: string;
  text: string;
  type: string;
  isDm: boolean;
}

export interface IgnoreVerdict {
  hide: boolean;
  nohilight: boolean;
}

interface CompiledIgnoreRule {
  isExcept: boolean;
  maskLen: number;
  expiresAt: number | null;
  hides: boolean;
  nohilight: boolean;
  pattern: boolean; // has a content pattern (used by member-list gating)
  channels: boolean; // is channel-scoped
  hasAll: boolean;
  matchesNick: (nick: string | null, userhost: string | null) => boolean;
  matchesChannel: (target: string) => boolean;
  matchesText: (text: string) => boolean;
  hideLevel: (type: string, isDm: boolean) => boolean;
}

function patternKindToTextKind(kind: string): TextKind {
  if (kind === 'regex') return 'regex';
  if (kind === 'full') return 'plain';
  return 'substr';
}

export function compileIgnoreRules(rules: IgnoreRule[]): CompiledIgnoreRule[] {
  const out: CompiledIgnoreRule[] = [];
  for (const rule of rules) {
    const hasNohilight = rule.levels.includes('NOHIGHLIGHT');
    const hideLevels = rule.levels.filter((l) => l !== 'NOHIGHLIGHT');
    const hasAll = hideLevels.includes('ALL');
    const hides = hideLevels.length > 0;

    let matchesNick: (nick: string | null, userhost: string | null) => boolean;
    if (!rule.mask || rule.mask === '*') {
      matchesNick = () => true;
    } else if (rule.mask.includes('!') || rule.mask.includes('@')) {
      const { nick, user, host } = splitMask(rule.mask);
      const nickRe = globToRegex(nick, true);
      const userRe = globToRegex(user, false);
      const hostRe = globToRegex(host, false);
      matchesNick = (n, uh) => {
        if (!n || !nickRe.test(n)) return false;
        if (!uh) return user === '*' && host === '*';
        const bang = uh.indexOf('!');
        const at = uh.indexOf('@', bang + 1);
        if (bang === -1 || at === -1) return user === '*' && host === '*';
        return userRe.test(uh.slice(bang + 1, at)) && hostRe.test(uh.slice(at + 1));
      };
    } else {
      const nickRe = globToRegex(rule.mask, true);
      matchesNick = (n) => !!n && nickRe.test(n);
    }

    let matchesChannel: (target: string) => boolean;
    if (!rule.channels || rule.channels.length === 0) {
      matchesChannel = () => true;
    } else {
      const res = rule.channels.map((c) => globToRegex(c, true));
      matchesChannel = (t) => !!t && res.some((re) => re.test(t));
    }

    let matchesText: (text: string) => boolean;
    if (!rule.pattern) {
      matchesText = () => true;
    } else {
      const test = buildTextTest(rule.pattern, patternKindToTextKind(rule.patternKind), false);
      matchesText = test ?? (() => false);
    }

    const hideLevel = (type: string, isDm: boolean): boolean => {
      if (hasAll) return ALL_TYPES.has(type);
      for (const lvl of hideLevels) {
        const def = LEVEL_DEFS[lvl];
        if (!def) continue;
        if (def.types.includes(type) && (def.dm === undefined || def.dm === isDm)) return true;
      }
      return false;
    };

    out.push({
      isExcept: rule.isExcept,
      maskLen: rule.mask ? rule.mask.length : 0,
      expiresAt: rule.expiresAt ? Date.parse(rule.expiresAt) : null,
      hides,
      nohilight: hasNohilight,
      pattern: !!rule.pattern,
      channels: !!(rule.channels && rule.channels.length),
      hasAll,
      matchesNick,
      matchesChannel,
      matchesText,
      hideLevel,
    });
  }
  return out;
}

export function evaluateIgnores(
  compiled: CompiledIgnoreRule[],
  input: IgnoreInput,
  now: number = Date.now(),
): IgnoreVerdict {
  if (compiled.length === 0) return { hide: false, nohilight: false };
  const { nick, userhost, target, type, isDm } = input;
  const text = input.text ? stripUrls(input.text) : '';

  let bestHide = -1;
  let bestHideExcept = -1;
  let bestNo = -1;
  let bestNoExcept = -1;

  for (const r of compiled) {
    if (r.expiresAt !== null && r.expiresAt <= now) continue;
    const hideApplies = r.hides && r.hideLevel(type, isDm);
    const noApplies =
      r.nohilight && HIGHLIGHTABLE.has(type) && (r.hides ? r.hideLevel(type, isDm) : true);
    if (!hideApplies && !noApplies) continue;
    if (!r.matchesNick(nick, userhost)) continue;
    if (!r.matchesChannel(target)) continue;
    if (!r.matchesText(text)) continue;

    if (hideApplies) {
      if (r.isExcept) {
        if (r.maskLen > bestHideExcept) bestHideExcept = r.maskLen;
      } else if (r.maskLen > bestHide) {
        bestHide = r.maskLen;
      }
    }
    if (noApplies) {
      if (r.isExcept) {
        if (r.maskLen > bestNoExcept) bestNoExcept = r.maskLen;
      } else if (r.maskLen > bestNo) {
        bestNo = r.maskLen;
      }
    }
  }

  return {
    hide: bestHide >= 0 && bestHideExcept < bestHide,
    nohilight: bestNo >= 0 && bestNoExcept < bestNo,
  };
}

// A nicklist row carries only a nick/userhost — no message text or type. Hide a
// member only when a rule would erase their whole presence regardless of
// content: a non-except, no-pattern, ALL-level rule scoped to all buffers or the
// open channel. Pattern / single-level / NOHIGHLIGHT rules must NOT drop someone
// from the nicklist (they're still present and talking).
export function isMemberHidden(
  compiled: CompiledIgnoreRule[],
  nick: string,
  userhost: string | null,
  channel: string,
): boolean {
  for (const r of compiled) {
    if (r.isExcept || r.pattern || !r.hasAll) continue;
    if (r.expiresAt !== null && r.expiresAt <= Date.now()) continue;
    if (!r.matchesChannel(channel)) continue;
    if (r.matchesNick(nick, userhost)) return true;
  }
  return false;
}
