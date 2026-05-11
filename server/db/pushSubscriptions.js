import db from './index.js';

function rowToSub(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    user_agent: row.user_agent,
    enabled: !!row.enabled,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
  };
}

export function listEnabledForUser(userId) {
  return db
    .prepare('SELECT * FROM push_subscriptions WHERE user_id = ? AND enabled = 1')
    .all(userId)
    .map(rowToSub);
}

export function listAllForUser(userId) {
  return db
    .prepare('SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY id')
    .all(userId)
    .map(rowToSub);
}

export function getByEndpoint(endpoint) {
  return rowToSub(db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(endpoint));
}

// Push endpoint URLs persist per browser/PushManager — when two users log
// into the same browser, the same endpoint comes back from subscribe(). A
// blind UPDATE would silently rebind it to whichever user enabled most
// recently, stealing the other user's notifications. Refuse instead; the
// previous owner must disable push on their session before a new user can
// claim it. Returns { ok, sub? } on success or { ok: false, error } on a
// cross-user collision.
export function upsertSubscription(userId, { endpoint, p256dh, auth, userAgent }) {
  const existing = getByEndpoint(endpoint);
  if (existing && existing.user_id !== userId) {
    return { ok: false, error: 'endpoint_owned_by_other_user' };
  }
  if (existing) {
    db.prepare(`
      UPDATE push_subscriptions
      SET p256dh = ?, auth = ?, user_agent = COALESCE(?, user_agent),
          enabled = 1, last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE endpoint = ?
    `).run(p256dh, auth, userAgent || null, endpoint);
    return { ok: true, sub: getByEndpoint(endpoint) };
  }
  db.prepare(`
    INSERT INTO push_subscriptions
      (user_id, endpoint, p256dh, auth, user_agent, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `).run(userId, endpoint, p256dh, auth, userAgent || null);
  return { ok: true, sub: getByEndpoint(endpoint) };
}

// Touch last_seen_at if the endpoint exists; no-op otherwise. Used by the
// client on page load to reflect actual activity rather than the moment of
// last push delivery (which only fires when no client is visible — the
// opposite of "active"). Returns whether a row was updated.
export function heartbeatByEndpoint(userId, endpoint) {
  const result = db.prepare(`
    UPDATE push_subscriptions
    SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE user_id = ? AND endpoint = ?
  `).run(userId, endpoint);
  return result.changes > 0;
}

export function deleteByEndpoint(userId, endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
}

export function deleteById(id, userId) {
  db.prepare('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?').run(id, userId);
}

export function touchSubscription(id) {
  // strftime with Z suffix so the value parses back as UTC on the client.
  // SQLite's bare datetime('now') returns 'YYYY-MM-DD HH:MM:SS' with no TZ
  // marker, which Date.parse() then treats as local time.
  db.prepare("UPDATE push_subscriptions SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(id);
}

// app_meta single-key store for VAPID config
export function getMeta(key) {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key);
  return row?.value ?? null;
}

export function setMeta(key, value) {
  db.prepare(`
    INSERT INTO app_meta (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}
