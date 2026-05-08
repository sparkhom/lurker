// Mirror of server/services/settingsRegistry.js — keep entries in sync.
// The server validates writes against its copy; this file drives the UI and
// supplies defaults during initial paint (before /api/settings/bootstrap returns).

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
      'Empty string hides timestamps.',
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

export function getDefault(key) {
  const opt = BY_KEY.get(key);
  return opt ? opt.default : undefined;
}
