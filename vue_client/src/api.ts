// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

/** An Error thrown by `api()` / `apiMultipart()` on a non-2xx response. */
export interface ApiError extends Error {
  status?: number;
  data?: unknown;
}

export interface ApiRequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

// The API speaks untyped JSON, so the response type defaults to `any`. Callers
// that want a checked shape can pass it explicitly: `api<{ user: User }>(url)`.
export async function api<T = any>(
  url: string,
  { method = 'GET', body, headers }: ApiRequestOptions = {},
): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: any = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const message = (data && data.error) || res.statusText || 'request failed';
    const err = new Error(message) as ApiError;
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data as T;
}

export interface MultipartOptions {
  onProgress?: (percent: number) => void;
}

// XHR-backed multipart upload so callers get real upload-progress events.
// fetch() can't expose request-side progress in any browser today, hence the
// XHR fallback. Returns a Promise that resolves to the parsed JSON body.
export function apiMultipart<T = any>(
  url: string,
  formData: FormData,
  { onProgress }: MultipartOptions = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.withCredentials = true;
    xhr.responseType = 'text';
    xhr.upload.addEventListener('progress', (e) => {
      if (!onProgress || !e.lengthComputable) return;
      onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
    });
    xhr.addEventListener('load', () => {
      const text = xhr.responseText || '';
      let data: any = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data as T);
      } else {
        const message = (data && data.error) || xhr.statusText || 'upload failed';
        const err = new Error(message) as ApiError;
        err.status = xhr.status;
        err.data = data;
        reject(err);
      }
    });
    xhr.addEventListener('error', () => reject(new Error('network error')));
    xhr.addEventListener('abort', () => reject(new Error('upload aborted')));
    xhr.send(formData);
  });
}
