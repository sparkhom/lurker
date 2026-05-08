// Source of truth on the server for settings metadata.
// Mirror of vue_client/src/utils/settingsRegistry.js — keep entries in sync.
// Server validates writes against this; the client uses its mirror to render the UI.

export const REGISTRY = Object.freeze([
  {
    key: 'look.nick.colors',
    type: 'string-list',
    default: [
      '#5fafaf', '#5fafd7', '#87af5f', '#87afaf', '#87afd7', '#87d787',
      '#af87af', '#afd787', '#d75f5f', '#d78787', '#d787d7', '#d7af5f',
      '#d7afff', '#ff5f87', '#ff8700', '#ff8787', '#ffaf5f', '#ffd75f',
      '#5f87af', '#5f87d7', '#5fafff', '#87afff', '#87d7ff',
    ],
    description:
      "Palette of colors used to deterministically color other users' nicknames. " +
      'One entry per line; any CSS color value (hex, rgb(), var(--name)).',
  },
  {
    key: 'look.nick.self_color',
    type: 'color',
    default: 'var(--fg)',
    description:
      'Color used for your own nickname wherever it appears. ' +
      'Any CSS color value; defaults to your foreground color.',
  },
  {
    key: 'look.nick.color_stop_chars',
    type: 'string',
    default: '_|',
    description:
      'Trailing characters trimmed from nicknames before hashing for color selection, ' +
      "so 'amiantos__' colors the same as 'amiantos'.",
  },
  {
    key: 'look.nick.color_hash',
    type: 'enum',
    choices: ['djb2-32'],
    default: 'djb2-32',
    description: 'Hash algorithm used to map nicknames to palette colors.',
  },
  {
    key: 'look.action.italic',
    type: 'bool',
    default: true,
    description: 'Render /me action messages in italics.',
  },
  {
    key: 'look.timestamp.format',
    type: 'string',
    default: 'HH:mm',
    description:
      'Format for message timestamps. Tokens: YYYY MM DD HH mm ss. ' +
      "Empty string hides timestamps.",
  },
]);

const BY_KEY = new Map(REGISTRY.map((opt) => [opt.key, opt]));

export function getOption(key) {
  return BY_KEY.get(key) || null;
}

export function defaultsAsObject() {
  const out = {};
  for (const opt of REGISTRY) out[opt.key] = opt.default;
  return out;
}

export function validate(key, raw) {
  const opt = getOption(key);
  if (!opt) return { ok: false, error: `unknown setting: ${key}` };

  switch (opt.type) {
    case 'bool': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      return { ok: false, error: `${key} must be a boolean` };
    }
    case 'int': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isInteger(n)) return { ok: false, error: `${key} must be an integer` };
      if (typeof opt.min === 'number' && n < opt.min) return { ok: false, error: `${key} must be >= ${opt.min}` };
      if (typeof opt.max === 'number' && n > opt.max) return { ok: false, error: `${key} must be <= ${opt.max}` };
      return { ok: true, value: n };
    }
    case 'string':
    case 'color': {
      if (typeof raw !== 'string') return { ok: false, error: `${key} must be a string` };
      return { ok: true, value: raw };
    }
    case 'enum': {
      if (typeof raw !== 'string') return { ok: false, error: `${key} must be a string` };
      if (!opt.choices?.includes(raw)) {
        return { ok: false, error: `${key} must be one of: ${opt.choices?.join(', ')}` };
      }
      return { ok: true, value: raw };
    }
    case 'string-list': {
      if (!Array.isArray(raw)) return { ok: false, error: `${key} must be an array of strings` };
      if (!raw.every((s) => typeof s === 'string')) {
        return { ok: false, error: `${key} entries must all be strings` };
      }
      return { ok: true, value: raw };
    }
    default:
      return { ok: false, error: `unsupported type: ${opt.type}` };
  }
}
