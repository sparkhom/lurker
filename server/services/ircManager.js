import { EventEmitter } from 'events';
import { IrcConnection } from './ircConnection.js';
import { listNetworksForUser, getNetwork, listChannels, upsertChannel, deleteChannel } from '../db/networks.js';
import { reopenBuffer } from '../db/closedBuffers.js';
import db from '../db/index.js';

class IrcManager extends EventEmitter {
  constructor() {
    super();
    this.byUser = new Map();
  }

  _userMap(userId) {
    let m = this.byUser.get(userId);
    if (!m) {
      m = new Map();
      this.byUser.set(userId, m);
    }
    return m;
  }

  getConnection(userId, networkId) {
    return this.byUser.get(userId)?.get(networkId) || null;
  }

  listConnections(userId) {
    return Array.from(this._userMap(userId).values());
  }

  initForUser(userId) {
    for (const network of listNetworksForUser(userId)) {
      if (network.autoconnect) this.startNetwork(userId, network.id);
    }
  }

  initAll() {
    const userIds = db.prepare('SELECT DISTINCT user_id AS id FROM networks').all().map((r) => r.id);
    for (const id of userIds) this.initForUser(id);
  }

  startNetwork(userId, networkId) {
    const network = getNetwork(networkId, userId);
    if (!network) return null;
    let conn = this.getConnection(userId, networkId);
    if (conn) return conn;

    conn = new IrcConnection({
      network,
      onEvent: (event) => this.emit('event', event),
    });
    this._userMap(userId).set(networkId, conn);
    conn.connect();

    conn.client.on('registered', () => {
      const names = listChannels(networkId).filter((c) => c.joined).map((c) => c.name);
      // Send JOINs as comma-separated batches per IRC line. A tight loop of
      // single JOINs trips Libera's per-connection flood limit ("Closing Link:
      // ... (Excess Flood)"), so we coalesce into one line and chunk well under
      // the 512-byte IRC line cap.
      const MAX = 400;
      let chunk = [];
      let len = 0;
      for (const name of names) {
        const add = chunk.length === 0 ? name.length : name.length + 1;
        if (len + add > MAX && chunk.length > 0) {
          conn.join(chunk.join(','));
          chunk = [];
          len = 0;
        }
        chunk.push(name);
        len += add;
      }
      if (chunk.length > 0) conn.join(chunk.join(','));
    });

    return conn;
  }

  stopNetwork(userId, networkId, reason) {
    const conn = this.getConnection(userId, networkId);
    if (!conn) return;
    conn.disconnect(reason);
    this._userMap(userId).delete(networkId);
  }

  disposeNetwork(userId, networkId, reason) {
    const conn = this.getConnection(userId, networkId);
    if (!conn) return;
    conn.dispose(reason);
    this._userMap(userId).delete(networkId);
  }

  // Force a fresh connection: dispose the existing IrcConnection (if any) and
  // start a new one against the latest DB row. Use this both for the user's
  // explicit "reconnect" action and after editing connection-relevant fields,
  // since startNetwork is a no-op when a connection object already exists in
  // the map (even if it's in a disconnected state).
  restartNetwork(userId, networkId, reason = 'reconnecting') {
    this.disposeNetwork(userId, networkId, reason);
    return this.startNetwork(userId, networkId);
  }

  joinChannel(userId, networkId, name) {
    const conn = this.getConnection(userId, networkId);
    if (!conn) return false;
    upsertChannel(networkId, name, true);
    // Joining is an explicit "I want this buffer back" — clear any stale
    // closed flag from a prior close. The matching channel-joined event will
    // recreate the buffer in clients via the normal flow.
    reopenBuffer(userId, networkId, name);
    conn.join(name);
    return true;
  }

  partChannel(userId, networkId, name, reason) {
    const conn = this.getConnection(userId, networkId);
    if (!conn) return false;
    upsertChannel(networkId, name, false);
    conn.part(name, reason);
    return true;
  }

  forgetChannel(userId, networkId, name) {
    deleteChannel(networkId, name);
  }

  send(userId, networkId, target, text) {
    const conn = this.getConnection(userId, networkId);
    if (!conn) return false;
    conn.say(target, text);
    conn.publish({
      type: 'message',
      target,
      nick: conn.client.user?.nick,
      text,
      kind: 'privmsg',
      self: true,
    });
    return true;
  }

  action(userId, networkId, target, text) {
    const conn = this.getConnection(userId, networkId);
    if (!conn) return false;
    conn.action(target, text);
    conn.publish({
      type: 'action',
      target,
      nick: conn.client.user?.nick,
      text,
      self: true,
    });
    return true;
  }

  typing(userId, networkId, target, state) {
    const conn = this.getConnection(userId, networkId);
    if (!conn) return false;
    if (!target || target.startsWith(':server:')) return false;
    if (!['active', 'paused', 'done'].includes(state)) return false;
    conn.sendTyping(target, state);
    return true;
  }

  // Set AWAY across every connected network for this user. Returns the count
  // of connections actually flipped (so the caller can decide whether to
  // surface a "no networks" error).
  setAwayAll(userId, message, { autoSet = false } = {}) {
    let n = 0;
    for (const conn of this.listConnections(userId)) {
      if (conn.setAway({ message, autoSet })) n += 1;
    }
    return n;
  }

  clearAwayAll(userId, { autoSet = false } = {}) {
    let n = 0;
    for (const conn of this.listConnections(userId)) {
      if (conn.clearAway({ autoSet })) n += 1;
    }
    return n;
  }

  shutdown() {
    for (const userMap of this.byUser.values()) {
      for (const conn of userMap.values()) {
        try { conn.disconnect(); } catch (_) { /* ignore */ }
      }
    }
    this.byUser.clear();
  }

  snapshotForUser(userId) {
    return this.listConnections(userId).map((conn) => conn.snapshot());
  }
}

const ircManager = new IrcManager();
export default ircManager;
