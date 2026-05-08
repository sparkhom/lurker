// Deterministic nick coloring. Mirrors weechat's gui_nick_find_color:
// trim stop chars, lowercase, hash, modulo a palette.
//
// Palette and stop-chars come from settings (look.nick.colors,
// look.nick.color_stop_chars); see vue_client/src/utils/settingsRegistry.js.

function trimForColor(nick, stopChars) {
  let out = '';
  let seenOther = false;
  for (const ch of nick) {
    const isStop = stopChars.includes(ch);
    if (isStop && seenOther) break;
    if (!isStop) seenOther = true;
    out += ch;
  }
  return out;
}

function djb2(str) {
  let h = 5381 >>> 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    const term = (((h << 5) >>> 0) + (h >>> 2) + cp) >>> 0;
    h = (h ^ term) >>> 0;
  }
  return h;
}

export function nickColor(nick, { palette, stopChars }) {
  if (!nick) return null;
  if (!palette || palette.length === 0) return null;
  const normalized = trimForColor(nick, stopChars || '').toLowerCase();
  if (!normalized) return null;
  return palette[djb2(normalized) % palette.length];
}

// Chars that can appear inside an IRC nick (RFC 2812 plus the usual extensions).
// A match against `nickSet` only counts when neither neighbour is one of these,
// so "bob" inside "bobby" won't match.
const NICK_CHAR_CLASS = '[A-Za-z0-9_\\-\\[\\]\\\\^{|}]';

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Split `text` into [{text, color?, self?}] segments, coloring any occurrence
// of a nick from `nickSet`. Comparison is case-insensitive; the matched casing
// is preserved in the rendered text. `colorFn` is `(nick) => string|null`.
export function splitTextByNicks(text, nickSet, selfLower, colorFn) {
  if (!text) return [{ text: '' }];
  if (!nickSet || nickSet.size === 0) return [{ text }];

  const nicks = [...nickSet].filter(Boolean);
  if (nicks.length === 0) return [{ text }];
  // Longest first so "alibaba" wins over "ali" in alternation.
  nicks.sort((a, b) => b.length - a.length);
  const alternation = nicks.map(escapeRegex).join('|');
  const pattern = new RegExp(
    `(?<!${NICK_CHAR_CLASS})(?:${alternation})(?!${NICK_CHAR_CLASS})`,
    'gi',
  );

  const out = [];
  let lastIdx = 0;
  let m;
  while ((m = pattern.exec(text)) !== null) {
    const matched = m[0];
    const start = m.index;
    if (start > lastIdx) out.push({ text: text.slice(lastIdx, start) });
    const lower = matched.toLowerCase();
    const isSelf = selfLower && lower === selfLower;
    out.push({
      text: matched,
      color: isSelf ? null : (colorFn ? colorFn(matched) : null),
      self: !!isSelf,
    });
    lastIdx = start + matched.length;
  }
  if (lastIdx < text.length) out.push({ text: text.slice(lastIdx) });
  return out;
}
