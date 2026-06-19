// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// irssi-style ignore matcher (issue #301). A rule AND-s optional dimensions:
//   who    — mask (NULL/'*' = anyone; bare nick globs the nick, nick!user@host
//            globs the hostmask)
//   where  — channels (NULL = all buffers; else any channel glob matches target)
//   what   — pattern (NULL = any text; substring/full-word/regex on the body)
//   which  — levels (event-type tokens, plus the special NOHIGHLIGHT)
// is_except inverts a rule into a whitelist entry resolved by longest-mask-wins.
//
// This file is mirrored by vue_client/src/utils/ignoreMatch.ts — the client runs
// the same logic at render time, the server runs it at insert time (highlight
// suppression + hidden stamp) and to gate web-push. Any change must land in both.

import { buildTextTest, stripUrls, type TextKind } from './textMatch.js';
import type { IgnoreRuleRow } from '../db/ignoredMasks.js';
import { LEVEL_DEFS, ALL_TYPES, HIGHLIGHTABLE } from '../../shared/ignoreLevels.js';

// Level vocabulary (LEVEL_DEFS / aliases / canonicalize) lives in
// shared/ignoreLevels.ts so server, client, and the parser never drift.
export { KNOWN_LEVELS, canonicalLevel, canonicalizeLevels } from '../../shared/ignoreLevels.js';

// ---- mask / glob helpers (bare-nick now globs, unlike the old maskMatch) ----

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

// ---- compiled rule + evaluation --------------------------------------------

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

export interface CompiledIgnoreRule {
  isExcept: boolean;
  maskLen: number;
  expiresAt: number | null;
  hides: boolean; // has a real hide level (incl. ALL)
  nohilight: boolean; // carries NOHIGHLIGHT
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

export function compileIgnoreRules(rules: IgnoreRuleRow[]): CompiledIgnoreRule[] {
  const out: CompiledIgnoreRule[] = [];
  for (const rule of rules) {
    const hasNohilight = rule.levels.includes('NOHIGHLIGHT');
    const hideLevels = rule.levels.filter((l) => l !== 'NOHIGHLIGHT');
    const hasAll = hideLevels.includes('ALL');
    const hides = hideLevels.length > 0;

    // who
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
      // bare nick — now a glob (was exact match before #301)
      const nickRe = globToRegex(rule.mask, true);
      matchesNick = (n) => !!n && nickRe.test(n);
    }

    // where
    let matchesChannel: (target: string) => boolean;
    if (!rule.channels || rule.channels.length === 0) {
      matchesChannel = () => true;
    } else {
      const res = rule.channels.map((c) => globToRegex(c, true));
      matchesChannel = (t) => !!t && res.some((re) => re.test(t));
    }

    // what
    let matchesText: (text: string) => boolean;
    if (!rule.pattern) {
      matchesText = () => true;
    } else {
      const test = buildTextTest(rule.pattern, patternKindToTextKind(rule.patternKind), false);
      matchesText = test ?? (() => false);
    }

    // which (hide levels)
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
      matchesNick,
      matchesChannel,
      matchesText,
      hideLevel,
    });
  }
  return out;
}

// Resolve to a {hide, nohilight} verdict. irssi runs a separate pass per flag,
// each picking the longest-mask applying rule and favoring -except on a tie; we
// mirror that with paired (rule, except) length trackers. (irssi's secondary
// pattern-length tiebreak on equal mask length is not ported — the realistic
// "broad hide + specific except" case differs in mask length.)
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
    // Cheapest gate first: does this rule's level set touch this event?
    const hideApplies = r.hides && r.hideLevel(type, isDm);
    const noApplies =
      r.nohilight && HIGHLIGHTABLE.has(type) && (r.hides ? r.hideLevel(type, isDm) : true);
    if (!hideApplies && !noApplies) continue;
    // who / where / what (more expensive — only now that a level matched)
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

  // A tie (equal mask length) favors the whitelist: except < hide must hold.
  return {
    hide: bestHide >= 0 && bestHideExcept < bestHide,
    nohilight: bestNo >= 0 && bestNoExcept < bestNo,
  };
}
