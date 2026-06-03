// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Hoarder provider — the operator's own self-hosted file dropper at
// ~/Coding/hoarder, deployed at upload.bradroot.me. Authenticates via
// Authorization: Bearer <api_key> (support added in coordinated change to
// the Hoarder repo); returns JSON `{ id, ext, url, thumb_url, ... }` where
// `url` is already the public CDN URL.

import { USER_AGENT } from '../../utils/userAgent.js';

export const id = 'hoarder';
export const requiresSecrets = true;

export async function upload(
  buffer: Buffer,
  { filename, mime, kind }: { filename: string; mime: string; kind?: string },
  secrets: { url?: string; api_key?: string } = {},
): Promise<{ url: string }> {
  if (!secrets.url) {
    throw Object.assign(new Error('hoarder provider requires uploads.hoarder.url'), {
      code: 'PROVIDER_CONFIG',
    });
  }
  if (!secrets.api_key) {
    throw Object.assign(new Error('hoarder provider requires uploads.hoarder.api_key'), {
      code: 'PROVIDER_CONFIG',
    });
  }

  const base = secrets.url.replace(/\/+$/, '');
  const form = new FormData();
  // Text fields before the file so multipart parsers populate req.body reliably.
  if (kind) form.append('kind', kind);
  form.append('file', new Blob([new Uint8Array(buffer)], { type: mime }), filename);

  const resp = await fetch(`${base}/api/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secrets.api_key}`,
      'User-Agent': USER_AGENT,
    },
    body: form,
  });

  if (!resp.ok) {
    const text = (await resp.text()).slice(0, 200);
    throw Object.assign(new Error(`hoarder upload failed: ${resp.status} ${text}`), {
      code: resp.status === 401 ? 'PROVIDER_AUTH' : 'PROVIDER_ERROR',
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = (await resp.json().catch(() => null)) as any;
  if (!body || typeof body.url !== 'string') {
    throw Object.assign(new Error('hoarder returned no url'), { code: 'PROVIDER_ERROR' });
  }
  return { url: body.url as string };
}
