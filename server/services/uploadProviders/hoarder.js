// Hoarder provider — the operator's own self-hosted file dropper at
// ~/Coding/hoarder, deployed at upload.bradroot.me. Authenticates via
// Authorization: Bearer <api_key> (support added in coordinated change to
// the Hoarder repo); returns JSON `{ id, ext, url, thumb_url, ... }` where
// `url` is already the public CDN URL.

import { USER_AGENT } from '../../utils/userAgent.js';

export const id = 'hoarder';
export const requiresSecrets = true;

export async function upload(buffer, { filename, mime }, secrets = {}) {
  if (!secrets.url) {
    const err = new Error('hoarder provider requires uploads.hoarder.url');
    err.code = 'PROVIDER_CONFIG';
    throw err;
  }
  if (!secrets.api_key) {
    const err = new Error('hoarder provider requires uploads.hoarder.api_key');
    err.code = 'PROVIDER_CONFIG';
    throw err;
  }

  const base = secrets.url.replace(/\/+$/, '');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), filename);

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
    const err = new Error(`hoarder upload failed: ${resp.status} ${text}`);
    err.code = resp.status === 401 ? 'PROVIDER_AUTH' : 'PROVIDER_ERROR';
    throw err;
  }
  const body = await resp.json().catch(() => null);
  if (!body || typeof body.url !== 'string') {
    const err = new Error('hoarder returned no url');
    err.code = 'PROVIDER_ERROR';
    throw err;
  }
  return { url: body.url };
}
