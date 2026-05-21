// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { formatTimestamp } from './timestamp.js';

// formatTimestamp reads d.getHours() (local time). Passing a date-time string
// with no timezone designator makes the JS engine parse it as local time, so
// the rendered hour is deterministic regardless of the test runner's TZ.

describe('formatTimestamp 24-hour tokens', () => {
  it('renders the padded 24-hour clock', () => {
    expect(formatTimestamp('2026-05-21T09:07:03', 'HH:mm:ss')).toBe('09:07:03');
  });

  it('renders the unpadded 24-hour token', () => {
    expect(formatTimestamp('2026-05-21T09:07:03', 'H:mm')).toBe('9:07');
    expect(formatTimestamp('2026-05-21T13:07:03', 'H:mm')).toBe('13:07');
  });

  it('renders date tokens', () => {
    expect(formatTimestamp('2026-05-21T09:07:03', 'YYYY-MM-DD')).toBe('2026-05-21');
  });
});

describe('formatTimestamp 12-hour tokens', () => {
  it('renders afternoon hours as 12-hour with pm', () => {
    expect(formatTimestamp('2026-05-21T13:05:00', 'hh:mm a')).toBe('01:05 pm');
    expect(formatTimestamp('2026-05-21T13:05:00', 'h:mm A')).toBe('1:05 PM');
  });

  it('renders morning hours as 12-hour with am', () => {
    expect(formatTimestamp('2026-05-21T09:05:00', 'h:mm a')).toBe('9:05 am');
  });

  it('renders midnight as 12 am, not 0', () => {
    expect(formatTimestamp('2026-05-21T00:30:00', 'hh:mm a')).toBe('12:30 am');
    expect(formatTimestamp('2026-05-21T00:30:00', 'h:mm A')).toBe('12:30 AM');
  });

  it('renders noon as 12 pm, not 0', () => {
    expect(formatTimestamp('2026-05-21T12:00:00', 'hh:mm a')).toBe('12:00 pm');
  });

  it('wraps the late evening to single-digit 12-hour values', () => {
    expect(formatTimestamp('2026-05-21T23:45:00', 'h:mm A')).toBe('11:45 PM');
  });
});

describe('formatTimestamp guards', () => {
  it('returns an empty string for empty input or format', () => {
    expect(formatTimestamp('', 'HH:mm')).toBe('');
    expect(formatTimestamp('2026-05-21T09:07:03', '')).toBe('');
  });

  it('passes through non-token characters in the format string', () => {
    expect(formatTimestamp('2026-05-21T13:05:00', '[h:mm]')).toBe('[1:05]');
  });

  it('substitutes token letters even inside words — no literal escaping', () => {
    // Documented limitation: these formats drive time/date-only fields, so a
    // literal letter that collides with a token is still replaced. Pinned here
    // so the behavior reads as intentional rather than a bug.
    expect(formatTimestamp('2026-05-21T13:05:00', 'at h:mm')).toBe('pmt 1:05');
  });
});
