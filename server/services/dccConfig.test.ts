// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// MUST be first — redirect DATABASE_PATH before the static imports below open
// the real data/lurker.db.
import '../test-utils/isolateDb.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createUser } from '../db/users.js';
import { CAPABILITY_DCC, setUserCapability } from '../db/userCapabilities.js';
import { dccEnabledForUser, dccMasterEnabled, parseDccEnabled } from './dccConfig.js';

describe('parseDccEnabled', () => {
  it('treats the conventional truthy values as on (trimmed, case-insensitive)', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) {
      expect(parseDccEnabled(v)).toBe(true);
    }
  });

  it('is off for unset / empty / anything else (opt-in only)', () => {
    for (const v of [undefined, '', '0', 'false', 'no', 'off', 'maybe']) {
      expect(parseDccEnabled(v)).toBe(false);
    }
  });
});

describe('dcc gate', () => {
  let userId: number;
  beforeAll(() => {
    userId = createUser('gate-alice').id;
  });
  afterEach(() => {
    delete process.env.LURKER_DCC_ENABLED;
  });

  it('reads the master switch live from LURKER_DCC_ENABLED', () => {
    delete process.env.LURKER_DCC_ENABLED;
    expect(dccMasterEnabled()).toBe(false);
    process.env.LURKER_DCC_ENABLED = '1';
    expect(dccMasterEnabled()).toBe(true);
  });

  it('requires BOTH the master switch and a per-user grant', () => {
    // neither
    expect(dccEnabledForUser(userId)).toBe(false);
    // grant only
    setUserCapability(userId, CAPABILITY_DCC, true);
    expect(dccEnabledForUser(userId)).toBe(false);
    // master only
    setUserCapability(userId, CAPABILITY_DCC, false);
    process.env.LURKER_DCC_ENABLED = '1';
    expect(dccEnabledForUser(userId)).toBe(false);
    // both
    setUserCapability(userId, CAPABILITY_DCC, true);
    expect(dccEnabledForUser(userId)).toBe(true);
  });
});
