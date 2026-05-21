// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { createUrlRegex } from './urlPattern.js';

// Collect every URL the shared regex finds in a string.
function urls(text: string): string[] {
  return text.match(createUrlRegex()) ?? [];
}

describe('createUrlRegex', () => {
  it('matches http(s) and ftp(s) URLs', () => {
    expect(urls('see https://example.com/path here')).toEqual(['https://example.com/path']);
    expect(urls('grab ftp://files.example.org/x and ftps://s.example.org')).toEqual([
      'ftp://files.example.org/x',
      'ftps://s.example.org',
    ]);
  });

  it('matches bare www. hosts and mailto: links', () => {
    expect(urls('visit www.example.com today')).toEqual(['www.example.com']);
    expect(urls('write mailto:hi@example.com now')).toEqual(['mailto:hi@example.com']);
  });

  it('matches bare email addresses with a real TLD', () => {
    expect(urls('mail bob@example.com please')).toEqual(['bob@example.com']);
  });

  it('does not match IRC-style host masks with no TLD', () => {
    // `nick@server` has no dotted TLD — it must not be mistaken for an email.
    expect(urls('kicked nick@server for spam')).toEqual([]);
  });

  it('stops a URL at whitespace and angle brackets', () => {
    expect(urls('a https://example.com b')).toEqual(['https://example.com']);
    expect(urls('<https://example.com>')).toEqual(['https://example.com']);
  });

  it('finds multiple URLs in one string', () => {
    expect(urls('https://a.example and https://b.example')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('is case-insensitive on the scheme', () => {
    expect(urls('HTTPS://Example.com')).toEqual(['HTTPS://Example.com']);
  });

  it('returns a fresh, non-shared regex each call', () => {
    const a = createUrlRegex();
    const b = createUrlRegex();
    expect(a).not.toBe(b);
    // Advancing one instance's lastIndex must not leak into the other.
    a.exec('https://example.com');
    expect(a.lastIndex).toBeGreaterThan(0);
    expect(b.lastIndex).toBe(0);
  });
});
