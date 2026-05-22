// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Slack-style `:shortcode:` emoji entry — the pure parsing + ranking helpers.
// These never carry the emoji table itself, so MessageInput can import them
// eagerly while the ~1,900-entry map in `emojiData.ts` stays a lazily-loaded
// chunk (see `loadEmoji` below).
//
// A shortcode is `:name:` where `name` is one or more of `[a-z0-9_+-]` — the
// gemoji character set (`:+1:`, `:e-mail:`, `:thumbsup:`). Matching is
// case-insensitive; gemoji names are lowercase, so a typed `:Bone:` resolves
// once the caller lowercases the captured name.
//
// The opening `:` must not sit immediately behind another shortcode
// character, so a clock like `12:00` or an `http://` URL never reads as a
// shortcode start. ASCII smileys fall out for free: `:-)` never closes at the
// caret because `)` isn't a shortcode character.

const NAME = '[a-z0-9_+-]+';
// `(?<![a-z0-9_+-])` keeps the opening colon off the back of a word or number.
const OPEN_RE = new RegExp(`(?<![a-z0-9_+-]):(${NAME})$`, 'i');
const CLOSE_RE = new RegExp(`(?<![a-z0-9_+-]):(${NAME}):$`, 'i');

export interface ShortcodeToken {
  /** The shortcode body, lowercased, colons stripped. */
  name: string;
  /** Index of the opening `:` in the source string. */
  start: number;
  /** Index just past the token — equal to the caret position passed in. */
  end: number;
}

// An *in-progress* shortcode ending at the caret: `:bo|` → { name: 'bo' }.
// Returns null when the caret isn't sitting in a shortcode body. Drives the
// suggester strip; the caller decides the minimum query length to act on.
export function findActiveShortcode(text: string, caret: number): ShortcodeToken | null {
  const m = OPEN_RE.exec(text.slice(0, caret));
  if (!m) return null;
  return { name: m[1].toLowerCase(), start: caret - m[1].length - 1, end: caret };
}

// A *complete* shortcode whose closing `:` is the character just before the
// caret — i.e. the user just typed the final `:` of `:bone:|`. Returns null
// otherwise. The caller still has to confirm `name` is a real emoji (via
// `emojiForShortcode`) before converting.
export function findCompletedShortcode(text: string, caret: number): ShortcodeToken | null {
  const m = CLOSE_RE.exec(text.slice(0, caret));
  if (!m) return null;
  return { name: m[1].toLowerCase(), start: caret - m[1].length - 2, end: caret };
}

// Rank shortcode `names` against `query` for the suggester. Matching is
// case-insensitive: an exact hit sorts first, then prefix matches, then
// substring matches; non-matches drop out. Within a tier the shorter name
// wins (a tighter match reads as more relevant), then alphabetical so the
// order is stable.
export function rankShortcodes(names: string[], query: string): string[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const scored: { name: string; rank: number }[] = [];
  for (const name of names) {
    const idx = name.indexOf(q);
    if (idx === -1) continue;
    scored.push({ name, rank: name === q ? 0 : idx === 0 ? 1 : 2 });
  }
  scored.sort(
    (a, b) => a.rank - b.rank || a.name.length - b.name.length || (a.name < b.name ? -1 : 1),
  );
  return scored.map((s) => s.name);
}

// Lazy gateway to the emoji table. The ~1,900-entry map is its own chunk; the
// first `:`-keystroke triggers the dynamic import and every later caller
// (suggester + inline auto-convert) shares this one cached promise. A failed
// import (offline, etc.) clears the cache so the next caller retries rather
// than being stuck with a permanently-rejected promise.
let emojiModule: Promise<typeof import('./emojiData.js')> | null = null;
export function loadEmoji(): Promise<typeof import('./emojiData.js')> {
  if (!emojiModule) {
    emojiModule = import('./emojiData.js');
    emojiModule.catch(() => {
      emojiModule = null;
    });
  }
  return emojiModule;
}
