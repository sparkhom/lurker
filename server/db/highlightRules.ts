// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';

/** A raw row from the `highlight_rules` table. */
interface HighlightRuleRow {
  id: number;
  user_id: number;
  pattern: string | null;
  mask: string | null;
  channels: string | null;
  kind: string;
  case_sensitive: number;
  enabled: number;
  auto_managed: number;
  created_at: string;
}

/**
 * The public rule shape returned to callers (booleans coerced from SQLite
 * integers, channels split from CSV, network scope resolved from the junction).
 * `networkIds` is empty for a global rule, or the list of networks the rule is
 * scoped to (an auto-nick rule can span several).
 */
export interface HighlightRule {
  id: number;
  user_id: number;
  pattern: string | null;
  mask: string | null;
  channels: string[] | null;
  kind: string;
  case_sensitive: boolean;
  enabled: boolean;
  auto_managed: boolean;
  created_at: string;
  networkIds: number[];
}

/** Fields accepted by createRule / updateRule. */
export interface RuleFields {
  pattern?: string | null;
  mask?: string | null;
  channels?: string[] | null;
  kind?: string;
  case_sensitive?: boolean;
  enabled?: boolean;
  /** On create: attach the rule to this network (null = global). */
  networkId?: number | null;
}

function splitChannels(csv: string | null): string[] | null {
  if (!csv) return null;
  const parts = csv
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  return parts.length ? parts : null;
}

function joinChannels(channels: string[] | null | undefined): string | null {
  if (!channels || channels.length === 0) return null;
  const parts = channels.map((c) => c.trim()).filter(Boolean);
  return parts.length ? parts.join(',') : null;
}

// Network ids for a set of rules, keyed by rule id. One query for the whole set
// rather than a per-row lookup.
function networkIdsFor(ruleIds: number[]): Map<number, number[]> {
  const map = new Map<number, number[]>();
  if (ruleIds.length === 0) return map;
  const placeholders = ruleIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT rule_id, network_id FROM highlight_rule_networks WHERE rule_id IN (${placeholders})`,
    )
    .all(...ruleIds) as { rule_id: number; network_id: number }[];
  for (const r of rows) {
    const list = map.get(r.rule_id);
    if (list) list.push(r.network_id);
    else map.set(r.rule_id, [r.network_id]);
  }
  return map;
}

function rowsToRules(rows: HighlightRuleRow[]): HighlightRule[] {
  const nets = networkIdsFor(rows.map((r) => r.id));
  return rows.map((row) => ({
    id: row.id,
    user_id: row.user_id,
    pattern: row.pattern,
    mask: row.mask,
    channels: splitChannels(row.channels),
    kind: row.kind,
    case_sensitive: !!row.case_sensitive,
    enabled: !!row.enabled,
    auto_managed: !!row.auto_managed,
    created_at: row.created_at,
    networkIds: nets.get(row.id) ?? [],
  }));
}

function rowToRule(row: HighlightRuleRow | undefined): HighlightRule | null {
  if (!row) return null;
  return rowsToRules([row])[0];
}

export function listRules(userId: number): HighlightRule[] {
  const rows = db
    .prepare('SELECT * FROM highlight_rules WHERE user_id = ? ORDER BY id')
    .all(userId) as HighlightRuleRow[];
  return rowsToRules(rows);
}

// The effective rule set for matching on one network: global rules (no junction
// rows) plus rules attached to this network. This is what the highlight matcher
// compiles against, mirroring ignore's listScopedRules.
export function listScopedRules(userId: number, networkId: number): HighlightRule[] {
  const rows = db
    .prepare(
      `SELECT r.* FROM highlight_rules r
       WHERE r.user_id = ?
         AND (
           NOT EXISTS (SELECT 1 FROM highlight_rule_networks j WHERE j.rule_id = r.id)
           OR EXISTS (SELECT 1 FROM highlight_rule_networks j WHERE j.rule_id = r.id AND j.network_id = ?)
         )
       ORDER BY r.id`,
    )
    .all(userId, networkId) as HighlightRuleRow[];
  return rowsToRules(rows);
}

export function getRule(id: number | bigint, userId: number): HighlightRule | null {
  const row = db
    .prepare('SELECT * FROM highlight_rules WHERE id = ? AND user_id = ?')
    .get(id, userId) as HighlightRuleRow | undefined;
  return rowToRule(row);
}

const insertRuleStmt = db.prepare(`
  INSERT INTO highlight_rules (user_id, pattern, mask, channels, kind, case_sensitive, enabled)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const attachNetworkStmt = db.prepare(`
  INSERT OR IGNORE INTO highlight_rule_networks (rule_id, network_id) VALUES (?, ?)
`);

export function createRule(userId: number, fields: RuleFields): HighlightRule | null {
  const {
    pattern = null,
    mask = null,
    channels = null,
    kind = 'full',
    case_sensitive = false,
    enabled = true,
    networkId = null,
  } = fields;
  const create = db.transaction((): number | bigint => {
    const result = insertRuleStmt.run(
      userId,
      pattern,
      mask,
      joinChannels(channels),
      kind,
      case_sensitive ? 1 : 0,
      enabled ? 1 : 0,
    );
    if (networkId != null) attachNetworkStmt.run(result.lastInsertRowid, networkId);
    return result.lastInsertRowid;
  });
  return getRule(create(), userId);
}

export function updateRule(id: number, userId: number, fields: RuleFields): HighlightRule | null {
  const setClauses: string[] = [];
  const params: (string | number | null)[] = [];
  if ('pattern' in fields) {
    setClauses.push('pattern = ?');
    params.push(fields.pattern ?? null);
  }
  if ('mask' in fields) {
    setClauses.push('mask = ?');
    params.push(fields.mask ?? null);
  }
  if ('channels' in fields) {
    setClauses.push('channels = ?');
    params.push(joinChannels(fields.channels));
  }
  if ('kind' in fields) {
    setClauses.push('kind = ?');
    params.push(fields.kind as string);
  }
  if ('case_sensitive' in fields) {
    setClauses.push('case_sensitive = ?');
    params.push(fields.case_sensitive ? 1 : 0);
  }
  if ('enabled' in fields) {
    setClauses.push('enabled = ?');
    params.push(fields.enabled ? 1 : 0);
  }
  if (!setClauses.length) return getRule(id, userId);
  params.push(id, userId);
  db.prepare(
    `UPDATE highlight_rules SET ${setClauses.join(', ')} WHERE id = ? AND user_id = ?`,
  ).run(...params);
  return getRule(id, userId);
}

export function deleteRule(id: number, userId: number): void {
  db.prepare('DELETE FROM highlight_rules WHERE id = ? AND user_id = ?').run(id, userId);
}

// Auto-nick rules are shared across every network that currently uses the same
// nick. We detach the network from any prior auto rule, find-or-create one for
// the new nick, attach the network, then sweep any auto rule that no longer
// has any networks attached. A manual rule matching the same nick (same
// pattern + whole-word/case-insensitive) suppresses auto-creation, since the
// manual rule already covers the highlight.
const findExistingStmt = db.prepare(`
  SELECT id, auto_managed FROM highlight_rules
  WHERE user_id = ? AND pattern = ? AND mask IS NULL AND kind = 'full' AND case_sensitive = 0
  LIMIT 1
`);
const detachNetworkStmt = db.prepare(`
  DELETE FROM highlight_rule_networks
  WHERE network_id = ?
    AND rule_id IN (SELECT id FROM highlight_rules
                    WHERE user_id = ? AND auto_managed = 1)
`);
const insertAutoRuleStmt = db.prepare(`
  INSERT INTO highlight_rules (user_id, pattern, kind, case_sensitive, enabled, auto_managed)
  VALUES (?, ?, 'full', 0, 1, 1)
`);
const sweepOrphanedAutoStmt = db.prepare(`
  DELETE FROM highlight_rules
  WHERE user_id = ? AND auto_managed = 1
    AND id NOT IN (SELECT rule_id FROM highlight_rule_networks)
`);

const upsertAutoNickRuleTx = db.transaction(
  (userId: number, networkId: number, nick: string): number | bigint | null => {
    detachNetworkStmt.run(networkId, userId);
    const existing = findExistingStmt.get(userId, nick) as
      | { id: number; auto_managed: number }
      | undefined;
    let ruleId: number | bigint | null = null;
    if (existing) {
      if (existing.auto_managed) {
        attachNetworkStmt.run(existing.id, networkId);
        ruleId = existing.id;
      }
      // Manual rule with the same triple already covers this nick — skip
      // auto-creation. If the user later deletes their manual rule, the next
      // reconnect / nick change will re-create the auto.
    } else {
      const result = insertAutoRuleStmt.run(userId, nick);
      ruleId = result.lastInsertRowid;
      attachNetworkStmt.run(ruleId, networkId);
    }
    sweepOrphanedAutoStmt.run(userId);
    return ruleId;
  },
);

export function upsertAutoNickRule(
  userId: number,
  networkId: number,
  nick: string,
): HighlightRule | null {
  if (!nick) return null;
  const ruleId = upsertAutoNickRuleTx(userId, networkId, nick);
  return ruleId ? getRule(ruleId, userId) : null;
}
