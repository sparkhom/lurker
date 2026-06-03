// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import * as x0 from './x0.js';
import * as catbox from './catbox.js';
import * as hoarder from './hoarder.js';

/** Shared shape every upload provider must satisfy. */
export interface UploadProvider {
  id: string;
  requiresSecrets: boolean;
  upload(
    buffer: Buffer,
    // `kind` is an optional hint forwarded to the in-house dropper so a thumbnail
    // lands under a `thumbs/` prefix. Hosts that don't understand it ignore the
    // extra form field.
    meta: { filename: string; mime: string; kind?: string },
    secrets?: Record<string, string>,
  ): Promise<{ url: string }>;
}

const PROVIDERS: Record<string, UploadProvider> = {
  [x0.id]: x0,
  [catbox.id]: catbox,
  [hoarder.id]: hoarder,
};

export const providerIds = Object.keys(PROVIDERS);

export function getProvider(id: string): UploadProvider | null {
  return PROVIDERS[id] ?? null;
}

// Lift the relevant per-user settings into a flat secrets object for the
// chosen provider. The router calls this rather than passing the raw settings
// object so each provider only sees what it needs.
export function secretsForProvider(
  id: string,
  userSettings: Record<string, string>,
): Record<string, string> {
  switch (id) {
    case 'catbox':
      return { userhash: userSettings['uploads.catbox.userhash'] || '' };
    case 'hoarder':
      return {
        url: userSettings['uploads.hoarder.url'] || '',
        api_key: userSettings['uploads.hoarder.api_key'] || '',
      };
    default:
      return {};
  }
}
