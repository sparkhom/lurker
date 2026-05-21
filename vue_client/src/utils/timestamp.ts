// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Recognized format tokens, longest-first within each prefix so the regex
// prefers `HH` over `H` and `hh` over `h`:
//   YYYY  4-digit year        MM  2-digit month     DD  2-digit day
//   HH    24-hour, padded     H   24-hour           hh  12-hour, padded
//   h     12-hour             mm  minutes, padded   ss  seconds, padded
//   a     am/pm               A   AM/PM
// Non-token characters (":" "-" "/" digits, spaces, brackets) pass through
// verbatim. There is deliberately no literal-escape syntax: these formats
// drive time/date-only fields (message timestamps, the status-bar clock), so
// embedding prose isn't a use case — and note that a literal letter matching
// a token IS substituted (e.g. "at h:mm" turns the leading "a" into am/pm).
const TOKEN_RE = /YYYY|MM|DD|HH|H|hh|h|mm|ss|a|A/g;

export function formatTimestamp(iso: string, fmt: string): string {
  if (!iso || !fmt) return '';
  const d = new Date(iso);
  const h24 = d.getHours();
  // 12-hour clock: 0 and 12 both display as 12, 13–23 wrap to 1–11.
  const h12 = h24 % 12 || 12;
  const tokens: Record<string, string> = {
    YYYY: String(d.getFullYear()),
    MM: String(d.getMonth() + 1).padStart(2, '0'),
    DD: String(d.getDate()).padStart(2, '0'),
    HH: String(h24).padStart(2, '0'),
    H: String(h24),
    hh: String(h12).padStart(2, '0'),
    h: String(h12),
    mm: String(d.getMinutes()).padStart(2, '0'),
    ss: String(d.getSeconds()).padStart(2, '0'),
    a: h24 < 12 ? 'am' : 'pm',
    A: h24 < 12 ? 'AM' : 'PM',
  };
  return fmt.replace(TOKEN_RE, (t) => tokens[t]);
}

// Local-time calendar date as 'YYYY-MM-DD', used for the day-change marker in
// the message list. Uses the same `new Date(iso)` parsing as formatTimestamp
// so the marker and the per-row times always agree on which day a message
// falls in. Returns '' when the timestamp doesn't parse.
export function formatDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return (
    `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, '0')}-` +
    `${String(d.getDate()).padStart(2, '0')}`
  );
}

// SQLite's `datetime('now')` produces 'YYYY-MM-DD HH:MM:SS' with no timezone
// marker, so Date.parse() interprets it as local time on most browsers (UTC
// on a few) — which means for users east of UTC the rendered relative time
// is wrong, and clamps to "0s ago" once Math.max(0, …) bottoms out. We
// detect the absence of a TZ designator and explicitly mark these as UTC.
export function parseServerTimestamp(iso: string): number {
  if (!iso) return NaN;
  const hasTz = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso);
  const normalized = hasTz ? iso : iso.replace(' ', 'T') + 'Z';
  return Date.parse(normalized);
}

// Cached Intl formatters. Locale is taken from the runtime default
// (navigator.language in browsers), which Lurker never changes at runtime —
// so a single module-level instance is safe.
const RTF = new Intl.RelativeTimeFormat(undefined, { numeric: 'always', style: 'narrow' });
const DTF_DAY = new Intl.DateTimeFormat(undefined, { dateStyle: 'full' });
const DTF_DATETIME = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

// Render a server timestamp as a locale-aware relative phrase (e.g. "5m ago"
// in en-US, "vor 5 Min." in de). Returns the raw string back if it doesn't
// parse, so callers can use it as a title/tooltip fallback.
export function formatRelative(iso: string): string {
  if (!iso) return '';
  const t = parseServerTimestamp(iso);
  if (!Number.isFinite(t)) return iso;
  const diffMs = t - Date.now();
  const past = diffMs <= 0;
  const absMs = Math.abs(diffMs);
  let value: number;
  let unit: Intl.RelativeTimeFormatUnit;
  if (absMs < 60_000) {
    value = Math.round(absMs / 1000);
    unit = 'second';
  } else if (absMs < 3_600_000) {
    value = Math.round(absMs / 60_000);
    unit = 'minute';
  } else if (absMs < 86_400_000) {
    value = Math.round(absMs / 3_600_000);
    unit = 'hour';
  } else {
    value = Math.round(absMs / 86_400_000);
    unit = 'day';
  }
  return RTF.format(past ? -value : value, unit);
}

// Locale-aware long-form day label for the date divider in MessageList,
// e.g. "Sunday, May 17, 2026" in en-US. The grouping key stays as the ISO
// YYYY-MM-DD string from formatDate() so grouping math is locale-stable.
export function formatDayLabel(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return DTF_DAY.format(d);
}

// Locale-aware date+time for fixed displays like "Updated …" lines. Accepts
// both ISO-with-timezone and the SQLite-style "YYYY-MM-DD HH:MM:SS" UTC
// strings the server emits, via parseServerTimestamp.
export function formatDateTime(iso: string): string {
  if (!iso) return '';
  const t = parseServerTimestamp(iso);
  if (!Number.isFinite(t)) return '';
  return DTF_DATETIME.format(t);
}

// Format an interval between two ISO timestamps for the back-from-away
// divider ("back (gone 1h 23m)"). Sub-minute durations round up to "1m"
// instead of showing "0m" since the divider would otherwise look broken on
// a fast away/back toggle.
export function formatDuration(fromIso: string, toIso: string): string {
  if (!fromIso || !toIso) return '';
  const fromMs = Date.parse(fromIso);
  const toMs = Date.parse(toIso);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return '';
  const totalMin = Math.max(1, Math.round((toMs - fromMs) / 60000));
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins || parts.length === 0) parts.push(`${mins}m`);
  return parts.join(' ');
}
