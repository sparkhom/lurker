// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// One place to parse/normalize a channel-scope list so the /highlight parser,
// the settings pane, the service, and the DB layer agree on splitting, trimming,
// lowercasing (channel matching is case-insensitive), de-duping, and dropping
// blanks. Previously this logic was reimplemented four times with inconsistent
// casing.

// Normalize an array of channel names: trim, lowercase, drop blanks, dedupe.
// Non-string entries are ignored.
export function normalizeChannelList(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const c = (typeof v === 'string' ? v : '').trim().toLowerCase();
    if (c && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

// Parse a free-form channel list (comma- and/or space-separated) into a
// normalized array.
export function parseChannelList(input: string): string[] {
  return normalizeChannelList(input.split(/[\s,]+/));
}
