// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Parser for the /highlight command line (issue #349), modeled on irssi's
// /hilight but trimmed to the flags we support:
//
//   /highlight [-mask] [-full | -regexp] [-matchcase] [-network | -global]
//              [-channels <#a,#b>] <text|mask>
//
// irssi's -nick/-word/-line (which control *what* to colorize) are omitted — we
// always tint the whole line + sidebar dot. Lives in shared/ so the client
// command handler and parity tests use one implementation. Pure: no DOM/clock.
//
// The positional is the keyword by default, or a nick!user@host sender mask when
// -mask is given. Unlike /ignore, a leading '#' on a positional is NOT treated
// as a channel (a keyword may legitimately be "#release"); channel scope is only
// via -channels.

import { tokenize } from './parseIgnore.js';
import { parseChannelList } from './channels.js';

export type HighlightKind = 'substr' | 'full' | 'regex';

export interface ParsedHighlight {
  pattern: string | null;
  mask: string | null;
  channels: string[] | null;
  kind: HighlightKind;
  caseSensitive: boolean;
  // true = scope to the current network (-network); false (default) = global.
  scopeNetwork: boolean;
  error?: string;
}

export function parseHighlightArgs(argLine: string): ParsedHighlight {
  const base: ParsedHighlight = {
    pattern: null,
    mask: null,
    channels: null,
    kind: 'substr',
    caseSensitive: false,
    scopeNetwork: false,
  };
  const fail = (error: string): ParsedHighlight => ({ ...base, error });

  const tokens = tokenize(argLine.trim());
  const positionals: string[] = [];
  const channels: string[] = [];
  let isMask = false;
  let sawRegexp = false;
  let sawFull = false;
  // After a bare `--`, every remaining token is positional — lets a keyword that
  // begins with `-` (e.g. `/highlight -- -Werror`) through the flag parser.
  let endOfFlags = false;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const lower = t.toLowerCase();

    if (!endOfFlags && lower === '--') {
      endOfFlags = true;
      continue;
    }
    if (endOfFlags) {
      positionals.push(t);
      continue;
    }

    if (lower === '-mask') {
      isMask = true;
      continue;
    }
    if (lower === '-regexp' || lower === '-regex') {
      sawRegexp = true;
      continue;
    }
    if (lower === '-full' || lower === '-word') {
      sawFull = true;
      continue;
    }
    if (lower === '-matchcase' || lower === '-case') {
      base.caseSensitive = true;
      continue;
    }
    if (lower === '-network' || lower === '-net') {
      base.scopeNetwork = true;
      continue;
    }
    if (lower === '-global') {
      base.scopeNetwork = false;
      continue;
    }
    if (lower === '-channels' || lower === '-channel') {
      const val = tokens[++i];
      // A value that's missing or itself a flag (channels never start with '-')
      // means the user forgot the argument — don't silently swallow the next flag.
      if (val === undefined || val.startsWith('-')) return fail('-channels needs a value');
      for (const c of parseChannelList(val)) channels.push(c);
      continue;
    }
    if (t.startsWith('-') && t.length > 1) return fail(`unknown flag: ${t}`);

    positionals.push(t);
  }

  if (sawRegexp && sawFull) return fail('-regexp and -full are mutually exclusive');

  const value = positionals.join(' ').trim();
  if (!value) return fail(isMask ? 'a mask is required' : 'a pattern is required');

  base.kind = sawRegexp ? 'regex' : sawFull ? 'full' : 'substr';
  base.channels = channels.length ? channels : null;
  if (isMask) {
    base.mask = value;
  } else {
    base.pattern = value;
  }
  return base;
}
