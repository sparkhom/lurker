// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Background worker that builds a user's data-export .lurk archive.
//
// Runs in a worker_thread spawned by services/exportJobs.ts. It opens its OWN
// readonly better-sqlite3 connection to the same WAL database the main process
// is writing to. WAL allows a concurrent reader alongside the live writer, so
// the streaming `.iterate()` cursor that backs messages.ndjson never touches
// the connection the IRC bouncer inserts on. That separation is the whole
// point: building the export inline on the shared connection is what threw
// "this database connection is busy executing a query" and crashed the process
// (lurker#175).
//
// It MUST NOT import the db singleton (db/index.ts) — doing so would open a
// second writer connection in the worker and re-run migrations. exportService
// is deliberately connection-agnostic so this worker can pass its own handle.

import { parentPort, workerData } from 'node:worker_threads';
import { createWriteStream, statSync } from 'node:fs';
import Database from 'better-sqlite3';
import { buildExportZip } from './exportService.js';

export interface ExportWorkerData {
  dbPath: string;
  userId: number;
  includeMessages: boolean;
  outPath: string;
}

export type ExportWorkerMessage =
  | { type: 'progress'; processed: number; total: number }
  | { type: 'done'; byteSize: number }
  | { type: 'error'; message: string };

function post(msg: ExportWorkerMessage): void {
  // worker_threads postMessage has no targetOrigin (that's window.postMessage);
  // the lint rule doesn't distinguish the two.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  parentPort?.postMessage(msg);
}

async function run(): Promise<void> {
  const { dbPath, userId, includeMessages, outPath } = workerData as ExportWorkerData;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    // 0600 — the artifact carries decrypted network passwords; keep it readable
    // only by the cell's own user (it's served back over the authenticated
    // download endpoint, never directly).
    const out = createWriteStream(outPath, { mode: 0o600 });
    await buildExportZip(db, userId, { includeMessages }, out, (processed, total) => {
      post({ type: 'progress', processed, total });
    });
    const byteSize = statSync(outPath).size;
    post({ type: 'done', byteSize });
  } finally {
    db.close();
  }
}

run().catch((err: unknown) => {
  post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
