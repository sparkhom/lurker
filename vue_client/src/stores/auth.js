import { defineStore } from 'pinia';
import {
  startRegistration,
  startAuthentication,
} from '@simplewebauthn/browser';
import { api } from '../api.js';
import { resetSession } from '../composables/useSessionReset.js';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null,
    checked: false,
    error: null,
    setupStatus: null, // { needsSetup, mode?, username? }
  }),
  actions: {
    async fetchMe() {
      try {
        const { user } = await api('/api/auth/me');
        this.user = user;
      } catch (err) {
        this.user = null;
      } finally {
        this.checked = true;
      }
      return this.user;
    },
    async fetchSetupStatus() {
      try {
        this.setupStatus = await api('/api/auth/setup-status');
      } catch (err) {
        this.setupStatus = { needsSetup: false };
      }
      return this.setupStatus;
    },
    async fetchAuthMethods() {
      try {
        return await api('/api/auth/auth-methods');
      } catch (err) {
        return { passkey: false };
      }
    },
    async loginWithPasskey() {
      this.error = null;
      try {
        const { options } = await api('/api/auth/login/options', { method: 'POST' });
        const response = await startAuthentication({ optionsJSON: options });
        const { user } = await api('/api/auth/login/verify', {
          method: 'POST',
          body: { response },
        });
        this.user = user;
        this.checked = true;
        return user;
      } catch (err) {
        this.error = friendlyError(err, 'login failed');
        throw err;
      }
    },
    async setupFirstPasskey({ username } = {}) {
      this.error = null;
      try {
        const { options } = await api('/api/auth/setup/options', {
          method: 'POST',
          body: { username },
        });
        const response = await startRegistration({ optionsJSON: options });
        const { user } = await api('/api/auth/setup/verify', {
          method: 'POST',
          body: { response },
        });
        this.user = user;
        this.checked = true;
        this.setupStatus = { needsSetup: false };
        return user;
      } catch (err) {
        this.error = friendlyError(err, 'setup failed');
        throw err;
      }
    },
    async setupFirstPassword({ username, password } = {}) {
      this.error = null;
      try {
        const { user } = await api('/api/auth/setup/password', {
          method: 'POST',
          body: { username, password },
        });
        this.user = user;
        this.checked = true;
        this.setupStatus = { needsSetup: false };
        return user;
      } catch (err) {
        this.error = friendlyError(err, 'setup failed');
        throw err;
      }
    },
    async loginWithPassword({ username, password } = {}) {
      this.error = null;
      try {
        const { user } = await api('/api/auth/login/password', {
          method: 'POST',
          body: { username, password },
        });
        this.user = user;
        this.checked = true;
        return user;
      } catch (err) {
        this.error = friendlyError(err, 'login failed');
        throw err;
      }
    },
    async fetchInviteStatus(token) {
      // Public endpoint, never throws on a missing/expired token — returns
      // { valid: bool, expired?: bool } so the landing page can pick its copy.
      const data = await api(`/api/auth/invite/${encodeURIComponent(token)}`);
      return data;
    },
    async acceptInvite({ token, username, label } = {}) {
      this.error = null;
      try {
        const { options } = await api(
          `/api/auth/invite/${encodeURIComponent(token)}/options`,
          { method: 'POST', body: { username } }
        );
        const response = await startRegistration({ optionsJSON: options });
        const { user } = await api(
          `/api/auth/invite/${encodeURIComponent(token)}/verify`,
          { method: 'POST', body: { response, label } }
        );
        // If a prior user was logged into this browser, wipe their state
        // before the new session takes over. Clear `user` first so the WS
        // onclose reconnect arm sees no user (matches the logout pattern).
        this.user = null;
        resetSession();
        this.user = user;
        this.checked = true;
        return user;
      } catch (err) {
        this.error = friendlyError(err, 'invite redemption failed');
        throw err;
      }
    },
    async acceptInviteWithPassword({ token, username, password } = {}) {
      this.error = null;
      try {
        const { user } = await api(
          `/api/auth/invite/${encodeURIComponent(token)}/password`,
          { method: 'POST', body: { username, password } }
        );
        this.user = null;
        resetSession();
        this.user = user;
        this.checked = true;
        return user;
      } catch (err) {
        this.error = friendlyError(err, 'invite redemption failed');
        throw err;
      }
    },
    async addPasskey({ label } = {}) {
      const { options } = await api('/api/auth/passkeys/options', { method: 'POST' });
      const response = await startRegistration({ optionsJSON: options });
      const { passkey } = await api('/api/auth/passkeys/verify', {
        method: 'POST',
        body: { response, label },
      });
      return passkey;
    },
    async listPasskeys() {
      const { passkeys } = await api('/api/auth/passkeys');
      return passkeys;
    },
    async renamePasskey(id, label) {
      await api(`/api/auth/passkeys/${id}`, { method: 'PATCH', body: { label } });
    },
    async deletePasskey(id) {
      await api(`/api/auth/passkeys/${id}`, { method: 'DELETE' });
    },
    async fetchPasswordStatus() {
      try {
        const { hasPassword } = await api('/api/auth/password');
        return !!hasPassword;
      } catch (_) {
        return false;
      }
    },
    async setPassword({ password, currentPassword } = {}) {
      await api('/api/auth/password', {
        method: 'PUT',
        body: { password, currentPassword },
      });
    },
    async removePassword() {
      await api('/api/auth/password', { method: 'DELETE' });
    },
    async logout() {
      try {
        await api('/api/auth/logout', { method: 'POST' });
      } finally {
        // Clear user before resetSession so any late WS onclose handler
        // sees a null user and skips its 2s reconnect arm.
        this.user = null;
        resetSession();
      }
    },
  },
});

function friendlyError(err, fallback) {
  if (!err) return fallback;
  // Browser cancellation comes back as a DOMException; show something less
  // alarming than "NotAllowedError: ...".
  if (err.name === 'NotAllowedError') return 'cancelled';
  if (err.name === 'InvalidStateError') return 'this passkey is already registered';
  return err.message || fallback;
}
