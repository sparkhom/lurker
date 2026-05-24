// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { ContextMenuItem } from './useContextMenu.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useNickNotesStore } from '../stores/nickNotes.js';
import { useWhoisStore } from '../stores/whois.js';
import { useContextMenu } from './useContextMenu.js';

export interface MemberLike {
  nick: string;
  modes?: string[];
  away?: boolean;
}

export interface MemberContext {
  networkId: number;
  isSelf(member: MemberLike | string): boolean;
  onIgnore(member: MemberLike | string): void;
}

export interface MemberActionsAPI {
  buildItems(
    member: MemberLike | string | null | undefined,
    ctx: MemberContext | null | undefined,
  ): ContextMenuItem[];
  openMenuFor(
    member: MemberLike | string | null | undefined,
    ctx: MemberContext | null | undefined,
    x: number,
    y: number,
  ): void;
  openMenuFromButton(
    member: MemberLike | string | null | undefined,
    ctx: MemberContext | null | undefined,
    buttonEl: Element | null,
  ): void;
}

function nickOf(m: MemberLike | string): string {
  return typeof m === 'string' ? m : m.nick;
}

// Shared menu items for a member of a channel. Exposed as a composable so
// right-click, row-tap (mobile), and the hover three-dots (desktop) all
// surface the same actions. The caller owns side-effect state that needs
// component-local UI (like the ignore modal) and passes those callbacks in.
//
// `member` is the raw member object (or string) from buffer.members.
// `context` shape:
//   { networkId, isSelf(member), onIgnore(member) }
export function useMemberActions(): MemberActionsAPI {
  const buffers = useBuffersStore();
  const nickNotes = useNickNotesStore();
  const whois = useWhoisStore();
  const menu = useContextMenu();

  function buildItems(
    member: MemberLike | string | null | undefined,
    ctx: MemberContext | null | undefined,
  ): ContextMenuItem[] {
    if (!member || !ctx || ctx.isSelf(member)) return [];
    const nick = nickOf(member);
    const hasNote = nickNotes.hasNote(ctx.networkId, nick);
    const items: ContextMenuItem[] = [
      {
        label: 'View profile…',
        icon: 'fa-solid fa-id-card',
        onClick: () => whois.openViewer(ctx.networkId, nick),
      },
      {
        label: 'Send DM',
        icon: 'fa-solid fa-envelope',
        onClick: () => buffers.activate(ctx.networkId, nick),
      },
      {
        label: hasNote ? 'Edit note…' : 'Add note…',
        icon: 'fa-solid fa-note-sticky',
        onClick: () => nickNotes.openEditor(ctx.networkId, nick),
      },
      {
        label: 'Ignore…',
        icon: 'fa-solid fa-ban',
        onClick: () => ctx.onIgnore(member),
      },
    ];
    return items;
  }

  function openMenuFor(
    member: MemberLike | string | null | undefined,
    ctx: MemberContext | null | undefined,
    x: number,
    y: number,
  ): void {
    const items = buildItems(member, ctx);
    if (items.length === 0) return;
    menu.open(items, x, y);
  }

  // Hand buttonEl to useContextMenu so re-clicking the same trigger toggles
  // the menu closed instead of letting the click-outside listener close and
  // the trigger's own handler reopen on the same gesture.
  function openMenuFromButton(
    member: MemberLike | string | null | undefined,
    ctx: MemberContext | null | undefined,
    buttonEl: Element | null,
  ): void {
    if (!buttonEl) return;
    const items = buildItems(member, ctx);
    if (items.length === 0) return;
    const rect = buttonEl.getBoundingClientRect();
    menu.open(items, rect.left, rect.bottom + 2, buttonEl);
  }

  return { buildItems, openMenuFor, openMenuFromButton };
}
