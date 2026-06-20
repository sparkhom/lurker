// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import fs from 'fs';
import os from 'os';
import path from 'path';

// Side-effect module: redirect the db layer at a throwaway file. Import this
// FIRST — before any module that reaches db/index.js — in test files that
// statically value-import db-touching code. db/index.js opens its SQLite file
// at module-load time, and a top-level `process.env.DATABASE_PATH = …`
// statement in the test runs *after* its static imports are evaluated, far too
// late to redirect it (this is exactly how ircConnection.test.ts leaked
// "Joined #anime" rows into the operator's real data/lurker.db). Tests that use
// the dynamic-import pattern (set the env, then `await import(...)`) don't need
// this. Idempotent: an already-set DATABASE_PATH wins.
if (!process.env.DATABASE_PATH) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
}
