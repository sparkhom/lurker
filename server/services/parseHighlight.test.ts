// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { parseHighlightArgs } from '../../shared/parseHighlight.js';

const p = (s: string) => parseHighlightArgs(s);

describe('parseHighlightArgs — keyword rules', () => {
  it('bare keyword defaults to substr, global, case-insensitive', () => {
    expect(p('quack')).toMatchObject({
      pattern: 'quack',
      mask: null,
      kind: 'substr',
      caseSensitive: false,
      scopeNetwork: false,
      channels: null,
    });
  });

  it('-full makes it whole-word', () => {
    expect(p('-full quack')).toMatchObject({ pattern: 'quack', kind: 'full' });
  });

  it('-regexp makes it a regex', () => {
    expect(p('-regexp qu+ack')).toMatchObject({ pattern: 'qu+ack', kind: 'regex' });
  });

  it('-matchcase sets case sensitivity', () => {
    expect(p('-matchcase QUACK')).toMatchObject({ pattern: 'QUACK', caseSensitive: true });
  });

  it('joins a multi-word phrase into one pattern', () => {
    expect(p('build failed')).toMatchObject({ pattern: 'build failed' });
    expect(p('"build failed"')).toMatchObject({ pattern: 'build failed' });
  });

  it('keeps a balanced regex group as one token', () => {
    expect(p('-regexp (foo|bar baz)')).toMatchObject({ pattern: '(foo|bar baz)', kind: 'regex' });
  });

  it('does NOT treat a leading # as a channel (keyword may be #release)', () => {
    expect(p('#release')).toMatchObject({ pattern: '#release', channels: null });
  });
});

describe('parseHighlightArgs — mask rules', () => {
  it('-mask makes the positional a sender mask', () => {
    expect(p('-mask bob!*@*')).toMatchObject({ mask: 'bob!*@*', pattern: null });
  });
});

describe('parseHighlightArgs — scope', () => {
  it('-network scopes to the current network', () => {
    expect(p('-network quack')).toMatchObject({ scopeNetwork: true, pattern: 'quack' });
  });

  it('-global is the explicit default', () => {
    expect(p('-global quack')).toMatchObject({ scopeNetwork: false });
  });

  it('-channels parses a comma list, lowercased', () => {
    expect(p('-channels #Ops,#Dev quack')).toMatchObject({
      channels: ['#ops', '#dev'],
      pattern: 'quack',
    });
  });
});

describe('parseHighlightArgs — errors', () => {
  it('rejects an unknown flag', () => {
    expect(p('-bogus quack').error).toMatch(/unknown flag/);
  });

  it('requires a value after -channels', () => {
    expect(p('-channels').error).toMatch(/-channels needs a value/);
  });

  it('requires a pattern when none given', () => {
    expect(p('-full').error).toMatch(/pattern is required/);
  });

  it('requires a mask when -mask given with no positional', () => {
    expect(p('-mask').error).toMatch(/mask is required/);
  });

  it('rejects -regexp combined with -full', () => {
    expect(p('-regexp -full x').error).toMatch(/mutually exclusive/);
  });
});
