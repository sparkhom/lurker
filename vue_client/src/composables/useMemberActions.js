// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import { useBuffersStore } from '../stores/buffers.js';
import { useContextMenu } from './useContextMenu.js';

// Shared menu items for a member of a channel. Exposed as a composable so
// right-click, row-tap (mobile), and the hover three-dots (desktop) all
// surface the same actions. The caller owns side-effect state that needs
// component-local UI (like the ignore modal) and passes those callbacks in.
//
// `member` is the raw member object (or string) from buffer.members.
// `context` shape:
//   { networkId, isSelf(member), onIgnore(member) }
export function useMemberActions() {
  const buffers = useBuffersStore();
  const menu = useContextMenu();

  function nickOf(m) { return typeof m === 'string' ? m : m.nick; }

  function buildItems(member, ctx) {
    if (!member || !ctx || ctx.isSelf(member)) return [];
    const nick = nickOf(member);
    const items = [
      {
        label: 'Send DM',
        icon: 'fa-solid fa-envelope',
        onClick: () => buffers.activate(ctx.networkId, nick),
      },
      {
        label: 'Ignore…',
        icon: 'fa-solid fa-ban',
        onClick: () => ctx.onIgnore(member),
      },
    ];
    return items;
  }

  function openMenuFor(member, ctx, x, y) {
    const items = buildItems(member, ctx);
    if (items.length === 0) return;
    menu.open(items, x, y);
  }

  // Hand buttonEl to useContextMenu so re-clicking the same trigger toggles
  // the menu closed instead of letting the click-outside listener close and
  // the trigger's own handler reopen on the same gesture.
  function openMenuFromButton(member, ctx, buttonEl) {
    if (!buttonEl) return;
    const items = buildItems(member, ctx);
    if (items.length === 0) return;
    const rect = buttonEl.getBoundingClientRect();
    menu.open(items, rect.left, rect.bottom + 2, buttonEl);
  }

  return { buildItems, openMenuFor, openMenuFromButton };
}
