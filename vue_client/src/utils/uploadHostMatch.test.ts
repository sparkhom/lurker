// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import { isUploadImageUrl } from './uploadHostMatch.js';

describe('isUploadImageUrl', () => {
  it('matches x0 image URLs', () => {
    expect(isUploadImageUrl('https://x0.at/abc.png', '')).toBe(true);
  });

  it('matches catbox image URLs case-insensitively', () => {
    expect(isUploadImageUrl('https://files.catbox.moe/abc.JPG', '')).toBe(true);
  });

  it('matches image paths with query strings', () => {
    expect(isUploadImageUrl('https://files.catbox.moe/abc.png?v=2', '')).toBe(true);
  });

  it('rejects provider URLs without image extensions', () => {
    expect(isUploadImageUrl('https://files.catbox.moe/abc.txt', '')).toBe(false);
  });

  it('rejects image URLs on unsupported hosts', () => {
    expect(isUploadImageUrl('https://imgur.com/abc.png', '')).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(isUploadImageUrl('not a url', '')).toBe(false);
  });

  it('matches the configured hoarder host', () => {
    expect(isUploadImageUrl('https://drop.example.com/x.png', 'https://drop.example.com')).toBe(
      true,
    );
  });

  it('rejects hoarder URLs when the setting is empty', () => {
    expect(isUploadImageUrl('https://drop.example.com/x.png', '')).toBe(false);
  });

  it('rejects hoarder URLs when the setting is malformed', () => {
    expect(isUploadImageUrl('https://drop.example.com/x.png', 'not a url')).toBe(false);
  });
});
