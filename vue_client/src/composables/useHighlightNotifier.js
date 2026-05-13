// Drives in-client highlight notifications: a toast in the corner and an
// optional sound. Called from useSocket whenever an IRC message arrives with
// matched=true and self=false. Settings + buffer focus are read live so the
// user can flip the speaker quick-toggle and see it take effect immediately.

import { useToastsStore } from '../stores/toasts.js';
import { useSettingsStore } from '../stores/settings.js';
import { useNetworksStore } from '../stores/networks.js';

const audioCache = new Map();

function getAudio(choice) {
  let el = audioCache.get(choice);
  if (!el) {
    el = new Audio(`/sounds/${choice}.mp3`);
    el.preload = 'auto';
    audioCache.set(choice, el);
  }
  return el;
}

export function notifyHighlight(event) {
  if (!event || event.self) return;
  if (!event.matched) return;

  const settings = useSettingsStore();
  const networks = useNetworksStore();
  const toasts = useToastsStore();

  if (settings.effective('notifications.highlight.toast.enabled')) {
    const netName = networks.networkById(event.networkId)?.name || `net:${event.networkId}`;
    const where = event.target && !event.target.startsWith(':server:')
      ? `${netName} · ${event.target}`
      : netName;
    toasts.push({
      kind: 'highlight',
      title: `${event.nick || '?'} in ${where}`,
      body: event.text || '',
      networkId: event.networkId,
      target: event.target,
      messageId: event.id,
    });
  }

  if (settings.effective('notifications.highlight.sound.enabled')) {
    playHighlightSound();
  }
}

export function playHighlightSound() {
  const settings = useSettingsStore();
  const choice = settings.effective('notifications.highlight.sound.choice') || 'ping';
  const volume = settings.effective('notifications.highlight.sound.volume');
  const el = getAudio(choice);
  el.volume = Math.max(0, Math.min(1, (Number(volume) || 0) / 100));
  // Rewind so rapid-fire highlights each get a full play, and swallow the
  // autoplay-policy rejection that fires before any user gesture on the page.
  try { el.currentTime = 0; } catch (_) { /* ignore */ }
  const p = el.play();
  if (p && typeof p.catch === 'function') p.catch(() => { /* autoplay blocked */ });
}
