// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';

/** A row from the `upload_history` table. */
export interface UploadHistoryRow {
  id: number;
  user_id: number;
  provider: string;
  url: string;
  filename: string | null;
  mime: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  thumbnail: Buffer | null;
  thumbnail_url: string | null;
  created_at: string;
}

/**
 * List row shape — omits the thumbnail blob, adds has_thumbnail flag. Carries
 * thumbnail_url so the API can prefer a remote CDN thumbnail (node edition) over
 * the local BLOB-serving route.
 */
export interface UploadListRow {
  id: number;
  provider: string;
  url: string;
  filename: string | null;
  mime: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  created_at: string;
  has_thumbnail: number;
  thumbnail_url: string | null;
}

/** Fields passed to insertUpload. */
export interface InsertUploadFields {
  provider: string;
  url: string;
  filename?: string | null;
  mime: string;
  byte_size: number;
  width?: number | null;
  height?: number | null;
  // Exactly one of thumbnail (inline BLOB, standalone) or thumbnail_url (remote
  // CDN object, node edition) is set; both null for thumbnail-less uploads (txt).
  thumbnail: Buffer | null;
  thumbnail_url?: string | null;
}

const insertStmt = db.prepare(`
  INSERT INTO upload_history
    (user_id, provider, url, filename, mime, byte_size, width, height, thumbnail, thumbnail_url)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function insertUpload(userId: number, row: InsertUploadFields): number {
  const info = insertStmt.run(
    userId,
    row.provider,
    row.url,
    row.filename ?? null,
    row.mime,
    row.byte_size,
    row.width ?? null,
    row.height ?? null,
    row.thumbnail,
    row.thumbnail_url ?? null,
  );
  return Number(info.lastInsertRowid);
}

export function listUploads(
  userId: number,
  { before = null, limit = 50 }: { before?: number | null; limit?: number } = {},
): UploadListRow[] {
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  // `has_thumbnail` lets the API decide whether to advertise a thumbnail_url
  // without ever shipping the (potentially large) blob in the list response.
  if (before) {
    return db
      .prepare(
        `
      SELECT id, provider, url, filename, mime, byte_size, width, height, created_at,
             thumbnail_url, (thumbnail IS NOT NULL) AS has_thumbnail
      FROM upload_history
      WHERE user_id = ? AND id < ?
      ORDER BY id DESC
      LIMIT ?
    `,
      )
      .all(userId, Number(before), lim) as UploadListRow[];
  }
  return db
    .prepare(
      `
    SELECT id, provider, url, filename, mime, byte_size, width, height, created_at,
           thumbnail_url, (thumbnail IS NOT NULL) AS has_thumbnail
    FROM upload_history
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT ?
  `,
    )
    .all(userId, lim) as UploadListRow[];
}

export function getThumbnail(userId: number, id: number): { thumbnail: Buffer | null } | undefined {
  return db
    .prepare(
      `
    SELECT thumbnail FROM upload_history
    WHERE user_id = ? AND id = ?
  `,
    )
    .get(userId, Number(id)) as { thumbnail: Buffer | null } | undefined;
}

export function deleteUpload(userId: number, id: number): boolean {
  const info = db
    .prepare(
      `
    DELETE FROM upload_history WHERE user_id = ? AND id = ?
  `,
    )
    .run(userId, Number(id));
  return info.changes > 0;
}
