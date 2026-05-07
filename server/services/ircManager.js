import { EventEmitter } from 'events';
import { IrcConnection } from './ircConnection.js';
import { listNetworksForUser, getNetwork, listChannels, upsertChannel, deleteChannel } from '../db/networks.js';
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
      const remembered = listChannels(networkId).filter((c) => c.joined);
      for (const c of remembered) conn.join(c.name);
    });

    return conn;
  }

  stopNetwork(userId, networkId, reason) {
    const conn = this.getConnection(userId, networkId);
    if (!conn) return;
    conn.disconnect(reason);
    this._userMap(userId).delete(networkId);
  }

  joinChannel(userId, networkId, name) {
    const conn = this.getConnection(userId, networkId);
    if (!conn) return false;
    upsertChannel(networkId, name, true);
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
