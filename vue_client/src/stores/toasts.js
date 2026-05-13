import { defineStore } from 'pinia';

let nextId = 1;

export const useToastsStore = defineStore('toasts', {
  state: () => ({
    items: [],
  }),
  actions: {
    push({ title, body, networkId, target, messageId, kind = 'highlight', ttlMs = 5000 }) {
      const id = nextId++;
      this.items.push({ id, title, body, networkId, target, messageId, kind });
      if (ttlMs > 0) {
        setTimeout(() => this.dismiss(id), ttlMs);
      }
      return id;
    },
    dismiss(id) {
      const idx = this.items.findIndex((t) => t.id === id);
      if (idx >= 0) this.items.splice(idx, 1);
    },
    clear() {
      this.items = [];
    },
  },
});
