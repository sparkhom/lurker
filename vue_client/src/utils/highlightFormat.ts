// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Shared formatting for a highlight rule's human summary, used by both the
// /highlight command listing (MessageInput) and the settings pane rows, so the
// two presentations can't drift. Each caller adds its own subject/scope framing
// (the command shows them inline; the pane shows the subject separately and
// groups by scope); this owns the kind label and the secondary descriptors.

export interface HighlightSummaryRule {
  pattern: string | null;
  mask: string | null;
  channels: string[] | null;
  kind: string;
  case_sensitive: boolean;
  auto_managed: boolean;
  enabled: boolean;
}

export function highlightKindLabel(kind: string): string {
  return kind === 'full'
    ? 'whole word'
    : kind === 'glob'
      ? 'glob'
      : kind === 'regex'
        ? 'regex'
        : 'contains';
}

// Secondary descriptors common to both surfaces: how a keyword matches, case
// sensitivity, channel scope, and the auto/disabled flags. For a mask rule the
// keyword (if any) is surfaced here since the mask is the subject; for a keyword
// rule the match kind is shown.
export function highlightRuleDetailParts(rule: HighlightSummaryRule): string[] {
  const parts: string[] = [];
  if (rule.mask) {
    if (rule.pattern) {
      parts.push(
        rule.kind === 'regex'
          ? `/${rule.pattern}/`
          : `"${rule.pattern}" (${highlightKindLabel(rule.kind)})`,
      );
    }
  } else {
    parts.push(highlightKindLabel(rule.kind));
  }
  if (rule.case_sensitive) parts.push('case-sensitive');
  if (rule.channels?.length) parts.push(rule.channels.join(', '));
  if (rule.auto_managed) parts.push('auto');
  if (!rule.enabled) parts.push('disabled');
  return parts;
}
