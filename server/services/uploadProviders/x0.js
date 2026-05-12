// x0.at provider — anonymous, no auth, accepts multipart `file`. The response
// body is the bare URL with a trailing newline.

import { USER_AGENT } from '../../utils/userAgent.js';

const ENDPOINT = 'https://x0.at/';

export const id = 'x0';
export const requiresSecrets = false;

export async function upload(buffer, { filename, mime }) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), filename);

  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT },
    body: form,
  });
  const text = (await resp.text()).trim();
  if (!resp.ok) {
    const err = new Error(`x0.at upload failed: ${resp.status} ${text.slice(0, 200)}`);
    err.code = 'PROVIDER_ERROR';
    throw err;
  }
  if (!/^https?:\/\//.test(text)) {
    const err = new Error(`x0.at unexpected response: ${text.slice(0, 200)}`);
    err.code = 'PROVIDER_ERROR';
    throw err;
  }
  return { url: text };
}
