import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  listNetworksForUser,
  getNetwork,
  createNetwork,
  updateNetwork,
  deleteNetwork,
  listChannels,
  upsertChannel,
} from '../db/networks.js';
import ircManager from '../services/ircManager.js';

const router = Router();
router.use(requireAuth);

function networkPayload(network) {
  if (!network) return null;
  const { server_password, sasl_password, ...safe } = network;
  return {
    ...safe,
    tls: !!network.tls,
    autoconnect: !!network.autoconnect,
    has_password: !!server_password,
    has_sasl_password: !!sasl_password,
    channels: listChannels(network.id),
  };
}

router.get('/', (req, res) => {
  const networks = listNetworksForUser(req.user.id).map(networkPayload);
  res.json({ networks });
});

router.post('/', (req, res) => {
  const {
    name, host, port, tls, nick, username, realname, server_password,
    autoconnect, sasl_account, sasl_password, default_channel,
  } = req.body || {};
  if (!name || !host || !nick) return res.status(400).json({ error: 'name, host, and nick are required' });

  const network = createNetwork(req.user.id, {
    name, host, port, tls, nick, username, realname, server_password,
    autoconnect, sasl_account, sasl_password,
  });
  const channel = (default_channel || '').trim();
  if (channel) upsertChannel(network.id, channel, true);
  if (network.autoconnect) ircManager.startNetwork(req.user.id, network.id);
  res.status(201).json({ network: networkPayload(network) });
});

router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = getNetwork(id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'network not found' });
  const updated = updateNetwork(id, req.user.id, req.body || {});
  res.json({ network: networkPayload(updated) });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = getNetwork(id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'network not found' });
  ircManager.disposeNetwork(req.user.id, id, 'network removed');
  deleteNetwork(id, req.user.id);
  res.json({ ok: true });
});

router.post('/:id/connect', (req, res) => {
  const id = Number(req.params.id);
  const network = getNetwork(id, req.user.id);
  if (!network) return res.status(404).json({ error: 'network not found' });
  ircManager.startNetwork(req.user.id, id);
  res.json({ ok: true });
});

router.post('/:id/disconnect', (req, res) => {
  const id = Number(req.params.id);
  const network = getNetwork(id, req.user.id);
  if (!network) return res.status(404).json({ error: 'network not found' });
  ircManager.stopNetwork(req.user.id, id, req.body?.reason);
  res.json({ ok: true });
});

router.post('/:id/reconnect', (req, res) => {
  const id = Number(req.params.id);
  const network = getNetwork(id, req.user.id);
  if (!network) return res.status(404).json({ error: 'network not found' });
  ircManager.restartNetwork(req.user.id, id);
  res.json({ ok: true });
});

router.post('/:id/join', (req, res) => {
  const id = Number(req.params.id);
  const { channel } = req.body || {};
  if (!channel) return res.status(400).json({ error: 'channel required' });
  if (!ircManager.joinChannel(req.user.id, id, channel)) {
    return res.status(409).json({ error: 'network not connected' });
  }
  res.json({ ok: true });
});

router.post('/:id/part', (req, res) => {
  const id = Number(req.params.id);
  const { channel, reason } = req.body || {};
  if (!channel) return res.status(400).json({ error: 'channel required' });
  if (!ircManager.partChannel(req.user.id, id, channel, reason)) {
    return res.status(409).json({ error: 'network not connected' });
  }
  res.json({ ok: true });
});

export default router;
