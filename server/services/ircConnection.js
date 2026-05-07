import IRC from 'irc-framework';
import { insertMessage } from '../db/messages.js';

const PERSIST_TYPES = new Set(['message', 'action', 'notice', 'topic']);

export class IrcConnection {
  constructor({ network, onEvent }) {
    this.network = network;
    this.onEvent = onEvent;
    this.client = new IRC.Client();
    this.client.requestCap('message-tags');
    this.state = 'disconnected';
    this.channels = new Map();
    this.bind();
  }

  shouldPersist(event) {
    if (!event.target) return false;
    if (event.target.startsWith(':server:')) return false;
    return PERSIST_TYPES.has(event.type);
  }

  publish(event) {
    const time = event.time || new Date().toISOString();
    const enriched = {
      ...event,
      userId: this.network.user_id,
      networkId: this.network.id,
      time,
    };

    if (this.shouldPersist(event)) {
      const id = insertMessage({
        networkId: this.network.id,
        target: event.target,
        time,
        type: event.type,
        nick: event.nick,
        text: event.text,
        kind: event.kind,
        self: event.self,
      });
      enriched.id = id;
    }

    this.onEvent(enriched);
  }

  publishEphemeral(event) {
    this.onEvent({
      ...event,
      userId: this.network.user_id,
      networkId: this.network.id,
      time: event.time || new Date().toISOString(),
    });
  }

  setState(state, extra = {}) {
    this.state = state;
    this.publish({ type: 'state', state, ...extra });
  }

  bind() {
    const c = this.client;

    c.on('registered', () => this.setState('connected', { nick: c.user.nick }));
    c.on('close', () => this.setState('disconnected'));
    c.on('socket close', () => this.setState('disconnected'));
    c.on('reconnecting', () => this.setState('reconnecting'));
    c.on('connecting', () => this.setState('connecting'));

    c.on('motd', (event) => {
      this.publish({ type: 'motd', text: event.motd });
    });

    c.on('message', (event) => {
      const me = c.user?.nick;
      const isSelf = !!event.nick && event.nick === me;
      const isServer = !event.nick;
      const targetIsChannel = event.target && event.target.startsWith('#');

      let target;
      if (isServer) target = `:server:${this.network.id}`;
      else if (targetIsChannel) target = event.target;
      else if (isSelf) target = event.target;
      else target = event.nick;

      const type = event.type === 'action' ? 'action' : event.type === 'notice' ? 'notice' : 'message';
      const nick = event.nick || event.hostname || 'server';

      this.publish({
        type,
        target,
        nick,
        text: event.message,
        kind: event.type,
        self: isSelf,
      });
    });

    c.on('join', (event) => {
      const ch = this.upsertChannel(event.channel);
      ch.members.add(event.nick);
      this.publish({ type: 'join', target: event.channel, nick: event.nick });
      if (event.nick === c.user.nick) {
        this.publish({ type: 'channel-joined', target: event.channel });
      }
    });

    c.on('part', (event) => {
      const ch = this.channels.get(event.channel.toLowerCase());
      if (ch) ch.members.delete(event.nick);
      this.publish({ type: 'part', target: event.channel, nick: event.nick, text: event.message });
      if (event.nick === c.user.nick) {
        this.channels.delete(event.channel.toLowerCase());
        this.publish({ type: 'channel-parted', target: event.channel });
      }
    });

    c.on('kick', (event) => {
      const ch = this.channels.get(event.channel.toLowerCase());
      if (ch) ch.members.delete(event.kicked);
      this.publish({
        type: 'kick',
        target: event.channel,
        nick: event.nick,
        kicked: event.kicked,
        text: event.message,
      });
    });

    c.on('quit', (event) => {
      for (const [name, ch] of this.channels) {
        if (ch.members.delete(event.nick)) {
          this.publish({ type: 'quit', target: ch.name, nick: event.nick, text: event.message });
        }
      }
    });

    c.on('nick', (event) => {
      for (const ch of this.channels.values()) {
        if (ch.members.has(event.nick)) {
          ch.members.delete(event.nick);
          ch.members.add(event.new_nick);
          this.publish({ type: 'nick', target: ch.name, nick: event.nick, newNick: event.new_nick });
        }
      }
    });

    c.on('topic', (event) => {
      const ch = this.upsertChannel(event.channel);
      ch.topic = event.topic;
      this.publish({ type: 'topic', target: event.channel, nick: event.nick, text: event.topic });
    });

    c.on('userlist', (event) => {
      const ch = this.upsertChannel(event.channel);
      ch.members = new Set(event.users.map((u) => u.nick));
      this.publish({
        type: 'names',
        target: event.channel,
        members: event.users.map((u) => ({ nick: u.nick, modes: u.modes || [] })),
      });
    });

    c.on('irc error', (event) => {
      this.publish({ type: 'error', text: event.error || event.reason || 'IRC error', raw: event });
    });

    c.on('tagmsg', (event) => {
      const me = c.user?.nick;
      const isSelf = !!event.nick && event.nick === me;
      if (isSelf) return;
      const typing = event.tags && event.tags['+typing'];
      if (!typing) return;
      const targetIsChannel = event.target && event.target.startsWith('#');
      const target = targetIsChannel ? event.target : event.nick;
      this.publishEphemeral({
        type: 'typing',
        target,
        nick: event.nick,
        state: typing,
      });
    });
  }

  upsertChannel(name) {
    const key = name.toLowerCase();
    let ch = this.channels.get(key);
    if (!ch) {
      ch = { name, topic: null, members: new Set() };
      this.channels.set(key, ch);
    }
    return ch;
  }

  connect() {
    this.client.connect({
      host: this.network.host,
      port: this.network.port,
      tls: !!this.network.tls,
      nick: this.network.nick,
      username: this.network.username || this.network.nick,
      gecos: this.network.realname || this.network.nick,
      password: this.network.server_password || undefined,
      auto_reconnect: true,
      auto_reconnect_max_retries: 0,
    });
  }

  join(channel) { this.client.join(channel); }
  part(channel, reason) { this.client.part(channel, reason); }
  say(target, text) { this.client.say(target, text); }
  action(target, text) { this.client.action(target, text); }
  raw(line) { this.client.raw(line); }
  sendTyping(target, state) {
    this.client.tagmsg(target, { '+typing': state });
  }

  disconnect(reason = 'caint shutting down') {
    this.client.quit(reason);
  }

  snapshot() {
    return {
      networkId: this.network.id,
      state: this.state,
      nick: this.client.user?.nick || this.network.nick,
      channels: Array.from(this.channels.values()).map((ch) => ({
        name: ch.name,
        topic: ch.topic,
        members: Array.from(ch.members),
      })),
    };
  }
}
