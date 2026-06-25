// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { PREFIX_ORDER, prefixOf, prefixClass } from './memberPrefix.js';

describe('prefixOf', () => {
  it('returns the single highest-ranked glyph', () => {
    expect(prefixOf(['q'])).toBe('~');
    expect(prefixOf(['a'])).toBe('&');
    expect(prefixOf(['o'])).toBe('@');
    expect(prefixOf(['h'])).toBe('%');
    expect(prefixOf(['v'])).toBe('+');
  });

  it('ranks owner > admin > op > halfop > voice when several are held', () => {
    expect(prefixOf(['v', 'o'])).toBe('@');
    expect(prefixOf(['h', 'v'])).toBe('%');
    expect(prefixOf(['o', 'a', 'q'])).toBe('~');
  });

  it('returns empty string for no prefix modes', () => {
    expect(prefixOf([])).toBe('');
    expect(prefixOf(['x', 'b'])).toBe('');
  });

  it('tolerates null/undefined', () => {
    expect(prefixOf(null)).toBe('');
    expect(prefixOf(undefined)).toBe('');
  });
});

describe('prefixClass', () => {
  it('builds a mode-<glyph> class or empty string', () => {
    expect(prefixClass(['o'])).toBe('mode-@');
    expect(prefixClass(['q'])).toBe('mode-~');
    expect(prefixClass([])).toBe('');
  });
});

describe('PREFIX_ORDER', () => {
  it('lists glyphs high-to-low with empty last, so indexOf sorts members by rank', () => {
    expect(PREFIX_ORDER).toEqual(['~', '&', '@', '%', '+', '']);
    expect(PREFIX_ORDER.indexOf(prefixOf(['o']))).toBeLessThan(
      PREFIX_ORDER.indexOf(prefixOf(['v'])),
    );
    expect(PREFIX_ORDER.indexOf(prefixOf([]))).toBe(PREFIX_ORDER.length - 1);
  });
});
