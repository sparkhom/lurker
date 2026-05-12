// catbox.moe provider — anonymous, optional userhash for "logged-in" uploads
// that can later be deleted via the user's account. The response body is the
// bare URL on success or an error string on failure (200 in both cases for
// anonymous uploads, so we sniff the prefix).
//
// We use Node's built-in https module rather than native fetch (undici). Two
// observed issues with undici against catbox:
//   1. WHATWG FormData defaults to chunked Transfer-Encoding, which catbox's
//      PHP backend stalls reading.
//   2. Even with a hand-built body and explicit Content-Length, undici
//      occasionally surfaces a generic "fetch failed" with no useful cause,
//      while the same bytes via https.request succeed.
// Both go away when we hand the body off to https.request directly.

import { buildMultipart, postBuffer } from './multipart.js';
import { USER_AGENT } from '../../utils/userAgent.js';

const ENDPOINT = 'https://catbox.moe/user/api.php';
const TIMEOUT_MS = 60_000;

export const id = 'catbox';
export const requiresSecrets = false;

export async function upload(buffer, { filename, mime }, secrets = {}) {
  const parts = [{ name: 'reqtype', value: 'fileupload' }];
  if (secrets.userhash) parts.push({ name: 'userhash', value: secrets.userhash });
  parts.push({
    name: 'fileToUpload',
    filename,
    contentType: mime,
    value: buffer,
  });
  const { body, contentType } = buildMultipart(parts);

  let resp;
  try {
    resp = await postBuffer(ENDPOINT, body, {
      headers: {
        'Content-Type': contentType,
        'User-Agent': USER_AGENT,
        'Accept': '*/*',
      },
      timeoutMs: TIMEOUT_MS,
    });
  } catch (cause) {
    const detail = cause.code || cause.message || 'unknown error';
    const err = new Error(`catbox upload failed: ${detail}`);
    err.code = 'PROVIDER_ERROR';
    err.cause = cause;
    throw err;
  }

  const text = (resp.text || '').trim();
  if (resp.status < 200 || resp.status >= 300) {
    const err = new Error(`catbox upload failed: ${resp.status} ${text.slice(0, 200)}`);
    err.code = 'PROVIDER_ERROR';
    throw err;
  }
  if (!/^https?:\/\//.test(text)) {
    const err = new Error(`catbox refused upload: ${text.slice(0, 200)}`);
    err.code = 'PROVIDER_ERROR';
    throw err;
  }
  return { url: text };
}
