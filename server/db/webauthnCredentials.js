import db from './index.js';

function rowToCred(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    credentialId: row.credential_id,
    publicKey: row.public_key,
    counter: row.counter,
    transports: row.transports ? JSON.parse(row.transports) : [],
    deviceType: row.device_type || null,
    backedUp: !!row.backed_up,
    label: row.label || null,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export function listForUser(userId) {
  return db
    .prepare('SELECT * FROM webauthn_credentials WHERE user_id = ? ORDER BY id')
    .all(userId)
    .map(rowToCred);
}

export function findByCredentialId(credentialId) {
  return rowToCred(
    db.prepare('SELECT * FROM webauthn_credentials WHERE credential_id = ?').get(credentialId)
  );
}

export function countAll() {
  return db.prepare('SELECT COUNT(*) AS n FROM webauthn_credentials').get().n;
}

export function countForUser(userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ?').get(userId).n;
}

export function insertCredential({
  userId,
  credentialId,
  publicKey,
  counter,
  transports,
  deviceType,
  backedUp,
  label,
}) {
  const stmt = db.prepare(`
    INSERT INTO webauthn_credentials
      (user_id, credential_id, public_key, counter, transports, device_type, backed_up, label)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    userId,
    credentialId,
    publicKey,
    counter || 0,
    transports ? JSON.stringify(transports) : null,
    deviceType || null,
    backedUp ? 1 : 0,
    label || null,
  );
  return rowToCred(
    db.prepare('SELECT * FROM webauthn_credentials WHERE id = ?').get(info.lastInsertRowid)
  );
}

export function updateCounter(id, counter) {
  db.prepare(`
    UPDATE webauthn_credentials
    SET counter = ?, last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(counter, id);
}

export function updateLabel(id, userId, label) {
  const result = db
    .prepare('UPDATE webauthn_credentials SET label = ? WHERE id = ? AND user_id = ?')
    .run(label || null, id, userId);
  return result.changes > 0;
}

export function deleteById(id, userId) {
  const result = db
    .prepare('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?')
    .run(id, userId);
  return result.changes > 0;
}
