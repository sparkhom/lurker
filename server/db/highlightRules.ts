// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';
import { parseChannelList } from '../../shared/channels.js';

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
  const parts = parseChannelList(csv);
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
const clearRuleNetworksStmt = db.prepare(`
  DELETE FROM highlight_rule_networks WHERE rule_id = ?
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
  // Re-scope (network attachment) lives in the junction, not a column. Including
  // it here lets an edit change scope atomically (single id-stable update) rather
  // than the caller doing create-then-delete. A user rule is global (no rows) or
  // scoped to exactly one network, so we clear then optionally re-attach.
  const reScope = 'networkId' in fields;
  if (!setClauses.length && !reScope) return getRule(id, userId);
  const apply = db.transaction(() => {
    if (setClauses.length) {
      db.prepare(
        `UPDATE highlight_rules SET ${setClauses.join(', ')} WHERE id = ? AND user_id = ?`,
      ).run(...params, id, userId);
    }
    if (reScope) {
      // Guard on ownership before touching the junction (UPDATE above is already
      // user-scoped; a column-less re-scope must check it too).
      const owned = db
        .prepare('SELECT 1 FROM highlight_rules WHERE id = ? AND user_id = ?')
        .get(id, userId);
      if (owned) {
        clearRuleNetworksStmt.run(id);
        if (fields.networkId != null) attachNetworkStmt.run(id, fields.networkId);
      }
    }
  });
  apply();
  return getRule(id, userId);
}

export function deleteRule(id: number, userId: number): void {
  db.prepare('DELETE FROM highlight_rules WHERE id = ? AND user_id = ?').run(id, userId);
}

// Auto-nick rules are shared across every network that currently uses the same
// nick. The upsert is idempotent: it makes this network's own-nick state correct
// and reports whether it actually changed anything (so the caller only fans a
// cross-tab refetch on real change, not on every no-op reconnect).
//
// A manual rule the user added for their nick suppresses the auto rule entirely.
// The manual default is 'substr' now, so a substr/full/plain (case-insensitive,
// no-mask) rule with pattern = nick all count as "covers the nick" — otherwise a
// manual /highlight <ownnick> wouldn't suppress auto-creation and you'd get a
// duplicate auto rule on the next reconnect.
const manualCoveringStmt = db.prepare(`
  SELECT id FROM highlight_rules
  WHERE user_id = ? AND pattern = ? AND mask IS NULL AND auto_managed = 0
    AND kind IN ('full', 'substr', 'plain') AND case_sensitive = 0
  LIMIT 1
`);
const autoForNickStmt = db.prepare(`
  SELECT id FROM highlight_rules
  WHERE user_id = ? AND pattern = ? AND auto_managed = 1
  LIMIT 1
`);
// The auto rule (if any) this network is currently attached to.
const currentAutoAttachmentStmt = db.prepare(`
  SELECT r.id AS id, r.pattern AS pattern
  FROM highlight_rule_networks j
  JOIN highlight_rules r ON r.id = j.rule_id
  WHERE j.network_id = ? AND r.user_id = ? AND r.auto_managed = 1
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
  (
    userId: number,
    networkId: number,
    nick: string,
  ): { ruleId: number | bigint | null; changed: boolean } => {
    const manual = manualCoveringStmt.get(userId, nick) as { id: number } | undefined;
    const currentAuto = currentAutoAttachmentStmt.get(networkId, userId) as
      | { id: number; pattern: string }
      | undefined;

    if (manual) {
      // A manual rule already covers this nick → this network must carry no auto.
      if (!currentAuto) return { ruleId: null, changed: false }; // already correct
      detachNetworkStmt.run(networkId, userId);
      sweepOrphanedAutoStmt.run(userId);
      return { ruleId: null, changed: true };
    }

    // No manual override: this network should be attached to the auto rule for
    // `nick`. If it already is, there's nothing to do.
    if (currentAuto && currentAuto.pattern === nick) {
      return { ruleId: currentAuto.id, changed: false };
    }
    // Re-map: drop a stale auto attachment (old nick), then find-or-create the
    // auto rule for the current nick and attach this network.
    if (currentAuto) detachNetworkStmt.run(networkId, userId);
    const auto = autoForNickStmt.get(userId, nick) as { id: number } | undefined;
    const ruleId: number | bigint = auto
      ? auto.id
      : insertAutoRuleStmt.run(userId, nick).lastInsertRowid;
    attachNetworkStmt.run(ruleId, networkId);
    sweepOrphanedAutoStmt.run(userId);
    return { ruleId, changed: true };
  },
);

export function upsertAutoNickRule(
  userId: number,
  networkId: number,
  nick: string,
): { rule: HighlightRule | null; changed: boolean } {
  if (!nick) return { rule: null, changed: false };
  const { ruleId, changed } = upsertAutoNickRuleTx(userId, networkId, nick);
  return { rule: ruleId ? getRule(ruleId, userId) : null, changed };
}
