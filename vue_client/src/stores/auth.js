import { defineStore } from 'pinia';
import {
  startRegistration,
  startAuthentication,
} from '@simplewebauthn/browser';
import { api } from '../api.js';

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
    async setupFirstPasskey({ username, label } = {}) {
      this.error = null;
      try {
        const { options } = await api('/api/auth/setup/options', {
          method: 'POST',
          body: { username },
        });
        const response = await startRegistration({ optionsJSON: options });
        const { user } = await api('/api/auth/setup/verify', {
          method: 'POST',
          body: { response, label },
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
    async logout() {
      try {
        await api('/api/auth/logout', { method: 'POST' });
      } finally {
        this.user = null;
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
