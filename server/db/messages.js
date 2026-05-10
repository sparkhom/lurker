import db from './index.js';

const insertStmt = db.prepare(`
  INSERT INTO messages (network_id, target, time, type, nick, text, kind, self, extra)
  VALUES (@networkId, @target, @time, @type, @nick, @text, @kind, @self, @extra)
`);

export function insertMessage(row) {
  const result = insertStmt.run({
    networkId: row.networkId,
    target: row.target,
    time: row.time,
    type: row.type,
    nick: row.nick ?? null,
    text: row.text ?? null,
    kind: row.kind ?? null,
    self: row.self ? 1 : 0,
    extra: row.extra ? JSON.stringify(row.extra) : null,
  });
  return result.lastInsertRowid;
}

function rowToEvent(row) {
  const event = {
    id: row.id,
    networkId: row.network_id,
    target: row.target,
    time: row.time,
    type: row.type,
    nick: row.nick,
    text: row.text,
    kind: row.kind,
    self: !!row.self,
  };
  if (row.extra) {
    try {
      Object.assign(event, JSON.parse(row.extra));
    } catch (_) { /* ignore malformed */ }
  }
  return event;
}

export function listMessages(networkId, target, { before, limit = 50 } = {}) {
  const sql = before
    ? `SELECT * FROM messages WHERE network_id = ? AND target = ? AND id < ? ORDER BY id DESC LIMIT ?`
    : `SELECT * FROM messages WHERE network_id = ? AND target = ? ORDER BY id DESC LIMIT ?`;
  const params = before ? [networkId, target, before, limit] : [networkId, target, limit];
  const rows = db.prepare(sql).all(...params);
  return rows.map(rowToEvent).reverse();
}

export function listRecentForBuffers(networkId, targets, perBuffer = 50) {
  const out = {};
  for (const t of targets) {
    out[t] = listMessages(networkId, t, { limit: perBuffer });
  }
  return out;
}

export function listBufferTargets(networkId) {
  return db
    .prepare('SELECT DISTINCT target FROM messages WHERE network_id = ? ORDER BY target')
    .all(networkId)
    .map((r) => r.target);
}

// Targets that have had at least one message within the last `sinceDays` days.
// Used by the /away marker fan-out so we don't splatter into long-cold DMs the
// user hasn't touched in months.
export function listRecentBufferTargets(networkId, sinceDays = 7) {
  const sinceIso = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  return db
    .prepare('SELECT DISTINCT target FROM messages WHERE network_id = ? AND time >= ? ORDER BY target')
    .all(networkId, sinceIso)
    .map((r) => r.target);
}

export function countOlder(networkId, target, beforeId) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM messages WHERE network_id = ? AND target = ? AND id < ?`
  ).get(networkId, target, beforeId).n;
}

// Types that count as "real content" for the unread badge. Membership churn
// (join/part/quit/kick/nick/mode/topic), MOTD, away markers, and server
// errors are all persisted for the buffer log but shouldn't bump the badge —
// the live unread path in useSocket.applyEvent uses the same allowlist, and
// we need the SQL paths to match so backlog/read-state recomputes don't snap
// the count to an inflated number.
const COUNTABLE_TYPES_SQL = `('message','action','notice')`;

export function countNewer(networkId, target, afterId) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM messages
     WHERE network_id = ? AND target = ? AND id > ?
       AND type IN ${COUNTABLE_TYPES_SQL}`
  ).get(networkId, target, afterId || 0).n;
}

// Returns events newer than `afterId`, oldest-first, capped at `limit`. Used
// for unread highlight counting — we need the row content (nick/text) to run
// the highlight engine, so a bare COUNT won't do. Same type allowlist as
// countNewer so the highlight scan and the unread count agree on what's
// countable.
export function listNewer(networkId, target, afterId, limit = 500) {
  const rows = db.prepare(
    `SELECT * FROM messages
     WHERE network_id = ? AND target = ? AND id > ?
       AND type IN ${COUNTABLE_TYPES_SQL}
     ORDER BY id ASC
     LIMIT ?`
  ).all(networkId, target, afterId || 0, limit);
  return rows.map(rowToEvent);
}

const listSpeakersStmt = db.prepare(`
  SELECT nick, MAX(time) AS last_time
  FROM messages
  WHERE network_id = ?
    AND target = ?
    AND type IN ('message', 'action')
    AND nick IS NOT NULL
    AND nick <> ''
  GROUP BY LOWER(nick)
  ORDER BY last_time DESC
  LIMIT ?
`);

export function listSpeakers(networkId, target, limit = 128) {
  return listSpeakersStmt.all(networkId, target, limit)
    .map((r) => ({ nick: r.nick, lastTime: Date.parse(r.last_time) || 0 }))
    .filter((s) => s.lastTime > 0);
}
