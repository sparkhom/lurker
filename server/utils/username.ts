// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The single source of truth for what a valid account username is. Shared by
// the human signup/auth flows (routes/auth.ts) and the orchestrator's node
// provisioning API (routes/node.ts) so an account created by either path is
// valid everywhere it surfaces — the UI, IRC registration, etc. The charset is
// deliberately conservative (no control characters, no exotic Unicode).

export const MAX_USERNAME_LENGTH = 64;

export function isValidUsername(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_USERNAME_LENGTH) return false;
  return /^[A-Za-z0-9_.\- ]+$/.test(trimmed);
}
