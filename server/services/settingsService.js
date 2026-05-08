import { EventEmitter } from 'events';
import { validate, getOption } from './settingsRegistry.js';
import {
  setUserSetting,
  deleteUserSetting,
  deleteAllUserSettings,
  getUserSettings,
} from '../db/settings.js';

class SettingsService extends EventEmitter {
  // changes: { [key]: rawValue }
  // Returns { ok: true, values } on full success or { ok: false, error, key } on first invalid entry.
  update(userId, changes) {
    const validated = {};
    for (const [key, raw] of Object.entries(changes)) {
      const result = validate(key, raw);
      if (!result.ok) return { ok: false, error: result.error, key };
      validated[key] = result.value;
    }
    for (const [key, value] of Object.entries(validated)) {
      setUserSetting(userId, key, value);
    }
    if (Object.keys(validated).length > 0) {
      this.emit('event', { userId, changes: validated });
    }
    return { ok: true, values: getUserSettings(userId) };
  }

  reset(userId, key) {
    const opt = getOption(key);
    if (!opt) return { ok: false, error: `unknown setting: ${key}` };
    deleteUserSetting(userId, key);
    this.emit('event', { userId, changes: { [key]: opt.default } });
    return { ok: true, values: getUserSettings(userId) };
  }

  resetAll(userId) {
    deleteAllUserSettings(userId);
    // Best-effort broadcast: tell clients to reload defaults for any key that was set.
    // Simplest signal: emit a special "reset-all" so clients can clear their overrides map.
    this.emit('event', { userId, resetAll: true });
    return { ok: true, values: {} };
  }
}

const settingsService = new SettingsService();
export default settingsService;
