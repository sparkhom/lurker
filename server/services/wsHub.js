import { WebSocketServer } from 'ws';
import cookie from 'cookie';
import cookieParser from 'cookie-parser';
import ircManager from './ircManager.js';
import { findSession } from '../db/sessions.js';
import { findUserById } from '../db/users.js';
import { SESSION_COOKIE } from '../middleware/auth.js';

export function attachWsHub(httpServer, sessionSecret) {
  const wss = new WebSocketServer({ noServer: true });
  const socketsByUser = new Map();

  function addSocket(userId, ws) {
    let set = socketsByUser.get(userId);
    if (!set) {
      set = new Set();
      socketsByUser.set(userId, set);
    }
    set.add(ws);
  }

  function removeSocket(userId, ws) {
    const set = socketsByUser.get(userId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) socketsByUser.delete(userId);
  }

  function send(ws, payload) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  }

  function fanOut(userId, payload) {
    const set = socketsByUser.get(userId);
    if (!set) return;
    const json = JSON.stringify(payload);
    for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(json);
  }

  ircManager.on('event', (event) => {
    fanOut(event.userId, { ...event, kind: 'irc' });
  });

  function authenticateRequest(req) {
    const header = req.headers.cookie;
    if (!header) return null;
    const cookies = cookie.parse(header);
    const raw = cookies[SESSION_COOKIE];
    if (!raw) return null;
    const token = raw.startsWith('s:') ? cookieParser.signedCookie(raw, sessionSecret) : false;
    if (!token) return null;
    const session = findSession(token);
    if (!session) return null;
    return findUserById(session.user_id);
  }

  httpServer.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith('/ws')) return;
    const user = authenticateRequest(req);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.userId = user.id;
      addSocket(user.id, ws);
      onConnection(ws, user);
    });
  });

  function onConnection(ws, user) {
    sendSnapshot(ws, user.id);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        send(ws, { kind: 'error', text: 'invalid json' });
        return;
      }
      handleClientMessage(ws, user, msg);
    });

    ws.on('close', () => removeSocket(user.id, ws));
    ws.on('error', () => removeSocket(user.id, ws));
  }

  function sendSnapshot(ws, userId) {
    const networks = ircManager.snapshotForUser(userId);
    send(ws, { kind: 'snapshot', networks });
    for (const conn of ircManager.listConnections(userId)) {
      for (const ch of conn.channels.values()) {
        const events = conn.getBacklog(ch.name);
        if (events.length) {
          send(ws, {
            kind: 'backlog',
            networkId: conn.network.id,
            target: ch.name,
            events,
          });
        }
      }
    }
  }

  function handleClientMessage(ws, user, msg) {
    const userId = user.id;
    switch (msg.type) {
      case 'send':
        ircManager.send(userId, msg.networkId, msg.target, msg.text);
        break;
      case 'action':
        ircManager.action(userId, msg.networkId, msg.target, msg.text);
        break;
      case 'join':
        ircManager.joinChannel(userId, msg.networkId, msg.channel);
        break;
      case 'part':
        ircManager.partChannel(userId, msg.networkId, msg.channel, msg.reason);
        break;
      case 'snapshot':
        sendSnapshot(ws, userId);
        break;
      case 'raw':
        ircManager.getConnection(userId, msg.networkId)?.raw(msg.line);
        break;
      case 'typing':
        ircManager.typing(userId, msg.networkId, msg.target, msg.state);
        break;
      default:
        send(ws, { kind: 'error', text: `unknown message type: ${msg.type}` });
    }
  }

  return wss;
}
