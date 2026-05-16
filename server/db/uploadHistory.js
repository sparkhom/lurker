// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import db from './index.js';

const insertStmt = db.prepare(`
  INSERT INTO upload_history
    (user_id, provider, url, filename, mime, byte_size, width, height, thumbnail)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function insertUpload(userId, row) {
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
  );
  return info.lastInsertRowid;
}

export function listUploads(userId, { before = null, limit = 50 } = {}) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  // `has_thumbnail` lets the API decide whether to advertise a thumbnail_url
  // without ever shipping the (potentially large) blob in the list response.
  if (before) {
    return db.prepare(`
      SELECT id, provider, url, filename, mime, byte_size, width, height, created_at,
             (thumbnail IS NOT NULL) AS has_thumbnail
      FROM upload_history
      WHERE user_id = ? AND id < ?
      ORDER BY id DESC
      LIMIT ?
    `).all(userId, Number(before), lim);
  }
  return db.prepare(`
    SELECT id, provider, url, filename, mime, byte_size, width, height, created_at,
           (thumbnail IS NOT NULL) AS has_thumbnail
    FROM upload_history
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(userId, lim);
}

export function getThumbnail(userId, id) {
  return db.prepare(`
    SELECT thumbnail FROM upload_history
    WHERE user_id = ? AND id = ?
  `).get(userId, Number(id));
}

export function deleteUpload(userId, id) {
  const info = db.prepare(`
    DELETE FROM upload_history WHERE user_id = ? AND id = ?
  `).run(userId, Number(id));
  return info.changes > 0;
}
