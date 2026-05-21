// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Shared URL detection. Pure, no DOM/Node deps — safe to import from the Vue
// renderer and the Node server alike. Two consumers rely on the *same*
// definition so they stay consistent:
//   - vue_client/src/utils/nickColor.ts — auto-links URLs in rendered messages
//   - server/services/highlightEngine.ts — excludes URLs from highlight word
//     matching, so a nick appearing inside a link doesn't trigger a highlight
//
// Covers http(s)/ftp(s)/mailto, bare www.* hosts, and bare email addresses.
// The body of a scheme/www match is "everything that isn't whitespace or an
// HTML-ish bracket". The email branch requires a real TLD (2+ letters) to
// avoid matching IRC-style host masks like `nick@server`.
export const URL_PATTERN_SOURCE =
  '(?:(?:https?|ftps?):\\/\\/|mailto:|www\\.)[^\\s<>`]+' +
  '|\\b[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9][A-Za-z0-9.-]*\\.[A-Za-z]{2,}\\b';

// A fresh regex per call — the `g` flag makes RegExp stateful via lastIndex,
// so a shared instance can't be reused safely across calls.
export function createUrlRegex(): RegExp {
  return new RegExp(URL_PATTERN_SOURCE, 'gi');
}
