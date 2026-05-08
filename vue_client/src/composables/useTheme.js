import { watchEffect } from 'vue';
import { useSettingsStore } from '../stores/settings.js';

// Maps each settings key to the CSS custom property it controls. Anything in
// here is live-rewritten on :root whenever the settings store changes, so the
// whole UI re-themes immediately when the user edits a key in Settings.
const COLOR_VARS = {
  'look.color.bg':            '--bg',
  'look.color.bg_soft':       '--bg-soft',
  'look.color.fg':            '--fg',
  'look.color.fg_muted':      '--fg-muted',
  'look.color.accent':        '--accent',
  'look.color.good':          '--good',
  'look.color.warn':          '--warn',
  'look.color.bad':           '--bad',
  'look.color.border':        '--border',
  'look.color.message.alt_bg': '--alt-bg',
  'look.color.message.alt_fg': '--alt-fg',
  'look.color.member.owner':  '--member-owner',
  'look.color.member.admin':  '--member-admin',
  'look.color.member.op':     '--member-op',
  'look.color.member.halfop': '--member-halfop',
  'look.color.member.voice':  '--member-voice',
};

let installed = false;

export function useTheme() {
  if (installed) return;
  installed = true;
  const settings = useSettingsStore();
  const root = document.documentElement;

  watchEffect(() => {
    for (const [key, cssVar] of Object.entries(COLOR_VARS)) {
      root.style.setProperty(cssVar, String(settings.effective(key)));
    }
    root.style.setProperty('--mono', String(settings.effective('look.font.family')));
    root.style.setProperty('--font-size', `${settings.effective('look.font.size')}px`);
    root.style.setProperty('--font-weight', String(settings.effective('look.font.weight')));
  });
}
