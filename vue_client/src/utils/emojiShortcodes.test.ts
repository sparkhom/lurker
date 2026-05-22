// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { findActiveShortcode, findCompletedShortcode, rankShortcodes } from './emojiShortcodes.js';

describe('findActiveShortcode', () => {
  it('finds an in-progress shortcode ending at the caret', () => {
    expect(findActiveShortcode(':bo', 3)).toEqual({ name: 'bo', start: 0, end: 3 });
    expect(findActiveShortcode('hi :bo', 6)).toEqual({ name: 'bo', start: 3, end: 6 });
  });

  it('tracks the caret as the query grows', () => {
    expect(findActiveShortcode('hi :bone', 5)).toEqual({ name: 'b', start: 3, end: 5 });
    expect(findActiveShortcode('hi :bone', 8)).toEqual({ name: 'bone', start: 3, end: 8 });
  });

  it('lowercases the captured name', () => {
    expect(findActiveShortcode(':BoNe', 5)?.name).toBe('bone');
  });

  it('returns null when the caret is not in a shortcode', () => {
    expect(findActiveShortcode('hello world', 11)).toBeNull();
    expect(findActiveShortcode('', 0)).toBeNull();
    expect(findActiveShortcode(':', 1)).toBeNull();
  });

  it('does not trigger mid-word or after a digit', () => {
    // `:` glued to the back of a word/number is not a shortcode start.
    expect(findActiveShortcode('word:bo', 7)).toBeNull();
    expect(findActiveShortcode('12:00', 5)).toBeNull();
    expect(findActiveShortcode('http://x', 8)).toBeNull();
  });

  it('does not match ASCII smileys', () => {
    // `)` is not a shortcode character, so the run never reaches the caret.
    expect(findActiveShortcode(':-)', 3)).toBeNull();
    expect(findActiveShortcode(':-D', 3)?.name).toBe('-d');
  });

  it('does not treat an already-closed shortcode as active', () => {
    expect(findActiveShortcode(':bone:', 6)).toBeNull();
  });

  it('detects a shortcode start right after an emoji glyph', () => {
    expect(findActiveShortcode('🦴:sm', '🦴:sm'.length)).toEqual({
      name: 'sm',
      start: 2,
      end: 5,
    });
  });
});

describe('findCompletedShortcode', () => {
  it('finds a shortcode whose closing colon was just typed', () => {
    expect(findCompletedShortcode(':bone:', 6)).toEqual({ name: 'bone', start: 0, end: 6 });
    expect(findCompletedShortcode('hi :bone:', 9)).toEqual({ name: 'bone', start: 3, end: 9 });
  });

  it('handles names with + and - (e.g. :+1:)', () => {
    expect(findCompletedShortcode(':+1:', 4)).toEqual({ name: '+1', start: 0, end: 4 });
  });

  it('lowercases the captured name', () => {
    expect(findCompletedShortcode(':Bone:', 6)?.name).toBe('bone');
  });

  it('returns null when there is no closing colon at the caret', () => {
    expect(findCompletedShortcode(':bone', 5)).toBeNull();
    expect(findCompletedShortcode(':bone: ', 7)).toBeNull();
  });

  it('does not fire on a clock or mid-word colon run', () => {
    expect(findCompletedShortcode('12:00:', 6)).toBeNull();
    expect(findCompletedShortcode('word:bone:', 10)).toBeNull();
  });
});

describe('rankShortcodes', () => {
  const names = ['bone', 'bo', 'bonsai', 'carbon', 'smile'];

  it('returns nothing for an empty query', () => {
    expect(rankShortcodes(names, '')).toEqual([]);
  });

  it('orders exact, then prefix (shortest first), then substring matches', () => {
    expect(rankShortcodes(names, 'bo')).toEqual(['bo', 'bone', 'bonsai', 'carbon']);
  });

  it('puts an exact match ahead of a longer prefix match', () => {
    expect(rankShortcodes(['bonsai', 'bone', 'bo'], 'bone')).toEqual(['bone']);
    expect(rankShortcodes(['boner', 'bone'], 'bone')).toEqual(['bone', 'boner']);
  });

  it('matches case-insensitively', () => {
    expect(rankShortcodes(names, 'BO')).toEqual(['bo', 'bone', 'bonsai', 'carbon']);
  });

  it('excludes non-matches', () => {
    expect(rankShortcodes(names, 'smi')).toEqual(['smile']);
    expect(rankShortcodes(names, 'zzz')).toEqual([]);
  });
});
