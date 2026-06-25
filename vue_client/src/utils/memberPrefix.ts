// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Channel user-mode prefixes, highest rank first. Shared by the member list,
// the self-identity prompt, and the message list so the @/+/%/~/& glyph stays
// consistent everywhere it appears.
//
// NOTE: the q/a/o/h/v → ~/&/@/%/+ mapping is the conventional RFC/ISUPPORT
// default and is hardcoded fleet-wide; we don't yet read a network's ISUPPORT
// PREFIX, so a server that diverges from the standard ordering won't be honored.
export const PREFIX_ORDER: readonly string[] = ['~', '&', '@', '%', '+', ''];

const PREFIX_GLYPH: Record<string, string> = { q: '~', a: '&', o: '@', h: '%', v: '+' };
// Highest mode wins; ranked owner > admin > op > halfop > voice.
const PREFIX_RANK = ['q', 'a', 'o', 'h', 'v'];

// The single highest-ranked prefix glyph for a set of channel modes, or '' when
// the member holds none.
export function prefixOf(modes: string[] | null | undefined): string {
  if (!Array.isArray(modes)) return '';
  for (const letter of PREFIX_RANK) {
    if (modes.includes(letter)) return PREFIX_GLYPH[letter];
  }
  return '';
}

// CSS class for the glyph color (e.g. `mode-@`), or '' when there's no prefix.
export function prefixClass(modes: string[] | null | undefined): string {
  const p = prefixOf(modes);
  return p ? `mode-${p}` : '';
}
