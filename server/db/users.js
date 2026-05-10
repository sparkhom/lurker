import db from './index.js';

export function findUserByUsername(username) {
  return db.prepare('SELECT id, username, created_at FROM users WHERE username = ?').get(username);
}

export function findUserById(id) {
  return db.prepare('SELECT id, username, created_at FROM users WHERE id = ?').get(id);
}

export function listUsers() {
  return db.prepare('SELECT id, username, created_at FROM users ORDER BY id').all();
}

export function countUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

export function createUser(username) {
  const info = db.prepare('INSERT INTO users (username) VALUES (?)').run(username);
  return findUserById(info.lastInsertRowid);
}
