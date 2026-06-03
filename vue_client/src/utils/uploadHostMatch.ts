// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp'] as const;
const HARDCODED_HOSTS = new Set(['x0.at', 'files.catbox.moe']);

export function isUploadImageUrl(rawUrl: string, hoarderUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  const host = parsed.host.toLowerCase();
  const hoarderHost = parseHoarderHost(hoarderUrl);
  const hostMatches = HARDCODED_HOSTS.has(host) || (hoarderHost !== null && host === hoarderHost);
  if (!hostMatches) return false;

  const path = parsed.pathname.toLowerCase();
  return IMAGE_EXTS.some((ext) => path.endsWith(ext));
}

function parseHoarderHost(hoarderUrl: string): string | null {
  if (!hoarderUrl) return null;
  try {
    return new URL(hoarderUrl).host.toLowerCase();
  } catch {
    return null;
  }
}
