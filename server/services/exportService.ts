// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Per-user data export. Streams a zip to a writable destination (typically
// the HTTP response). Driven entirely by EXPORT_TABLES — if a table is
// declared as exported there, it lands in the zip; if it's declared as
// skipped, it doesn't. The schema tripwire in exportSchema.test.js
// guarantees the registry covers every live table.

import type { Writable } from 'stream';
import { Readable } from 'stream';
import { ZipArchive } from 'archiver';
import db from '../db/index.js';
import { EXPORT_TABLES, EXPORT_FORMAT_VERSION } from '../db/exportSchema.js';
import { ENCRYPTED_NETWORK_COLUMNS } from '../db/networks.js';
import { decryptSecret } from '../utils/secretCrypto.js';

interface ExportTableDefWithScope {
  scope: string;
  columns: string[];
  mode: string;
  section?: string;
  pk?: string;
  blobColumns?: string[];
  rekeyOnImport?: boolean;
  fkRekey?: Record<string, string>;
}

// SQL fragment that filters a table to a single user's rows. Returned as
// `{ where, params }` so callers can splice it into a SELECT.
function scopeFilter(scope: string, userId: number): { where: string; params: number[] } {
  switch (scope) {
    case 'identity':
      return { where: 'WHERE id = ?', params: [userId] };
    case 'user_id':
      return { where: 'WHERE user_id = ?', params: [userId] };
    case 'via_network':
      return {
        where: 'WHERE network_id IN (SELECT id FROM networks WHERE user_id = ?)',
        params: [userId],
      };
    case 'via_rules':
      return {
        where: 'WHERE rule_id IN (SELECT id FROM highlight_rules WHERE user_id = ?)',
        params: [userId],
      };
    default:
      throw new Error(`exportService: unknown scope "${scope}"`);
  }
}

function countRows(table: string, scope: string, userId: number): number {
  const { where, params } = scopeFilter(scope, userId);
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get(...params) as { n: number })
    .n;
}

// Project a row into the shape that lands in the export. Strips BLOB columns
// (they get written to thumbnails/<id>.<ext> separately) and replaces them
// with a hasThumbnail flag so the importer knows to look for the file.
function projectRow(
  row: Record<string, unknown>,
  def: ExportTableDefWithScope,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of def.columns) {
    if (def.blobColumns?.includes(col)) continue;
    out[col] = row[col];
  }
  if (def.blobColumns?.includes('thumbnail')) {
    out.hasThumbnail = row.thumbnail != null;
  }
  return out;
}

function* messagesNdjsonGenerator(
  userId: number,
  networkIdToCount: { total: number },
): Generator<string> {
  const def = EXPORT_TABLES.messages as ExportTableDefWithScope;
  const { where, params } = scopeFilter(def.scope, userId);
  const cols = def.columns.join(', ');
  const cursor = db
    .prepare(`SELECT ${cols} FROM messages ${where} ORDER BY id ASC`)
    .iterate(...params);
  for (const row of cursor) {
    networkIdToCount.total += 1;
    yield JSON.stringify(projectRow(row as Record<string, unknown>, def)) + '\n';
  }
}

function selectAll(
  table: string,
  def: ExportTableDefWithScope,
  userId: number,
): Record<string, unknown>[] {
  const { where, params } = scopeFilter(def.scope, userId);
  const cols = def.columns.join(', ');
  const order = def.pk ? `ORDER BY ${def.pk} ASC` : '';
  return db.prepare(`SELECT ${cols} FROM ${table} ${where} ${order}`).all(...params) as Record<
    string,
    unknown
  >[];
}

export function computeExportPreview(
  userId: number,
  { includeMessages = false } = {},
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [table, def] of Object.entries(EXPORT_TABLES)) {
    const d = def as ExportTableDefWithScope;
    if (d.mode !== 'export' && d.mode !== 'partial') continue;
    if (d.section === 'messages' && !includeMessages) {
      counts[table] = 0;
      continue;
    }
    if (d.section === 'bookmarks' && !includeMessages) {
      counts[table] = 0;
      continue;
    }
    counts[table] = countRows(table, d.scope, userId);
  }
  return counts;
}

function getSchemaVersion(): number {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  return row ? parseInt(row.value, 10) || 0 : 0;
}

// Build the export zip and stream it to `destStream`. Resolves when the
// archive has been finalized (every byte is in destStream's buffer or
// further downstream). Rejects if archiver emits an error.
//
// The destination is typically the express `res` object; the caller is
// responsible for setting Content-Type and Content-Disposition before
// calling this. We don't set them here so the function is reusable from
// tests that pipe into a `PassThrough`.
export async function buildExportZip(
  userId: number,
  { includeMessages = false } = {},
  destStream: Writable,
): Promise<void> {
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const archiveDone = new Promise<void>((resolve, reject) => {
    archive.on('error', reject);
    archive.on('warning', (err) => {
      // ENOENT warnings from archiver are non-fatal but we surface anything else.
      if (err.code !== 'ENOENT') reject(err);
    });
    destStream.on('error', reject);
    destStream.on('finish', resolve);
    destStream.on('close', resolve);
  });

  archive.pipe(destStream);

  const sections: string[] = ['data'];
  const counts: Record<string, number> = {};

  // ---- data.json: everything except messages, bookmarks. ----
  const data: Record<string, unknown[]> = {};
  for (const [table, def] of Object.entries(EXPORT_TABLES)) {
    const d = def as ExportTableDefWithScope;
    if (d.mode !== 'export' && d.mode !== 'partial') continue;
    if (d.section && d.section !== 'data') continue;
    const rows = selectAll(table, d, userId);
    // Network secrets live encrypted at rest on hosted cells; decrypt them so
    // the export is portable plaintext (restorable on a self-host without the
    // key) — same content the user sees in the app. No-op on a self-host
    // (values are already plaintext).
    if (table === 'networks') {
      for (const row of rows) {
        for (const col of ENCRYPTED_NETWORK_COLUMNS) {
          row[col] = decryptSecret(row[col] as string | null);
        }
      }
    }
    data[table] = rows.map((row) => projectRow(row, d));
    counts[table] = rows.length;

    // Thumbnails — emit each blob as a separate zip entry.
    if (d.blobColumns?.includes('thumbnail')) {
      for (const row of rows) {
        if (row.thumbnail != null) {
          archive.append(row.thumbnail as Buffer, { name: `thumbnails/${row.id as number}.jpg` });
        }
      }
    }
  }

  // ---- messages.ndjson ----
  if (includeMessages) {
    sections.push('messages');
    const totalRef = { total: 0 };
    const messagesStream = Readable.from(messagesNdjsonGenerator(userId, totalRef), {
      encoding: 'utf8',
    });
    archive.append(messagesStream, { name: 'messages.ndjson' });
    // We populate counts.messages from the registry preview, since the
    // generator-based count is only known after the stream drains. The
    // preview path uses COUNT(*) which is cheap for any indexed selection.
    counts.messages = countRows(
      'messages',
      (EXPORT_TABLES.messages as ExportTableDefWithScope).scope,
      userId,
    );

    // ---- bookmarks.json ----
    sections.push('bookmarks');
    const bookmarksDef = EXPORT_TABLES.user_bookmarks as ExportTableDefWithScope;
    const bookmarkRows = selectAll('user_bookmarks', bookmarksDef, userId).map((row) =>
      projectRow(row, bookmarksDef),
    );
    archive.append(JSON.stringify(bookmarkRows, null, 2), { name: 'bookmarks.json' });
    counts.user_bookmarks = bookmarkRows.length;
  } else {
    counts.messages = 0;
    counts.user_bookmarks = 0;
  }

  archive.append(JSON.stringify(data, null, 2), { name: 'data.json' });

  // ---- manifest.json ----
  const manifest = {
    export_format_version: EXPORT_FORMAT_VERSION,
    db_schema_version: getSchemaVersion(),
    exported_at: new Date().toISOString(),
    source_user_id: userId,
    sections,
    counts,
  };
  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

  await archive.finalize();
  await archiveDone;
}

// The `.lurk` extension is just a renamed zip — yauzl reads it fine by
// content, not extension. The custom suffix sidesteps Safari's
// auto-unarchive-on-download behavior (which fires for application/zip)
// and labels the file as obviously a Lurker export.
export function buildExportFilename(username: string, { includeMessages = false } = {}): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const safe = String(username || 'user').replace(/[^a-zA-Z0-9_-]/g, '_');
  const suffix = includeMessages ? '' : '-settings';
  return `lurker-export-${safe}-${date}${suffix}.lurk`;
}
